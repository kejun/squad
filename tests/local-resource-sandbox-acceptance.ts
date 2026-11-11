import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TeamEngine } from '../src/engine.js';
import { SandboxCliBackend, identityAlive, type ProcessIdentity } from '../src/local-cli.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { SqliteStore } from '../src/store.js';
import { WorkRunner } from '../src/runner.js';
import { currentExecutionVersion, currentToolVersion } from '../src/task/protocol.js';
import { unconfinedEffectsKey, type ResourceLeaseRow } from '../src/local-resource-policy.js';
import type { LocalAction, LocalOperation } from '../src/local-operation.js';
import type { Intent, TaskContext, TaskEvent, TeamConfig } from '../src/types.js';

const enteredName = '.r26-entered.json', releaseName = '.r26-release', finishedName = '.r26-finished.json';
const sourceBody = 'immutable R26 authority source\n';
const sourceFiles = ['src/local-cli.ts', 'src/local-runtime.ts', 'src/local-operation.ts', 'src/local-resource-policy.ts', 'src/runner.ts', 'src/engine.ts', 'src/store.ts'];
const configuration = (): TeamConfig => ({
  version: currentExecutionVersion, toolVersion: currentToolVersion, defaultBot: 'A', inputAnalysis: { enabled: false },
  localTools: { enabled: true }, skillSearch: { enabled: false }, webTools: { enabled: false },
  bots: ['A', 'B', 'C'].map(id => ({ id, name: id, instructions: 'Verify only the local, isolated barrier.', tools: ['read'] })),
  limits: { ordinary: 30, checks: 2, assists: 4, replans: 2, retries: 0, workTimeoutMs: 60_000, progressIntervalMs: 60_000, repeatThreshold: 3 },
  resilience: { automaticTimeoutMs: 60_000, repairTimeoutMs: 30_000, repairLimit: 2, cancelGraceMs: 1000 },
});

function barrierAction(member: string, source: string): LocalAction {
  // Every path the process may write successfully is inside its own real sandbox copy.
  // The deliberate source write must be denied; it cannot be used as the barrier.
  const script = `const fs=require('node:fs');
const member=${JSON.stringify(member)}, source=${JSON.stringify(source)};
try { fs.writeFileSync(source+'/.r26-escaped-'+member,'forbidden'); process.exit(21); } catch {}
try { fs.readFileSync(source+'/source.txt'); process.exit(22); } catch {}
fs.writeFileSync(${JSON.stringify(enteredName)},JSON.stringify({member,cwd:process.cwd(),pid:process.pid,sourceDenied:true}),{flag:'wx'});
const timeout=setTimeout(()=>{console.error('native barrier was never released');process.exit(23)},45000);
const poll=setInterval(()=>{try{if(fs.readFileSync(${JSON.stringify(releaseName)},'utf8')!==member)return;}catch{return;}
clearInterval(poll);clearTimeout(timeout);fs.writeFileSync(${JSON.stringify(finishedName)},member,{flag:'wx'});console.log('native-barrier-completed:'+member);},10);`;
  return { type: 'runCli', executable: process.execPath, args: ['-e', script], timeoutMs: 45_000 };
}

function readDatabase(database: string, roomId: string, taskId: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM rooms WHERE id=?').get(roomId) as { data: string };
    const room = JSON.parse(row.data) as { tasks: Record<string, { snapshot: { context: TaskContext } }> };
    return { context: room.tasks[taskId]!.snapshot.context,
      leases: db.prepare('SELECT key,owner,mode,phase FROM resource_leases ORDER BY key,owner,phase').all() as unknown as ResourceLeaseRow[],
      legacy: db.prepare('SELECT key,owner FROM workspace_leases').all() };
  } finally { db.close(); }
}

async function sourceUnchanged(source: string) {
  assert.deepEqual((await readdir(source)).sort(), ['source.txt'], 'No command barrier, release, output or escape marker may appear in the source');
  assert.equal(await readFile(join(source, 'source.txt'), 'utf8'), sourceBody);
}

interface ActiveCopy { work: Intent; operation: LocalOperation; path: string; identity: ProcessIdentity }
interface EnteredMarker { member: string; cwd: string; pid: number; sourceDenied: boolean }
interface CommittedEvent { type: string; intentId: string; operationId: string; sessionId: string; at: number }

