import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { processingWindow } from '../src/task/resilience.js';

const maximum = Number.MAX_SAFE_INTEGER;
const timeout = 2_147_483_647;
export function maximumBudgetModelGate() {
const model = new LocalModel(input => {
  input.config.limits = { ordinary: maximum, checks: maximum, assists: maximum, replans: maximum, retries: maximum,
    workTimeoutMs: timeout, progressIntervalMs: 600_000, repeatThreshold: maximum };
  input.config.resilience = { automaticTimeoutMs: timeout, repairLimit: maximum };
});
assert.equal(model.work.status, 'inflight');
assert.equal(processingWindow(model.c).hardDeadline, timeout);
assert(model.send({ type: 'CONSUME', intentId: model.work.id }).ok);
assert.equal(model.c.usage.ordinary, 1);
assert(model.request({ type: 'runCli', executable: 'node', args: ['read-only.js'], timeoutMs: timeout, execution: 'host', reason: '读取已登录资料' }).ok);
assert(model.claim().ok);
assert.equal(model.started().code, 'HOST_APPROVAL_REQUIRED');
assert.equal(model.op?.status, 'claimed');
assert.equal(model.op?.startedAt, undefined);
assert(model.send({ type: 'STOP' }).ok);
assert.equal(model.c.stopped, true);
assert.equal(model.op?.startedAt, undefined);
return { status: 'passed', model: 'real taskMachine with persisted restore after every event',
  scenarios: ['MAX-02 high quota consumption', 'host approval retained', 'stop retained'], maximum, timeout };

}

export function maximumDeliveryBudgetsModel() {
  const configured = () => new LocalModel(input => {
    input.config.limits = { ordinary: maximum, checks: maximum, assists: maximum, replans: maximum, retries: maximum,
      workTimeoutMs: timeout, progressIntervalMs: 600_000, repeatThreshold: maximum };
    input.config.resilience = { automaticTimeoutMs: timeout, repairLimit: maximum };
  });
  const deliver = (m: LocalModel) => {
    const owner = m.c.intents.find(work => work.kind === 'owner' && work.status === 'inflight')!; assert(owner);
    assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: 'model-only candidate revision', artifactIds: [] }).ok);
  };
  const claimCheck = (m: LocalModel) => {
    const check = m.c.intents.find(work => work.kind === 'check' && work.status === 'pending'); assert(check, 'A further check must remain claimable');
    assert(m.send({ type: 'CLAIM', intentId: check.id }).ok);
    assert(m.send({ type: 'CONSUME', intentId: check.id }).ok); return m.c.intents.find(work => work.id === check.id)!;
  };
  const revisions = configured();
  for (let round = 0; round < 4; round++) {
    deliver(revisions); const check = claimCheck(revisions);
    const requirements = revisions.c.candidate!.acceptance!.criteria;
    assert(revisions.send({ type: 'CHECK_RESULT', workId: check.id, attempt: check.attempt, fence: check,
      resultId: `failed-check-${round}`, candidateRevision: revisions.c.candidate!.revision,
      criteriaResults: requirements.map(requirement => ({ criterionId: requirement.id, status: 'failed', reason: 'model revision required' })) }).ok);
    const next = revisions.c.intents.find(work => work.kind === 'owner' && work.status === 'pending');
    assert(next, 'Maximum quotas must not stop after the old two or three revisions');
    assert(revisions.send({ type: 'CLAIM', intentId: next.id }).ok);
  }
  assert.equal(revisions.c.outcome, null);
  assert(revisions.send({ type: 'STOP' }).ok);
  const retries = configured(); deliver(retries);
  for (let round = 0; round < 3; round++) {
    const check = claimCheck(retries);
    assert(retries.send({ type: 'WORK_FAILED', intentId: check.id, attempt: check.attempt, reason: 'controlled network failure', transient: true }).ok);
    assert.equal(retries.c.intents.find(work => work.id === check.id)!.status, 'pending', 'Maximum retry quota must permit more than one technical retry');
  }
  assert.equal(retries.c.usage.retries, 3); assert.equal(retries.c.outcome, null); assert(retries.send({ type: 'STOP' }).ok);
  return { revisions: 4, technicalRetries: 3, stopped: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify({ basic: maximumBudgetModelGate(), delivery: maximumDeliveryBudgetsModel() }));
