import assert from 'node:assert/strict';
import type { LocalAction, LocalToolResult } from '../src/local-operation.js';
import { deliveryEvidence, evidenceIndex } from '../src/task/evidence.js';
import { LocalModel, localModelInput } from './local-model-fixture.js';

const firstSource = 'op1';
const readId = 'read-1';
const runAction: LocalAction = { type: 'runCli', executable: 'node', args: ['script.js'] };
const readAction = (sourceOperationId = firstSource): LocalAction => ({ type: 'readEvidence', sourceOperationId, stream: 'stdout' });
const receipt: LocalToolResult = {
  ok: true, code: 'succeeded', data: { stdout: '已有正文', stderr: '', exitCode: 0, truncated: false,
    capturedEvidence: { stdout: { capturedContentHash: 'd'.repeat(64), bytes: 12, chars: 4 } } },
};

function newSource(result = receipt, ordinary = 30) {
  const m = new LocalModel(input => { input.config.limits.ordinary = ordinary; });
  assert(m.request(runAction).ok);
  assert(m.claim().ok);
  assert(m.started().ok);
  assert(m.result({ result }).ok);
  return m;
}

function request(m: LocalModel, action: LocalAction, operationId = readId) {
  return m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId, namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
    action, parentAttempt: m.work.attempt, messages: [], fence: m.work,
    ...(action.type === 'runCli' ? { workspaceId: 'project' } : {}) });
}

function claim(m: LocalModel, operationId = readId, sessionId = 'reading') {
  return m.send({ type: 'LOCAL_CLAIM', intentId: m.work.id, operationId, sessionId, parentAttempt: m.work.attempt, leaseAvailable: false, fence: m.work });
}

function operation(m: LocalModel) {
  return m.c.intents.find(work => work.id === m.work.id)?.localOperations?.find(item => item.id === readId);
}

function claimLatest(m: LocalModel) {
  const work = m.c.intents.at(-1)!;
  assert(m.send({ type: 'CLAIM', intentId: work.id }).ok);
  m.work = m.c.intents.find(item => item.id === work.id)!;
}

function checking(result = receipt) {
  const m = newSource(result);
  assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: '待验收', artifactIds: [] }).ok);
  claimLatest(m);
  return m;
}

function assisting(refs: string[]) {
  const m = newSource();
  assert(m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', target: 'B', requestId: 'help-1',
    question: '核对来源', expected: '提供独立意见', refs }).ok);
  claimLatest(m);
  return m;
}

function savedRead(m: LocalModel) {
  assert(request(m, readAction()).ok);
  assert(claim(m).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: m.work.id, operationId: readId, sessionId: 'reading',
    result: { ok: true, code: 'EVIDENCE_PAGE', data: { text: '已有正文' } }, settled: true, effectsKnown: true }).ok);
  return m;
}

export async function* givesTheCheckerOneFixedSourceWithItsOriginalTextAndDeniesPagedReads() {
const m = checking();
yield 'prepared';
const projected = deliveryEvidence(m.c, m.work, m.c.deliveryCycle?.evidence);
const denied = request(m, readAction());
yield 'observed';
assert.equal((projected?.sources)?.length, 1);
assert.partialDeepStrictEqual(projected?.sources, [{ id: firstSource, stdout: '已有正文', metadata: { sourceRole: 'owner',
      completeness: 'complete', capturedContentHash: 'd'.repeat(64), stdoutBytes: 12, stdoutChars: 4, obtainedAt: 1 } }]);
assert.equal(denied.code, 'CHECK_LOCAL_TOOLS_NOT_ALLOWED');
assert.equal(operation(m), undefined);
assert.partialDeepStrictEqual(m.c.usage, { ordinary: 2, checks: 0 });
}

export async function* keepsATruncatedCheckSourceAsMetadataWithoutPresentingAUsableQuotation() {
const m = checking({ ...receipt, data: { ...receipt.data, truncated: true } });
yield 'prepared';
const projected = deliveryEvidence(m.c, m.work, m.c.deliveryCycle?.evidence);
yield 'observed';
assert.equal((projected?.sources)?.length, 1);
assert.partialDeepStrictEqual(projected?.sources, [{ id: firstSource, metadata: { completeness: 'truncated' } }]);
assert.equal(projected?.sources[0]?.stdout, undefined);
}

export async function* retainsADistinctCLIOperationEvenWhenItsActionAndHashMatchTheOriginal() {
const m = newSource();
yield 'prepared';
const response = request(m, runAction, 'refresh-2');
yield 'observed';
assert.equal(response.ok, true);
assert.deepEqual(m.c.intents[0]!.localOperations?.map(item => [item.id, item.status]), [[firstSource, 'succeeded'], ['refresh-2', 'queued']]);
}

export async function* projectsTruncatedReceipt() {
const row = {"data":{"stdout":"部分正文","truncated":true},"ok":true,"completeness":"truncated"};
const { data, ok, completeness } = row;
const m = newSource({ ok, code: 'fixture', data });
yield 'prepared';

const observation0 = evidenceIndex(m.c, m.work);
yield 'observed';
assert.equal((observation0)?.length, 1);
assert.partialDeepStrictEqual(observation0, [{ sourceOperationId: firstSource, completeness, stdoutChars: null }]);
}

