import assert from 'node:assert/strict';
import { hasFields } from './delivery-contract-observations.js';
import { acceptanceCriteria, deliveryJudgments, type CriterionJudgment } from '../src/delivery-acceptance.js';
import type { Intent } from '../src/types.js';
import { LocalModel } from './local-model-fixture.js';

function submit(model: LocalModel, work = model.work, id = 'candidate', text = '当前候选') {
  return model.send({ type: 'DELIVER', id, workId: work.id, text, artifactIds: [], fence: work, attempt: work.attempt });
}

function claim(model: LocalModel, kind: 'owner' | 'check') {
  const work = model.c.intents.find(item => item.kind === kind && item.status === 'pending')!;
  assert.equal(model.send({ type: 'CLAIM', intentId: work.id }).ok, true);
  return model.c.intents.find(item => item.id === work.id)!;
}

function requestCheck(model: LocalModel) {
  const work = claim(model, 'check');
  assert.equal(model.send({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt }).ok, true);
  return work;
}

function accept(model: LocalModel): CriterionJudgment[] {
  return model.c.candidate!.acceptance!.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed' }));
}

function report(model: LocalModel, work: Intent, criteriaResults?: CriterionJudgment[], resultId = `${work.id}:${work.attempt}`) {
  return model.send({ type: 'CHECK_RESULT', workId: work.id, fence: work, attempt: work.attempt, resultId,
    candidateRevision: model.c.candidate!.revision, criteriaResults });
}

const pendingOwner = (model: LocalModel) => model.c.intents.filter(work => work.kind === 'owner' && work.status === 'pending');

function modelWithHistoricalReference() {
  const model = new LocalModel(input => {
    input.message.text = '比较以前的报告；必须指出恢复风险';
    input.config.inputAnalysis = { enabled: true };
    input.config.models = { default: 'fixture', services: { fixture: { baseUrl: 'https://example.test/v1', model: 'fixture' } } };
    input.history = { messages: [], board: [], truncated: false, artifacts: [
      { taskId: 'prior-task', id: 'recovery', name: '恢复报告', content: '恢复实际用了两小时。', goalVersion: 1 },
      { taskId: 'prior-task', id: 'unrelated', name: '其他报告', content: '未获授权的材料。', goalVersion: 1 },
    ] };
  });
  assert.equal(model.work.kind, 'interpretation');
  assert.equal(model.send({ type: 'INTERPRETATION_RESULT', inputId: 'M', workId: model.work.id, fence: model.work,
    spec: { action: 'request', objective: '比较以前的报告', constraints: [], expectedOutputs: [], acceptanceCriteria: ['指出恢复风险'],
      references: [{ kind: 'artifact', taskId: 'prior-task', id: 'recovery' }], confidence: 1, clarification: null } }).ok, true);
  return model;
}

export async function* fixesApprovedHistoricalMaterialAndVerifiesItsExactQuoteThroughRecheck() {
const model = modelWithHistoricalReference();
assert.equal(submit(model, claim(model, 'owner')).ok, true);
const first = requestCheck(model);
const references = first.payload.references as { id: string; content: string }[];
assert.equal((references)?.length, 1);
assert.partialDeepStrictEqual(references, [{ kind: 'artifact', taskId: 'prior-task', content: '恢复实际用了两小时。' }]);
const results = accept(model);
results[0] = { ...results[0]!, status: 'failed', reason: '漏写恢复时间', source: { id: references[0]!.id, quote: '用了两小时' } };
assert.equal(report(model, first, results).ok, true);
assert.equal(model.snapshot.value, 'running');
yield 'prepared';
model.c.history!.artifacts[0]!.content = '此后记录变化。';
assert.equal(submit(model, claim(model, 'owner'), 'revision').ok, true);
const second = requestCheck(model);
assert.deepEqual(second.payload.references, references);
const revised = accept(model);
revised[0] = { ...revised[0]!, status: 'passed', source: { id: references[0]!.id, quote: '用了两小时' } };
assert.equal(report(model, second, revised).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'complete');
assert.deepEqual(model.c.publishedDelivery?.artifactIds, []);
}

