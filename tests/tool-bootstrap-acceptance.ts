import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CliAcquisitionReader } from '../src/acquisition-readers.js';
import type { TaskContext } from '../src/types.js';
import { currentToolVersion } from '../src/task/protocol.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface SavedTask { context: TaskContext; value: unknown }
interface Worker { child: ChildProcess; origin: string; logs: () => string; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

async function freePort() {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}
async function bounded<T>(promise: Promise<T>, message: string, milliseconds = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function bootstrapEnvironment(directory: string, port: number, readersFile: string, catalogFile: string) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:SQUAD_|WEB_)|(?:^|_)MODEL(?:_|$)/.test(key)) delete env[key];
  delete env.NODE_OPTIONS;
  return { ...env, WEB_PORT: String(port), WEB_DATABASE: join(directory, 'team.sqlite'),
    SQUAD_LOCAL_DATA_DIR: join(directory, 'runtime'), SQUAD_LOCAL_TOOLS_ENABLED: 'false',
    SQUAD_WEB_TOOLS_ENABLED: 'false', SQUAD_DEBUG: 'true',
    SQUAD_ACQUISITION_READERS_FILE: readersFile, SQUAD_CLI_CATALOG_FILE: catalogFile };
}
async function startWorker(directory: string, readersFile: string, catalogFile: string): Promise<Worker> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', join(repository, 'node_modules/tsx/dist/loader.mjs'), join(repository, 'scripts/web.ts')], {
    cwd: directory, env: bootstrapEnvironment(directory, port, readersFile, catalogFile), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const capture = (data: Buffer) => { logs = (logs + data.toString()).slice(-256_000); };
  child.stdout!.on('data', capture); child.stderr!.on('data', capture);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, origin: `http://127.0.0.1:${port}`, logs: () => logs, exit };
}
async function healthy(worker: Worker) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assert.equal(worker.child.exitCode, null, 'scripts/web.ts exited before becoming healthy');
    try {
      const response = await fetch(`${worker.origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && (await response.json() as { healthy: boolean }).healthy) return;
    } catch { /* Startup has not bound its local port yet. */ }
    await pause(20);
  }
  throw Error('scripts/web.ts did not expose a healthy local HTTP service');
}
async function request<T>(worker: Worker, path: string, body?: unknown): Promise<T> {
  const response = await fetch(worker.origin + path, { signal: AbortSignal.timeout(2000),
    ...(body === undefined ? {} : { method: 'POST', headers: { origin: worker.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await response.text();
  assert(response.ok, `Public HTTP request ${path} failed with ${response.status}`);
  return JSON.parse(text) as T;
}
async function taskSnapshot(worker: Worker, roomId: string, taskId: string): Promise<SavedTask> {
  const feed = await request<{ current: { taskId: string; snapshot: SavedTask } }>(worker,
    `/api/debug/rooms/${roomId}?task=${encodeURIComponent(taskId)}`);
  assert.equal(feed.current.taskId, taskId); return feed.current.snapshot;
}
function sqliteTask(directory: string, roomId: string, taskId: string): SavedTask {
  const database = new DatabaseSync(join(directory, 'team.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT data FROM rooms WHERE id=?').get(roomId) as { data: string };
    return (JSON.parse(row.data) as { tasks: Record<string, { snapshot: SavedTask }> }).tasks[taskId]!.snapshot;
  } finally { database.close(); }
}
async function stopWorker(worker: Worker, directory: string) {
  assert(worker.child.kill('SIGTERM'));
  const result = await bounded(worker.exit, 'scripts/web.ts did not exit after SIGTERM');
  assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.equal(existsSync(join(directory, 'runtime/service.lock')), false, 'Graceful shutdown must release the cleanup runtime service lock');
}
function reader(version: string): CliAcquisitionReader {
  return { id: 'bootstrap-reader', version, command: 'document-reader', argsPrefix: ['document'], format: 'json-document',
    resource: { kind: 'document-argument', index: 1, service: 'yuque', namespace: 'team/book' } };
}
// This explicitly ordered fixture is the canonical public configuration contract, independent of input key order.
function expectedToolVersion(version: string) {
  const canonical = { acquisitionReaders: [{ argsPrefix: ['document'], command: 'document-reader', format: 'json-document',
    id: 'bootstrap-reader', resource: { index: 1, kind: 'document-argument', namespace: 'team/book', service: 'yuque' }, version }],
    acquisitionReadersConfigured: true };
  return `${currentToolVersion}:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}
async function submitTask(worker: Worker, title: string) {
  const room = await request<{ id: string }>(worker, '/api/rooms', { title });
  const reply = await request<{ ok: boolean; taskId: string }>(worker, `/api/rooms/${room.id}/messages`,
    { id: 'bootstrap-task', text: '请基于已有上下文比较方案，需要更多条件时等待我的明确回复。' });
  assert(reply.ok && reply.taskId); return { roomId: room.id, taskId: reply.taskId };
}

/** Real scripts/web.ts subprocess, admin JSON, HTTP and SQLite; no external model/CLI/source service. */
export async function verifyToolBootstrapAcceptance() {
  const directory = mkdtempSync(join(tmpdir(), 'squad-tool-bootstrap-'));
  const readersFile = join(directory, 'readers.json'), catalogFile = join(directory, 'catalog.json');
  const workers: Worker[] = [];
  writeFileSync(catalogFile, JSON.stringify([{ execution: 'sandbox', domains: ['docs.example.com'], description: '读取专用文档服务', command: 'document-reader' }]));
  assert.equal(existsSync(join(directory, '.env')), false, 'Child cwd must not load the repository model .env');
  try {
    writeFileSync(readersFile, JSON.stringify([reader('1')]));
    const first = await startWorker(directory, readersFile, catalogFile); workers.push(first); await healthy(first);
    assert(existsSync(join(directory, 'runtime/service.lock')), 'Local tools disabled still needs a cleanup runtime owner');
    assert(first.logs().includes('CLI sandbox: unavailable'));
    assert.equal((await request<{ enabled: boolean }>(first, '/api/debug')).enabled, true);
    const original = await submitTask(first, '原配置任务');
    const initial = await taskSnapshot(first, original.roomId, original.taskId);
    assert.equal(initial.context.config.toolVersion, expectedToolVersion('1'));
    assert.equal(initial.context.config.localTools?.enabled, false); assert.equal(initial.context.config.models, undefined);
    assert(initial.context.intents.every(work => !work.localOperations?.length));
    assert.equal(sqliteTask(directory, original.roomId, original.taskId).context.config.toolVersion, expectedToolVersion('1'));
    await stopWorker(first, directory);

    // Catalog observations can change across a real restart without changing the execution contract.
    writeFileSync(catalogFile, JSON.stringify([{ command: 'document-reader', description: '更新后的目录说明', domains: ['docs.example.com'], execution: 'host' }]));
    const metadataOnly = await startWorker(directory, readersFile, catalogFile); workers.push(metadataOnly); await healthy(metadataOnly);
    const metadataRecovered = await taskSnapshot(metadataOnly, original.roomId, original.taskId);
    assert.equal(metadataRecovered.context.config.toolVersion, expectedToolVersion('1'));
    assert(!metadataRecovered.context.resilience?.gates.some(gate => gate.cause === 'incompatibleExecution' && gate.status === 'open'),
      'A directory-only change must not invalidate the saved task execution contract');
    await stopWorker(metadataOnly, directory);

    // A real file edit and fresh process must not silently reuse the previous reader configuration.
    const changed = reader('2');
    writeFileSync(readersFile, JSON.stringify([{ resource: changed.resource, format: changed.format, argsPrefix: changed.argsPrefix,
      command: changed.command, version: changed.version, id: changed.id }]));
    const second = await startWorker(directory, readersFile, catalogFile); workers.push(second); await healthy(second);
    const recovered = await taskSnapshot(second, original.roomId, original.taskId);
    const gate = recovered.context.resilience?.gates.find(item => item.cause === 'incompatibleExecution' && item.scope === 'task' && item.status === 'open');
    assert(gate, 'Changed administrator reader configuration must open the old task required incompatibility gate');
    assert.equal(gate.required, true); assert.deepEqual(gate.decisions, ['skip', 'stop']);
    assert.equal(recovered.value, 'waitingHuman'); assert.equal(recovered.context.outcome, null);
    assert.equal(recovered.context.config.toolVersion, expectedToolVersion('1'), 'Recovery must preserve the original execution identity');
    assert.equal(sqliteTask(directory, original.roomId, original.taskId).context.resilience!.gates.find(item => item.id === gate.id)!.required, true);
    const projected = await request<{ blockers: { id: string; requiredHuman: boolean }[] }>(second, `/api/rooms/${original.roomId}`);
    assert(projected.blockers.some(blocker => blocker.id === gate.id && blocker.requiredHuman));
    const fresh = await submitTask(second, '新配置任务'), active = await taskSnapshot(second, fresh.roomId, fresh.taskId);
    assert.equal(active.context.config.toolVersion, expectedToolVersion('2'));
    assert.notEqual(active.context.config.toolVersion, initial.context.config.toolVersion);
    assert.equal(active.context.config.models, undefined); assert(active.context.intents.every(work => !work.localOperations?.length));
    await stopWorker(second, directory);

    const syntheticSensitiveValue = 'synthetic-bootstrap-sensitive-do-not-print-7e29';
    writeFileSync(readersFile, JSON.stringify([{ ...reader('3'), apiKey: syntheticSensitiveValue }]));
    const invalid = await startWorker(directory, readersFile, catalogFile); workers.push(invalid);
    const rejected = await bounded(invalid.exit, 'Invalid reader file must reject startup before listening');
    assert.notEqual(rejected.code, 0); assert.equal(rejected.signal, null);
    assert(invalid.logs().includes('正文校验器配置无效'));
    assert(!invalid.logs().includes(syntheticSensitiveValue), 'Invalid reader diagnostics leaked a synthetic sensitive configuration value');
    assert.equal(existsSync(join(directory, 'runtime/service.lock')), false);
    assert.equal(readFileSync(catalogFile, 'utf8').includes(syntheticSensitiveValue), false);
    return { bootstraps: 3, directoryOnlyRestartPreservesContract: true, rejectedConfigurations: 1, canonicalToolVersions: [expectedToolVersion('1'), expectedToolVersion('2')],
      changedConfiguration: { oldTaskPhase: recovered.value, requiredGate: gate.cause, originalProtocolPreserved: true },
      gracefulSigterm: 3, serviceLocksRemoved: true, invalidConfigurationValueRedacted: true,
      boundary: 'Real scripts/web.ts, administrator files, local HTTP, SQLite and process lifecycle; no model service, CLI execution, resource network read or OS isolation claim' };
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGKILL'); await bounded(worker.exit, 'Bootstrap fixture child failed to stop', 2000).catch(() => {});
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await verifyToolBootstrapAcceptance()));
