import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalRuntime } from '../../src/local-runtime.js';
import { OpenAICompatibleAdapter } from '../../src/model-adapter.js';
import { WebService } from '../../src/web/service.js';
import { ControlledProcessBackend, localConfig } from '../local-tools-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';
import type { LocalAction } from '../../src/local-operation.js';

// Fault injection belongs to the dependency fixture, never the production runtime.
const [root, window] = process.argv.slice(2);
assert(root && ['beforeReceipt', 'afterJournal'].includes(window!));
const backend = new ControlledProcessBackend(), execute = backend.execute.bind(backend);
const spawnGate = '.spawn-journal-ready';
let spawnHandshake: { sessionId: string; pid: number; journalPhase: 'spawned'; effectAbsent: true } | undefined;
backend.execute = (input, signal, onSpawn) => execute(input, signal, async identity => {
  await onSpawn(identity);
  const record = await runtime.journal.read(input.sessionId);
  assert.equal(record?.phase, 'spawned'); assert.equal(record?.identity?.pid, identity.pid);
  await assert.rejects(readFile(join(input.cwd, 'once.txt')), { code: 'ENOENT' }, 'The effect must wait for the fsynced spawn identity');
  spawnHandshake = { sessionId: input.sessionId, pid: identity.pid, journalPhase: 'spawned', effectAbsent: true };
  await writeFile(join(input.cwd, spawnGate), 'ready');
});
const runtime = await LocalRuntime.create({ dataRoot: join(root, 'runtime'), workspaceRoot: join(root, 'source'),
  skillRoots: [], backend });
const originalWrite = runtime.journal.write.bind(runtime.journal);
let service: WebService, roomId: string, taskId: string;
runtime.journal.write = async record => {
  if (record.phase !== 'settled') return originalWrite(record);
  assert.equal(await readFile(join(root, 'source', 'once.txt'), 'utf8'), 'x');
  assert.equal(record.completion?.result.ok, true);
  assert(spawnHandshake); assert.equal(record.completion.result.data.processRecorded, true);
  if (window === 'afterJournal') await originalWrite(record);
  const work = service.engine.view(roomId, taskId)!.context.intents.find(item => item.localOperations?.some(op => op.id === record.operationId))!;
  const op = work.localOperations!.find(item => item.id === record.operationId)!;
  process.send!({ type: 'barrier', window, hostPid: process.pid, roomId, taskId, workId: work.id,
    operationId: op.id, sessionId: op.sessionId, workspaceId: op.workspaceId, completion: record.completion, spawnHandshake });
  await new Promise<void>(() => {});
};
const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e',
  "const fs=require('fs');const gate=" + JSON.stringify(spawnGate) + ";" +
  "new Promise((resolve,reject)=>{let timer;const ready=()=>{if(!fs.existsSync(gate))return;watcher.close();clearTimeout(timer);fs.unlinkSync(gate);resolve();};" +
  "const watcher=fs.watch('.',ready);timer=setTimeout(()=>{watcher.close();reject(new Error('Spawn journal handshake missing'));},10000);ready();})" +
  ".then(()=>{const fd=fs.openSync('once.txt','a');fs.writeSync(fd,'x');fs.fsyncSync(fd);fs.closeSync(fd);console.log('real-effect-receipt');})" +
  ".catch(error=>{console.error(error);process.exitCode=1;});"] };
const adapter = new OpenAICompatibleAdapter(localConfig(), { transport: async () => modelResponse(action) });
service = new WebService(localConfig(), join(root, 'team.sqlite'), adapter, undefined, false, runtime);
await service.ready();
roomId = service.createRoom('真实宿主崩溃恢复').id;
taskId = service.submit(roomId, { id: 'crash-command', text: '执行隔离账本命令并说明结果' }).taskId!;
process.on('message', () => {});