export async function* settlesWithoutACheckWhenAnApprovedHistoricalReferenceCanNoLongerBeRead() {
const model = modelWithHistoricalReference();
model.c.history!.artifacts = [];
yield 'prepared';
assert.equal(submit(model, claim(model, 'owner')).ok, true);
yield 'observed';
assert.equal(model.c.candidate?.deliveryIssue?.code, 'CHECK_REFERENCE_UNAVAILABLE');
assert.equal(model.c.outcome, 'partial');
assert.equal(model.c.usage.checks, 0);
}

export async function* retainsDirectRequirementsOmittedByAValidatedInputInterpretation() {
const model = new LocalModel(input => { input.goal.constraints = ['保留每一条用户硬约束']; });
yield 'prepared';
const criteria = acceptanceCriteria(model.c);
yield 'observed';
assert((criteria).some((item: any) => hasFields(item, { text: '保留每一条用户硬约束', goalVersion: 1, sources: [{ kind: 'goal', id: 'M' }, { kind: 'input', id: 'M' }] })));
}

export async function* publishesTheCandidateAfterOneIndependentAllPassRequest() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const work = requestCheck(model);
const results = accept(model);
yield 'prepared';
assert.equal(report(model, work, results).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'complete');
assert.equal(model.c.publishedDelivery?.revision, model.c.candidate?.revision);
assert.deepEqual(deliveryJudgments(model.c, model.c.candidate?.revision), results);
assert.equal(model.c.usage.checks, 1);
}

export async function* keepsTheCurrentCheckAliveWhenAResultHasNoAttemptIdentity() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const work = requestCheck(model);
yield 'prepared';
const rejected = model.send({ type: 'CHECK_RESULT', workId: work.id, fence: work, candidateRevision: model.c.candidate!.revision,
      resultId: 'unbound', criteriaResults: accept(model) });
assert.equal(rejected.code, 'CHECK_WORK_REQUIRED');
assert.equal(report(model, work, accept(model)).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'complete');
}

export async function* settlesAClaimedCheckWithoutAModelReceiptAsIncomplete() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const work = claim(model, 'check');
yield 'prepared';
assert.equal(model.send({ type: 'SETTLE', intentId: work.id, attempt: work.attempt }).ok, true);
yield 'observed';
assert.equal(model.snapshot.value, 'ended');
assert.equal(model.c.outcome, 'partial');
assert.equal(model.c.candidate?.deliveryIssue?.code, 'CHECK_NOT_COMPLETED');
assert.equal(model.c.usage.checks, 0);
}

export async function* letsAMissingArtifactConsumeTheOnlyAutomaticCorrectionOpportunity() {
const model = new LocalModel(input => { input.goal.requiredArtifacts = 1; });
assert.equal(submit(model).ok, true);
const repair = claim(model, 'owner');
yield 'prepared';
assert.equal(submit(model, repair, 'unrepaired').ok, true);
assert.equal(submit(model, claim(model, 'owner'), 'still-unrepaired').ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'partial');
assert.equal(model.c.candidate?.deliveryIssue?.code, 'MISSING_ARTIFACTS');
assert.equal(model.c.deliveryCycle?.revisionUsed, true);
assert.equal(model.c.usage.checks, 0);
assert.deepEqual(pendingOwner(model), []);
}

export async function* settlesMissingArtifactsWithoutSpendingACorrectionWhenThereIsNoCheckBudget() {
const model = new LocalModel(input => { input.goal.requiredArtifacts = 1; input.config.limits.checks = 0; });
yield 'prepared';
assert.equal(submit(model).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'partial');
assert.equal(model.c.candidate?.deliveryIssue?.code, 'MISSING_ARTIFACTS');
assert.deepEqual(pendingOwner(model), []);
}

export async function* treatsAMissingCriterionAsACheckFailureWithoutSchedulingAuthorWork() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const check = requestCheck(model);
yield 'prepared';
assert.equal(report(model, check, accept(model).slice(0, 1)).ok, true);
yield 'observed';
assert.equal(model.snapshot.value, 'checking');
assert.equal(model.c.intents.find(item => item.id === check.id)?.status, 'pending');
assert.partialDeepStrictEqual(model.c.deliveryCycle, { requests: 1, retry: { status: 'reserved' }, revisionUsed: false });
assert.deepEqual(pendingOwner(model), []);
}