function assertCopyHeld(store: SqliteStore, roomId: string, key: string, contender: string) {
  assert.equal(store.transact(roomId, tx => tx.acquireResources!([{ key, mode: 'write', phase: 'execute' }], contender)), false,
    'Another owner must not acquire the executing copy');
}

function assertResourceFree(store: SqliteStore, roomId: string, key: string, contender: string) {
  store.transact(roomId, tx => {
    assert(tx.acquireResources!([{ key, mode: 'write', phase: 'execute' }], contender), 'The resource must be independently acquirable now');
    tx.releaseResources!([key], contender);
  });
}

/** BT_Y52 native dependency boundary. No injected backend, external network or credential is used. */
export async function localResourceSandboxAcceptance() {
  const backend = await SandboxCliBackend.create();
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  if (!backend.available) {
    await backend.close();
    return { status: 'blocked' as const, exitCode: 78, scenario: 'BT_Y52', backend: 'SandboxCliBackend',
      reason: backend.unavailableReason ?? 'Native OS sandbox unavailable', sources };
  }
  assert.equal(backend.isolation, 'workspace', 'Parallel copy permissions require the native backend confinement guarantee');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'squad-r26-native-'))), source = join(root, 'source'), dataRoot = join(root, 'runtime');
  const database = join(root, 'team.sqlite'), roomId = 'native-resource-room', taskId = 'task:native-barriers';
  const jobs: Promise<boolean>[] = [], finished = new Set<string>(), failures: unknown[] = [], identities = new Map<number, ProcessIdentity>();
  const committed: CommittedEvent[] = [];
  let runtime: LocalRuntime | undefined, store: SqliteStore | undefined, runner: WorkRunner | undefined, engine: TeamEngine | undefined;
  let seq = 0;
  try {
    await mkdir(source); await writeFile(join(source, 'source.txt'), sourceBody);
    runtime = await LocalRuntime.create({ dataRoot, workspaceRoot: source, skillRoots: [], backend });
    store = new SqliteStore(database);
    engine = new TeamEngine(store, configuration(), Date.now, (_room, frame) => {
      const event = frame.event, c = (frame.snapshot as { context: TaskContext }).context;
      if (c.reply.ok && ['LOCAL_CLAIM', 'LOCAL_PREPARED', 'LOCAL_STARTED', 'LOCAL_RESULT'].includes(event.type)
        && 'intentId' in event && 'operationId' in event && 'sessionId' in event)
        committed.push({ type: event.type, intentId: event.intentId, operationId: event.operationId, sessionId: event.sessionId, at: event.at });
    });
    const send = (body: Record<string, unknown>) => {
      const result = engine!.send(roomId, taskId, { id: `native-setup:${++seq}`, at: Date.now(), ...body } as TaskEvent);
      assert(result.ok, result.code); return result;
    };
    assert(engine.submit(roomId, { id: 'native-barriers', text: 'B和C分别在独立沙箱副本核对本地来源，保留权威源工程',
      goal: { text: '核对两个真实OS沙箱的独立执行', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
    const owner = engine.claim(roomId, taskId, engine.pending(roomId, taskId).find(work => work.kind === 'owner')!.id)!; assert(owner);
    send({ type: 'USER_INPUT', text: '请B和C在各自独立副本核对', reviewTargets: ['B', 'C'] });
    const planner = engine.claim(roomId, taskId, engine.pending(roomId, taskId).find(work => work.kind === 'facilitator')!.id)!; assert(planner);
    send({ type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, discussionId: planner.discussionId,
      decision: { action: 'review', question: '分别核对自己的隔离副本', expected: '真实命令完成回执', reason: '用户明确要求B和C独立核对' } });
    const members = engine.pending(roomId, taskId).filter(work => work.kind === 'assistance');
    assert.deepEqual(members.map(work => work.target).sort(), ['B', 'C']); assert(members.every(work => !!work.discussionId));
    runner = new WorkRunner(engine, { execute: async (work, signal, scope) => {
      assert.equal(work.kind, 'assistance'); assert(scope.localTools);
      const result = await scope.localTools.invoke(barrierAction(work.target, source), [], signal);
      assert(result.ok, JSON.stringify(result)); assert.equal(result.code, 'succeeded');
      assert(String(result.data.stdout).includes('native-barrier-completed:' + work.target));
      return { type: 'answer', status: 'success', text: `真实沙箱完成：${work.target}` };
    } }, Date.now, async () => { throw new Error('The native resource test may not use network'); }, undefined, runtime);

    // Both public runner calls remain pending behind actual process barriers, not synthetic receipts.
    for (const member of members) {
      const job = runner.runOne(roomId, taskId, member.id).then(result => { finished.add(member.id); assert(result); return result; });
      jobs.push(job); void job.catch(error => failures.push(error));
    }
    const barrierDeadline = Date.now() + 30_000;
    const waitFor = async <T>(read: () => Promise<T> | T, accept: (value: T) => boolean, description: string): Promise<T> => {
      while (Date.now() < barrierDeadline) {
        if (failures.length) throw failures[0];
        const value = await read(); if (accept(value)) return value;
        await sourceUnchanged(source);
        const context = engine!.view(roomId, taskId)!.context;
        const stopped = context.intents.filter(work => members.some(member => member.id === work.id))
          .flatMap(work => work.localOperations ?? []).filter(op => ['failed', 'cancelled', 'uncertain'].includes(op.status));
        assert.equal(stopped.length, 0, JSON.stringify(stopped.map(op => ({ id: op.id, status: op.status, result: op.result }))));
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.fail(`Native sandbox barrier timeout: ${description}`);
    };
    const copies = await waitFor(async () => {
      const result: ActiveCopy[] = [];
      for (const member of members) {
        const work = engine!.view(roomId, taskId)!.context.intents.find(work => work.id === member.id)!;
        const op = work.localOperations?.[0]; if (!op?.sessionId || !op.conflictKey || op.status !== 'running') return null;
        assert(op.conflictKey.startsWith('workspace:' + join(dataRoot, 'copies') + sep));
        const path = op.conflictKey.slice('workspace:'.length);
        let marker: EnteredMarker;
        try { marker = JSON.parse(await readFile(join(path, enteredName), 'utf8')) as EnteredMarker; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        const record = await runtime!.journal.read(op.sessionId);
        if (record?.phase !== 'spawned' || !record.identity) return null;
        assert.equal(record.operationId, op.id); assert.equal(record.sessionId, op.sessionId);
        assert.equal(marker.member, member.target); assert.equal(marker.cwd, await realpath(path)); assert.equal(marker.sourceDenied, true);
        assert.equal(await readFile(join(path, 'source.txt'), 'utf8'), sourceBody);
        assert(Number.isSafeInteger(marker.pid) && marker.pid > 0); assert.equal(await identityAlive(record.identity), true);
        identities.set(record.identity.pid, record.identity);
        assert.equal(record.completion, undefined); assert.equal(finished.has(member.id), false);
        result.push({ work, operation: op, path, identity: record.identity });
      }
      return result;
    }, (value): value is ActiveCopy[] => value?.length === 2, 'both real commands entered different copies before either finished');
    assert(copies && copies.length === 2); assert.notEqual(copies[0]!.path, copies[1]!.path);
    assert.notEqual(copies[0]!.operation.sessionId, copies[1]!.operation.sessionId);
    await sourceUnchanged(source);
    const saved = readDatabase(database, roomId, taskId), sourceKey = runtime.workspaceId(owner, engine.localNamespace(roomId, taskId));
    const owners = new Set<string>();
    for (const copy of copies) {
      const op = saved.context.intents.find(work => work.id === copy.work.id)!.localOperations![0]!;
      assert.equal(op.status, 'running'); assert.equal(op.sessionId, copy.operation.sessionId); assert(op.preparedAt !== undefined);
      assert.equal(op.parentAttempt, copy.work.attempt); assert.equal(op.attempt, 1);
      assert(op.resourceLeases!.some(lease => lease.key === sourceKey && lease.mode === 'read' && lease.phase === 'prepare'));
      const rows = saved.leases.filter(row => row.key === op.conflictKey);
      assert.equal(rows.length, 1); assert.equal(rows[0]!.mode, 'write'); assert.equal(rows[0]!.phase, 'execute'); owners.add(rows[0]!.owner);
      assertCopyHeld(store, roomId, op.conflictKey!, `contender:${copy.work.target}`);
      const required = ['LOCAL_CLAIM', 'LOCAL_PREPARED', 'LOCAL_STARTED'];
      assert.deepEqual(committed.filter(event => event.operationId === op.id).map(event => event.type), required);
      assert(committed.filter(event => event.operationId === op.id).every(event => event.sessionId === op.sessionId));
    }
    assert.equal(owners.size, 2); assert.equal(saved.legacy.length, 0);
    assert.equal(saved.leases.filter(row => row.key === sourceKey).length, 0, 'Independent SQLite read must observe source preparation released while both commands are still alive');
    assert.equal(saved.leases.filter(row => row.key === unconfinedEffectsKey && row.mode === 'read').length, 2);
    assertResourceFree(store, roomId, sourceKey, 'source-write-probe');

    // Releasing A must leave the independently running B and B's copy lease protected.
    const [a, b] = copies as [ActiveCopy, ActiveCopy];
    await writeFile(join(a.path, releaseName), a.work.target, { flag: 'wx' }); await jobs[0];
    assert.equal(await readFile(join(a.path, finishedName), 'utf8'), a.work.target);
    assert.equal(await identityAlive(a.identity), false); assert.equal(await identityAlive(b.identity), true);
    assert.equal(finished.has(b.work.id), false); assertCopyHeld(store, roomId, b.operation.conflictKey!, 'remaining-copy-contender');
    assertResourceFree(store, roomId, a.operation.conflictKey!, 'settled-copy-probe'); await sourceUnchanged(source);
    await writeFile(join(b.path, releaseName), b.work.target, { flag: 'wx' }); await Promise.all(jobs);
    const settled = readDatabase(database, roomId, taskId);
    for (const copy of copies) {
      const op = settled.context.intents.find(work => work.id === copy.work.id)!.localOperations![0]!;
      assert.equal(op.status, 'succeeded'); assert.equal(op.result!.data.exitCode, 0); assert.equal(op.result!.data.execution, 'sandbox');
      assert.equal(op.result!.data.isolated, true); assert.equal(await identityAlive(copy.identity), false);
      assert.equal(await readFile(join(copy.path, finishedName), 'utf8'), copy.work.target);
      const receipt: Awaited<ReturnType<LocalRuntime['journal']['read']>> = await runtime.journal.read(op.sessionId!);
      assert(receipt?.completion);
      assert.equal(receipt.phase, 'settled'); assert.equal(receipt.operationId, op.id); assert.equal(receipt.sessionId, op.sessionId);
      assert.equal(receipt.completion.settled, true); assert.equal(receipt.completion.effectsKnown, true);
      assert(committed.some(event => event.type === 'LOCAL_RESULT' && event.operationId === op.id && event.sessionId === op.sessionId));
    }
    assert.equal(settled.leases.length, 0); assert.equal(settled.legacy.length, 0); await sourceUnchanged(source);
    return { status: 'passed' as const, scenario: 'BT_Y52', backend: 'SandboxCliBackend', nativeConfinement: backend.isolation,
      realConcurrentCommands: 2, barrierProof: 'Both entered markers, running operations and live OS identities observed before either release',
      sourceUnchanged: true, sourcePreparationReleasedBeforeSettlement: true, independentlyHeldCopies: true,
      oneCompletionPreservedTheOtherLease: true, physicalProcessesExited: true, committed, sources };
  } finally {
    runner?.abortExecutions(roomId, taskId);
    try {
      await Promise.allSettled(jobs);
      try {
        // A failure may happen before the barrier observer sees the second process.
        // Collect every host journal identity before tearing down the private fixture.
        const context = engine?.view(roomId, taskId)?.context;
        if (runtime && context) for (const work of context.intents) for (const op of work.localOperations ?? []) {
          if (!op.sessionId) continue;
          const record = await runtime.journal.read(op.sessionId);
          if (record?.operationId === op.id && record.identity) identities.set(record.identity.pid, record.identity);
        }
      } finally { if (runtime) await runtime.close(); else await backend.close(); }
      for (const identity of identities.values()) assert.equal(await identityAlive(identity), false, 'Native test teardown must reap every observed process');
    } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await localResourceSandboxAcceptance(); console.log(JSON.stringify(result, null, 2));
    if (result.status === 'blocked') process.exitCode = 78;
  } catch (error) { console.error(error); process.exitCode = 1; }
}