export async function* projectsFailedReceipt() {
const row = {"data":{"stdout":"错误诊断"},"ok":false,"completeness":"failed"};
const { data, ok, completeness } = row;
const m = newSource({ ok, code: 'fixture', data });
yield 'prepared';

const observation0 = evidenceIndex(m.c, m.work);
yield 'observed';
assert.equal((observation0)?.length, 1);
assert.partialDeepStrictEqual(observation0, [{ sourceOperationId: firstSource, completeness, stdoutChars: null }]);
}

export async function* projectsMissingReceipt() {
const row = {"data":{},"ok":true,"completeness":"missing"};
const { data, ok, completeness } = row;
const m = newSource({ ok, code: 'fixture', data });
yield 'prepared';

const observation0 = evidenceIndex(m.c, m.work);
yield 'observed';
assert.equal((observation0)?.length, 1);
assert.partialDeepStrictEqual(observation0, [{ sourceOperationId: firstSource, completeness, stdoutChars: null }]);
}

export async function* projectsUnknownReceipt() {
const row = {"data":{"stdout":"旧正文"},"ok":true,"completeness":"unknown"};
const { data, ok, completeness } = row;
const m = newSource({ ok, code: 'fixture', data });
yield 'prepared';

const observation0 = evidenceIndex(m.c, m.work);
yield 'observed';
assert.equal((observation0)?.length, 1);
assert.partialDeepStrictEqual(observation0, [{ sourceOperationId: firstSource, completeness, stdoutChars: null }]);
}

export async function* refusesSourceIDsOutsideTheTask() {
const m = newSource();
assert(request(m, readAction('other-task:work:local:0')).ok);
yield 'prepared';
const response = claim(m);
yield 'observed';
assert.equal(response.code, 'EVIDENCE_UNAVAILABLE');
assert.equal(m.c.usage.ordinary, 2);
}

export async function* refusesAPriorGoalReceiptFromTheNewActiveWork() {
const m = newSource();
assert(m.send({ type: 'USER_INPUT', text: '换目标', goal: { ...m.c.goal, text: '新目标' } }).ok);
assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
claimLatest(m);
assert(request(m, readAction()).ok);
yield 'prepared';
const response = claim(m);
const observation0 = evidenceIndex(m.c, m.work);
yield 'observed';
assert.equal(response.code, 'EVIDENCE_UNAVAILABLE');
assert.deepEqual(observation0, []);
}

export async function* refusesAnExistingSourceAbsentFromTheAssignment() {
const m = assisting([]);
assert(request(m, readAction()).ok);
yield 'prepared';
const response = claim(m);
const observation0 = evidenceIndex(m.c, m.work);
yield 'observed';
assert.equal(response.code, 'EVIDENCE_UNAVAILABLE');
assert.deepEqual(observation0, []);
}

export async function* admitsAHostSelectedSourceInTheCurrentAssignment() {
const m = assisting([firstSource, 'unknown-source']);
assert(request(m, readAction()).ok);
yield 'prepared';
const response = claim(m);
yield 'observed';
assert.equal(response.ok, true);
assert.deepEqual(m.work.evidenceRefs, [firstSource]);
}

export async function* cancelsAQueuedReadWithoutConsumingItsBudget() {
const m = newSource();
assert(request(m, readAction()).ok);
yield 'prepared';
const response = m.send({ type: 'STOP' });
yield 'observed';
assert.equal(response.ok, true);
assert.equal(operation(m)?.status, 'cancelled');
assert.equal(m.c.usage.ordinary, 2);
}

export async function* refusesAFirstReadWhenOrdinaryBudgetIsExhausted() {
const m = newSource(receipt, 2);
assert(request(m, readAction()).ok);
yield 'prepared';
const response = claim(m);
yield 'observed';
assert.equal(response.code, 'BUDGET_EXHAUSTED');
assert.equal(m.c.usage.ordinary, 2);
}

export async function* preservesTheCompletedReadAndItsChargeOnRecovery() {
const m = savedRead(newSource());
yield 'prepared';
const response = m.send({ type: 'RECOVER', config: localModelInput().config });
yield 'observed';
assert.equal(response.ok, true);
assert.partialDeepStrictEqual(operation(m), { status: 'succeeded', result: { data: { text: '已有正文' } } });
assert.equal(m.c.usage.ordinary, 3);
}

export async function* reclaimsARecoveredInProgressReadUnderTheSameIdentityWithoutChargingAgain() {
const m = newSource();
assert(request(m, readAction()).ok);
assert(claim(m).ok);
assert(m.send({ type: 'RECOVER', config: localModelInput().config }).ok);
assert(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: readId, sessionId: 'reading',
      resolution: 'notStarted', detail: 'saved content read has no external effect' }).ok);
claimLatest(m);
const before = m.c.usage.ordinary;
yield 'prepared';
const response = claim(m, readId, 'reading-again');
yield 'observed';
assert.equal(response.ok, true);
assert.partialDeepStrictEqual(operation(m), { id: readId, status: 'claimed', attempt: 2 });
assert.equal(m.c.usage.ordinary, before);
}

export async function* exposesASettledSourceFromAPreviousEpochOnlyAsHistoricalObservation() {
const m = newSource();
assert(m.send({ type: 'STOP' }).ok);
assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
assert(m.send({ type: 'CONTINUE' }).ok);
claimLatest(m);
yield 'prepared';

const observation0 = evidenceIndex(m.c, m.work);
yield 'observed';
assert.equal((observation0)?.length, 1);
assert.partialDeepStrictEqual(observation0, [{ sourceOperationId: firstSource, epoch: m.c.epoch - 1,
      goalVersion: m.c.goalVersion, historicalObservation: true, obtainedAt: 1, resourceVersion: null }]);
}
