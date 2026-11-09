import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const runtime = await LocalRuntime.create({ dataRoot: join(root, 'runtime'), workspaceRoot: join(root, 'source'),
  skillRoots: [], backend: new ControlledProcessBackend() });
const originalWrite = runtime.journal.write.bind(runtime.journal);
let service: WebService, roomId: string, taskId: string;
runtime.journal.write = async record => {
  if (record.phase !== 'settled') return originalWrite(record);
  assert.equal(await readFile(join(root, 'source', 'once.txt'), 'utf8'), 'x');
  assert.equal(record.completion?.result.ok, true);
  if (window === 'afterJournal') await originalWrite(record);
  const work = service.engine.view(roomId, taskId)!.context.intents.find(item => item.localOperations?.some(op => op.id === record.operationId))!;
  const op = work.localOperations!.find(item => item.id === record.operationId)!;
  process.send!({ type: 'barrier', window, hostPid: process.pid, roomId, taskId, workId: work.id,
    operationId: op.id, sessionId: op.sessionId, workspaceId: op.workspaceId, completion: record.completion });
  await new Promise<void>(() => {});
};
const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e',
  "const fs=require('fs');const fd=fs.openSync('once.txt','a');fs.writeSync(fd,'x');fs.fsyncSync(fd);fs.closeSync(fd);console.log('real-effect-receipt')"] };
const adapter = new OpenAICompatibleAdapter(localConfig(), { transport: async () => modelResponse(action) });
service = new WebService(localConfig(), join(root, 'team.sqlite'), adapter, undefined, false, runtime);
await service.ready();
roomId = service.createRoom('真实宿主崩溃恢复').id;
taskId = service.submit(roomId, { id: 'crash-command', text: '执行隔离账本命令并说明结果' }).taskId!;
process.on('message', () => {});