export async function* treatsAQuotationAttributedToTheWrongSourceAsATechnicalFailure() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const check = requestCheck(model);
const [first, ...rest] = accept(model);
yield 'prepared';
assert.equal(report(model, check, [{ ...first!, source: { id: 'wrong-source', quote: '原话' } }, ...rest]).ok, true);
yield 'observed';
assert.equal(model.c.deliveryCycle?.retry?.status, 'reserved');
assert.deepEqual(deliveryJudgments(model.c, model.c.candidate?.revision), []);
assert.equal(model.c.outcome, null);
assert.deepEqual(pendingOwner(model), []);
}

export async function* settlesAnUnverifiedFindingWithoutAutomaticallyRewritingTheCandidate() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const check = requestCheck(model);
const [first, ...rest] = accept(model);
yield 'prepared';
assert.equal(report(model, check, [{ ...first!, status: 'unverified', reason: '没有可核实的原资料' }, ...rest]).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'partial');
assert.partialDeepStrictEqual(deliveryJudgments(model.c, model.c.candidate?.revision)?.[0], { status: 'unverified' });
assert.deepEqual(pendingOwner(model), []);
}

export async function* rechecksEarlierPassingRequirementsAndSettlesANewRegressionAfterTheOnlyCorrection() {
const model = new LocalModel(input => { input.config.limits.checks = 2; });
assert.equal(submit(model).ok, true);
const first = requestCheck(model);
const [a, b] = accept(model);
assert.equal(report(model, first, [{ ...a!, status: 'failed', reason: '把计划写成已完成' }, b!]).ok, true);
const repair = claim(model, 'owner');
assert.partialDeepStrictEqual(submit(model, repair, 'revised', '修订候选'), { ok: true });
const review = requestCheck(model);
yield 'prepared';
assert.equal(report(model, review, [a!, { ...b!, status: 'failed', reason: '修订遗漏此前内容' }]).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'partial');
assert.partialDeepStrictEqual(deliveryJudgments(model.c, model.c.candidate?.revision)?.[1], { reason: '修订遗漏此前内容' });
assert.equal(model.c.usage.checks, 2);
assert.deepEqual(pendingOwner(model), []);
}

export async function* preservesAnAcceptedUserSupplementBeforeReleasingTheCheckedCandidate() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const check = requestCheck(model);
assert.equal(model.send({ type: 'USER_INPUT', text: '补充新的限制' }).ok, true);
yield 'prepared';
assert.equal(report(model, check, accept(model)).ok, true);
yield 'observed';
assert.equal(model.c.outcome, null);
assert.equal(model.c.inputs.every(input => input.applied), true);
assert.equal((pendingOwner(model))?.length, 1);
assert.partialDeepStrictEqual(pendingOwner(model), [{ payload: { reason: 'Apply latest user input' } }]);
}

export async function* retainsTheFindingWhenTheRemainingCheckBudgetCannotReserveAReview() {
const model = new LocalModel(input => { input.config.limits.checks = 1; });
assert.equal(submit(model).ok, true);
const check = requestCheck(model);
const [first, ...rest] = accept(model);
yield 'prepared';
assert.equal(report(model, check, [{ ...first!, status: 'failed', reason: '缺少必需内容' }, ...rest]).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'partial');
assert.equal(deliveryJudgments(model.c, model.c.candidate?.revision)?.[0]?.reason, '缺少必需内容');
assert.deepEqual(pendingOwner(model), []);
}

export async function* sharesOneTechnicalRetryAcrossTheFirstCheckRepairAndReview() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const first = requestCheck(model);
assert.equal(report(model, first).ok, true);
const retry = requestCheck(model);
const [a, b] = accept(model);
assert.equal(report(model, retry, [{ ...a!, status: 'failed', reason: '需要修订' }, b!]).ok, true);
const repair = claim(model, 'owner');
assert.equal(submit(model, repair, 'revised').ok, true);
const review = requestCheck(model);
yield 'prepared';
assert.equal(model.send({ type: 'WORK_FAILED', intentId: review.id, attempt: review.attempt, transient: true, reason: 'network timeout' }).ok, true);
yield 'observed';
assert.equal(model.snapshot.value, 'ended');
assert.equal(model.c.outcome, 'partial');
assert.partialDeepStrictEqual(model.c.deliveryCycle, { requests: 3, retry: { status: 'used' }, revisionUsed: true });
assert.partialDeepStrictEqual(model.c.usage, { checks: 3, retries: 1 });
}

