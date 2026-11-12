/** Real taskMachine gate, with no process, network or product filesystem I/O. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LocalModel } from './local-model-fixture.js';
import type { HostApproval, LocalAction } from '../src/local-operation.js';

const action = { type: 'runCli', executable: 'tesseract', args: ['stdin', 'stdout'],
  stdin: { path: '.tmp/input.pgm' }, execution: 'host', reason: '使用已安装的OCR' } as LocalAction;
const m = new LocalModel();
assert.equal(m.request(action).code, 'OK');
assert.equal(m.claim().code, 'OK');
assert.equal(m.started().code, 'HOST_APPROVAL_REQUIRED');
const approval: HostApproval = { id: 'stdin-approval', digest: 'd'.repeat(64), status: 'pending', expiresAt: 900,
  plan: { executable: '/usr/bin/tesseract', args: ['stdin', 'stdout'], cwd: '/task', workspaceRevision: 'b'.repeat(64),
    executableHash: 'c'.repeat(64), environmentHash: 'e'.repeat(64), host: 'host', account: 'account', reason: '使用已安装的OCR',
    stdin: { path: '.tmp/input.pgm', sha256: 'a'.repeat(64), bytes: 256 } } };
assert.equal(m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', approval }).code, 'OK');
assert.equal(m.op?.status, 'awaitingApproval');
assert.deepEqual(m.op?.action, action);
assert.equal(m.claim().code, 'LOCAL_NOT_QUEUED');
assert.equal(m.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: m.work.id, operationId: 'op1', approvalId: 'stdin-approval', decision: 'approve', fence: m.work }).code, 'OK');
assert.equal(m.claim().code, 'OK');
assert.equal(m.started().code, 'OK');
assert.equal(m.result().code, 'OK');
assert.equal(m.op?.status, 'succeeded');

for (const path of ['../outside', '/outside', 'a/../../outside', 'a\\outside']) {
  const invalid = new LocalModel();
  assert.equal(invalid.request({ ...action, stdin: { path } } as LocalAction).code, 'INVALID_LOCAL_REQUEST');
  assert.equal(invalid.op, undefined);
}
for (const stdin of [null, 'image', [], { path: 'input', sha256: 'a'.repeat(64) }]) {
  const invalid = new LocalModel();
  assert.equal(invalid.request({ ...action, stdin } as LocalAction).code, 'INVALID_LOCAL_REQUEST');
  assert.equal(invalid.op, undefined);
}
const stopped = new LocalModel(); assert(stopped.request(action).ok); assert(stopped.send({ type: 'STOP' }).ok);
assert.notEqual(stopped.claim().code, 'OK'); assert.equal(stopped.op?.startedAt, undefined);
const stale = new LocalModel(); assert(stale.request(action).ok); stale.c.goalVersion++;
assert.equal(stale.claim().code, 'STALE_WORK'); assert.equal(stale.op?.startedAt, undefined);
const sourceHashes = Object.fromEntries(['src/task.machine.ts', 'src/task/reducer.ts', 'src/local-operation.ts', 'src/host-session.ts']
  .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
console.log(JSON.stringify({ status: 'passed', model: 'real taskMachine', contract: 'R-SI01–R-SI04', sourceHashes,
  boundary: 'Product transitions use only controlled events and persisted snapshot round trips. Outer gate reads source hashes for provenance.',
  paths: ['stdin persisted', 'approval required', 'approved start', 'settled', 'invalid path and shape', 'stop', 'stale version'] }));
