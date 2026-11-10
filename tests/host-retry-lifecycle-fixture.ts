import assert from 'node:assert/strict';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { hostRetryReservation } from '../src/host-retry.js';
import { localModelInput } from './local-model-fixture.js';
import { retryWork, retryOp, settleRetry, startFirstRetry, twoQueued } from './host-retry-model-fixture.js';

export function unknownBatch() {
  const m = twoQueued(); startFirstRetry(m);
  assert.equal(m.c.hostRetryBatch?.phase, 'active');
  assert(settleRetry(m, { uncertain: true }).ok);
  assert.equal(m.c.hostRetryBatch?.phase, 'uncertain');
  return { m, workId: retryWork(m).id, op: structuredClone(retryOp(m)), usage: structuredClone(m.c.usage) };
}
export function stopBatch(run: ReturnType<typeof unknownBatch>) {
  assert(run.m.send({ type: 'STOP' }).ok);
  assert(run.m.send({ type: 'RECOVER', config: localModelInput().config }).ok);
  assert.equal(run.m.c.hostRetryBatch?.phase, 'draining');
  assert.equal(retryWork(run.m).localOperations?.length, 1);
}
export function settleBatch(run: ReturnType<typeof unknownBatch>) {
  const { m, workId, op } = run;
  assert(m.send({ type: 'LOCAL_RECONCILE', intentId: workId, operationId: op.id, sessionId: op.sessionId,
    resolution: 'receipt', result: { ok: true, code: 'succeeded', data: { execution: 'host' } }, detail: '可信回执' }).ok);
  m.send({ type: 'HOST_RETRY_RECONCILE' });
  assert.equal(m.c.hostRetryBatch, undefined);
  assert.equal(hostRetryReservation(m.c), 0);
  assert.deepEqual(m.c.usage, run.usage);
  assert.equal(m.c.trace.filter(item => item.event === 'HOST_RETRY_BATCH_RETIRED').length, 1);
  assert.equal(m.c.hostRetryRequests?.[1]?.status, 'cancelled');
}
export function restoreLegacyBatch(run: ReturnType<typeof unknownBatch>) {
  const saved = JSON.parse(JSON.stringify(persistTask(run.m.snapshot)));
  delete saved.context.hostRetryBatch.phase;
  run.m.snapshot = restoreTask(saved);
  assert(run.m.send({ type: 'RECOVER', config: localModelInput().config }).ok);
  assert(run.m.send({ type: 'HOST_RETRY_RECONCILE' }).ok);
  assert.equal(run.m.c.hostRetryBatch?.phase, 'uncertain');
  assert.deepEqual(run.m.c.usage, run.usage);
  assert.equal(retryWork(run.m).localOperations?.length, 1);
}
export function verifyHostRetryLifecycleModel() {
  const stopped = unknownBatch(); stopBatch(stopped); settleBatch(stopped);
  restoreLegacyBatch(unknownBatch());
}