export async function* makesAnAuthorizedRequestSurviveRecoveryWithoutRestoringTheTechnicalRetry() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const original = requestCheck(model);
assert.equal(model.send({ type: 'RECOVER', config: model.c.config }).ok, true);
const replay = requestCheck(model);
yield 'prepared';
assert.equal(model.send({ type: 'RECOVER', config: model.c.config }).ok, true);
yield 'observed';
assert.equal(replay.id, original.id);
assert.equal(model.c.outcome, 'partial');
assert.partialDeepStrictEqual(model.c.usage, { checks: 2, retries: 1 });
}

export async function* spendsNoThirdOrdinaryCheckWhenTrustedSupplementsInterruptTwoCheckedCandidates() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const first = requestCheck(model);
assert.equal(model.send({ type: 'USER_INPUT', text: '补充第一项要求' }).ok, true);
assert.equal(report(model, first, accept(model)).ok, true);
assert.equal(submit(model, claim(model, 'owner'), 'second').ok, true);
const second = requestCheck(model);
assert.equal(model.send({ type: 'USER_INPUT', text: '补充第二项要求' }).ok, true);
assert.equal(report(model, second, accept(model)).ok, true);
yield 'prepared';
assert.equal(submit(model, claim(model, 'owner'), 'third').ok, true);
const third = requestCheck(model);
assert.equal(model.send({ type: 'USER_INPUT', text: '补充第三项要求' }).ok, true);
assert.equal(report(model, third, accept(model)).ok, true);
assert.equal(submit(model, claim(model, 'owner'), 'fourth').ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'partial');
assert.equal(model.c.candidate?.deliveryIssue?.code, 'CHECK_BUDGET_EXHAUSTED');
assert.equal(model.c.usage.checks, 3);
}

export async function* rejectsARepeatedInvalidCheckResultWithoutSettlingTheRetryPermit() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const original = requestCheck(model);
assert.equal(report(model, original).ok, true);
yield 'prepared';
assert.equal(report(model, original).ok, false);
const replay = requestCheck(model);
assert.equal(report(model, replay, accept(model)).ok, true);
yield 'observed';
assert.equal(model.c.outcome, 'complete');
assert.partialDeepStrictEqual(model.c.usage, { checks: 2, retries: 1 });
}

export async function* rejectsARepeatedTransientFailureWithoutSettlingTheRetryPermit() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const original = requestCheck(model);
const failure = { type: 'WORK_FAILED', id: 'network:1', intentId: original.id, attempt: original.attempt, transient: true, reason: 'network timeout' };
assert.equal(model.send(failure).ok, true);
yield 'prepared';
assert.equal(model.send(failure).ok, false);
yield 'observed';
assert.equal(model.c.outcome, null);
assert.equal(model.c.intents.find(work => work.id === original.id)?.status, 'pending');
assert.partialDeepStrictEqual(model.c.usage, { checks: 1, retries: 1 });
}

export async function* appliesATrustedSupplementAfterRestartEvenWhenTheInterruptedCheckHasNoRetryLeft() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const first = requestCheck(model);
assert.equal(report(model, first).ok, true);
requestCheck(model);
assert.equal(model.send({ type: 'USER_INPUT', text: '补充交付要求' }).ok, true);
yield 'prepared';
assert.equal(model.send({ type: 'RECOVER', config: model.c.config }).ok, true);
yield 'observed';
assert.equal(model.snapshot.value, 'running');
assert.equal(model.c.outcome, null);
assert.equal(model.c.inputs[0]?.applied, true);
assert.partialDeepStrictEqual(model.c.usage, { checks: 2, retries: 1 });
assert.equal((pendingOwner(model)).length, 1);
}

export async function* rejectsAResultArrivingAfterTheUserStoppedTheTask() {
const model = new LocalModel();
assert.equal(submit(model).ok, true);
const check = requestCheck(model);
assert.equal(model.send({ type: 'STOP', text: '停止' }).ok, true);
yield 'prepared';
assert.equal(report(model, check, accept(model)).ok, false);
yield 'observed';
assert.equal(model.c.outcome, 'stopped');
assert.equal(model.c.publishedDelivery, undefined);
assert.equal(model.c.usage.checks, 1);
}
