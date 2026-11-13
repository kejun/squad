import assert from 'node:assert/strict';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { LocalModel } from './local-model-fixture.js';
import { claimCheck, deliver, passCheck } from './host-retry-model-fixture.js';

export function fixedCandidate() {
  const m = new LocalModel(); assert(deliver(m).ok);
  const check = claimCheck(m);
  assert.equal(m.c.deliveryCycle?.stage.kind, 'checking');
  return { m, check, original: structuredClone(check.payload), revision: m.c.candidate!.revision! };
}
export function retryThenRevise(run: ReturnType<typeof fixedCandidate>) {
  const { m, check } = run;
  assert(m.send({ type: 'WORK_FAILED', intentId: check.id, fence: check, attempt: check.attempt, transient: true, reason: 'transport' }).ok);
  const retry = claimCheck(m);
  assert.equal(retry.id, check.id); assert.deepEqual(retry.payload, run.original);
  assert.equal(m.c.deliveryCycle?.stage.kind, 'checking');
  run.check = retry;
}
export function revisedDelivery(run: ReturnType<typeof fixedCandidate>) {
 const {m,check}=run;
 assert(m.send({type:'CHECK_RESULT',workId:check.id,fence:check,attempt:check.attempt,resultId:'repaired-final',candidateRevision:run.revision,
  repair:{text:'检查员直接补齐必需内容',artifacts:[]},criteriaResults:m.c.candidate!.acceptance!.criteria.map(c=>({criterionId:c.id,status:'passed'}))}).ok);
 assert.notEqual(m.c.candidate?.revision,run.revision);assert.equal(m.c.outcome,'complete');assert.equal(m.c.usage.checks,2);assert.equal(m.c.usage.retries,1);
 assert.equal(m.c.intents.filter(w=>w.payload.deliveryRevision).length,0);
}
export function legacyCheck(run: ReturnType<typeof fixedCandidate>) {
  const saved = JSON.parse(JSON.stringify(persistTask(run.m.snapshot)));
  delete saved.context.deliveryCycle.stage;
  run.m.snapshot = restoreTask(saved);
  assert.deepEqual(run.m.c.deliveryCycle?.stage, { kind: 'checking', candidateRevision: run.revision, checkWorkId: run.check.id });
  const result = run.m.send({ type: 'CHECK_RESULT', workId: run.check.id, attempt: run.check.attempt, fence: run.check,
    resultId: 'old-revision', candidateRevision: 'old', criteriaResults: [] });
  assert.equal(result.code, 'STALE_CANDIDATE_CHECK');
  assert.deepEqual(run.m.c.intents.find(work => work.id === run.check.id)!.payload, run.original);
  assert.equal(run.m.c.publishedDelivery, undefined);
}
export function verifyDeliveryCycleModel() {
  const run = fixedCandidate(); retryThenRevise(run); revisedDelivery(run);
  legacyCheck(fixedCandidate());
}
