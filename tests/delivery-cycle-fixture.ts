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
  assert(m.send({ type: 'CHECK_RESULT', workId: retry.id, fence: retry, attempt: retry.attempt, resultId: 'needs-revision',
    candidateRevision: run.revision, criteriaResults: m.c.candidate!.acceptance!.criteria.map(item =>
      ({ criterionId: item.id, status: 'failed', reason: '缺少必需内容' })) }).ok);
  assert.equal(m.c.deliveryCycle?.stage.kind, 'revising');
  assert.equal(m.c.deliveryCycle?.revisionUsed, true);
}
export function revisedDelivery(run: ReturnType<typeof fixedCandidate>) {
  const { m } = run;
  const owner = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
  assert(m.send({ type: 'CLAIM', intentId: owner.id }).ok);
  const claimed = m.c.intents.find(work => work.id === owner.id)!;
  assert(m.send({ type: 'DELIVER', workId: claimed.id, fence: claimed, attempt: claimed.attempt, text: '补齐必需内容的新候选', artifactIds: [] }).ok);
  assert.notEqual(m.c.candidate?.revision, run.revision);
  assert(passCheck(m, claimCheck(m), 'passed-revision').ok);
  assert.deepEqual(m.c.deliveryCycle?.stage, { kind: 'published', candidateRevision: m.c.candidate!.revision });
  assert.equal(m.c.usage.checks, 3); assert.equal(m.c.usage.retries, 1);
  assert.equal(m.c.intents.filter(work => work.payload.deliveryRevision === true).length, 1);
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
