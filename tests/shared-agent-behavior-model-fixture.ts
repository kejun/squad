import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { taskPhase } from '../src/task.machine.js';
import type { CriterionJudgment } from '../src/delivery-acceptance.js';
import { processingWindow, taskHumanGate } from '../src/task/resilience.js';
import type { Intent } from '../src/types.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import { approvalGateDecision } from './host-approval-gate-model-fixture.js';
import { ResilienceModel, resilienceHumanGate, resilienceWindowGate } from './task-resilience-model-fixture.js';

function currentWork(model: ResilienceModel, work: Intent) {
  const saved = model.c.intents.find(item => item.id === work.id);
  assert(saved, 'The original work must remain addressable after persist/restore');
  return saved;
}

function fixedContentJudgment(status: 'passed' | 'unverified') {
  const model = new ResilienceModel(input => {
    input.goal = { text: '核对当前标题', constraints: [], criteria: ['标题为新的标题'], requiredArtifacts: 0 };
  });
  const owner = model.claim();
  assert(model.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '# 新的标题\n当前完整候选正文。', artifactIds: [] }).ok);
  const checker = model.claim('check'), candidate = model.c.candidate!;
  assert.equal(model.phase, 'checking');
  assert(candidate.text.startsWith('# 新的标题'));
  assert(model.send({ type: 'CONSUME', intentId: checker.id, fence: checker }).ok);
  const judgments = fixtureCheck(candidate).criteriaResults.map((judgment, index) => status === 'unverified' && index === 0
    ? { ...judgment, status: 'unverified' as const, reason: '固定材料未提供判断该项所需的原文' } : judgment);
  assert(model.send({ type: 'CHECK_RESULT', workId: checker.id, fence: checker, attempt: checker.attempt,
    candidateRevision: candidate.revision, resultId: `fixed-content:${status}`, criteriaResults: judgments }).ok);
  assert.equal(model.c.outcome, status === 'passed' ? 'complete' : 'partial');
  assert(model.c.intents.every(work => !(work.localOperations?.length)), 'A content judgment needs no invented tool execution');
  assert.equal(currentWork(model, checker).criteriaResults?.[0]?.status, status);
  return { status, outcome: model.c.outcome, toolOperations: 0 };
}

function fixedCheckCannotAcquireEvidence() {
  const model = new ResilienceModel(), owner = model.claim();
  assert(model.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '仅核对固定候选', artifactIds: [] }).ok);
  const checker = model.claim('check'), before = structuredClone(model.c.intents.find(work => work.id === checker.id)!);
  const result = model.send({ type: 'LOCAL_REQUEST', intentId: checker.id, operationId: 'forbidden-read',
    namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), parentAttempt: checker.attempt, fence: checker,
    action: { type: 'readEvidence', sourceOperationId: 'unprovided-source', stream: 'stdout' }, messages: [] });
  assert.equal(result.code, 'CHECK_LOCAL_TOOLS_NOT_ALLOWED');
  assert.deepEqual(currentWork(model, checker), before);
  assert.equal(model.phase, 'checking');
  return { denial: result.code, phase: model.phase };
}

function fixedCheckCitationCatalog(mode: 'candidate' | 'omit' | 'rawInput') {
  const model = new ResilienceModel(input => {
    input.message.text = '把标题改为当前报告，并证明当前测试已经运行通过';
    input.goal = { text: '核对当前报告和测试声明', constraints: [], criteria: ['标题为当前报告', '当前测试已经运行通过'], requiredArtifacts: 1 };
  });
  const content = '# 当前报告\n作者声称测试全部通过，但没有提供执行记录。';
  assert(model.send({ type: 'ARTIFACT', artifact: { id: 'artifact:live', name: 'report.md', content } }).ok);
  const owner = model.claim();
  assert(model.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: content, artifactIds: ['artifact:live'] }).ok);
  const checker = model.claim('check'), candidate = model.c.candidate!;
  assert(Array.isArray(checker.payload.artifacts) && checker.payload.artifacts.some(item => item.id === 'artifact:live'));
  const title = candidate.acceptance!.criteria.find(item => item.text === '标题为当前报告')!;
  const tests = candidate.acceptance!.criteria.find(item => item.text === '当前测试已经运行通过')!;
  assert(title && tests, 'Both independent requirements must exist in the real fixed candidate');
  const rawInputs = checker.payload.rawInputs as { id: string; text: string }[];
  assert(rawInputs.length > 0);
  assert(model.send({ type: 'CONSUME', intentId: checker.id, fence: checker }).ok);
  const criteriaResults: CriterionJudgment[] = fixtureCheck(candidate).criteriaResults.map(judgment => judgment.criterionId === tests.id
    ? { ...judgment, status: 'unverified', reason: '未提供当前测试的执行记录',
      ...(mode === 'candidate' ? { source: { id: 'artifact:live', quote: '作者声称测试全部通过' } }
        : mode === 'rawInput' ? { source: { id: rawInputs[0]!.id, quote: rawInputs[0]!.text } } : {}) }
    : judgment);
  assert(model.send({ type: 'CHECK_RESULT', workId: checker.id, fence: checker, attempt: checker.attempt,
    candidateRevision: candidate.revision, resultId: `citation:${mode}`, criteriaResults }).ok);
  const saved = currentWork(model, checker);
  assert.equal(model.c.artifacts.find(item => item.id === 'artifact:live')!.content, content);
  assert(model.c.intents.every(work => !(work.localOperations?.length)), 'Optional source handling must not acquire more evidence');
  if (mode === 'candidate') {
    assert.equal(saved.checkDiagnostics?.at(-1)?.diagnostic.code, 'CHECK_SOURCE_NOT_FOUND');
    assert.equal(saved.criteriaResults, undefined, 'A rejected citation must not save any of its judgments');
    assert.notEqual(model.c.outcome, 'complete');
    return { mode, diagnostic: 'CHECK_SOURCE_NOT_FOUND', judgmentsSaved: false };
  }
  assert.equal(saved.criteriaResults?.find(item => item.criterionId === title.id)?.status, 'passed');
  assert.equal(saved.criteriaResults?.find(item => item.criterionId === tests.id)?.status, 'unverified');
  assert.equal(model.c.outcome, 'partial');
  assert.equal(saved.criteriaResults?.find(item => item.criterionId === tests.id)?.source?.id,
    mode === 'rawInput' ? rawInputs[0]!.id : undefined);
  return { mode, title: 'passed', tests: 'unverified', outcome: model.c.outcome };
}

function humanDecisionRequiresAnAction() {
  const model = new ResilienceModel(), owner = model.claim();
  assert(model.send({ type: 'BLOCKED', workId: owner.id, fence: owner, reason: '有一项可能需要人类决定的缺口' }).ok);
  assert.equal(taskHumanGate(model.c), undefined, 'A technical blocking description is not an answered human decision');
  assert.equal(model.phase, 'coordinating');
  const facilitator = model.claim('facilitator');
  assert(model.send({ type: 'COORDINATE', workId: facilitator.id, fence: facilitator,
    decision: { action: 'askUser', question: '请选择确切的数据来源', reason: '该选择实质影响交付目标' } }).ok);
  const gate = structuredClone(taskHumanGate(model.c)!);
  assert.equal(model.phase, 'waitingHuman'); assert.equal(gate.question, '请选择确切的数据来源'); assert.equal(gate.status, 'open');
  assert(model.send({ type: 'ACTIVITY', text: '日志中再次描述需要用户回应' }).ok);
  model.supervise(101);
  assert.equal(model.phase, 'waitingHuman'); assert.equal(taskHumanGate(model.c)?.id, gate.id);
  assert.equal(taskHumanGate(model.c)?.status, 'open'); assert.equal(model.c.outcome, null);
  return { gate: gate.id, phase: model.phase, status: taskHumanGate(model.c)?.status };
}

function assistancePreservesPartialProvenance() {
  const model = new ResilienceModel(), owner = model.claim();
  assert(model.send({ type: 'HELP', workId: owner.id, fence: owner, requestId: 'shared-help', caller: 'A', target: 'B',
    question: '核对指定来源', expected: '报告实际范围和缺口', refs: [] }).ok);
  const member = model.claim('assistance');
  const answer = 'B仅核对了前两项，第三项缺少原文；不能汇总为全部通过';
  const recorded = model.send({ type: 'RECORD_RESULT', requestId: 'shared-help', resultId: 'partial-report', workId: member.id, fence: member,
    status: 'partial', answer });
  assert(recorded.ok, recorded.code);
  assert(model.send({ type: 'HELP_RESULT', requestId: 'shared-help', resultId: 'partial-report', status: 'partial', answer }).ok);
  const report = model.c.assists.find(item => item.id === 'shared-help')!;
  const resumed = model.pending('owner')[0]!;
  assert.equal(report.target, 'B'); assert.equal(report.status, 'partial'); assert.equal(report.answer, answer);
  assert.equal(resumed.payload.status, 'partial'); assert.equal(resumed.payload.requiresAssessment, true);
  assert.equal(model.phase, 'running'); assert.equal(model.c.outcome, null); assert.equal(model.c.assists.length, 1);
  return { source: report.target, status: report.status, requiresAssessment: resumed.payload.requiresAssessment };
}

function unknownEffectDoesNotBecomeAFailedAttempt() {
  const model = new ResilienceModel(); model.artifact('known-material'); const work = model.unknown();
  const original = structuredClone(currentWork(model, work).localOperations![0]!);
  const duplicate = model.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: original.id, sessionId: 'replacement-session',
    parentAttempt: work.attempt, fence: work, leaseAvailable: true });
  assert.equal(duplicate.code, 'WORK_NOT_INFLIGHT');
  const alternative = model.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'same-effect-other-tool',
    namespace: 'c'.repeat(64), requestHash: 'b'.repeat(64), parentAttempt: work.attempt, fence: work, workspaceId: 'resource',
    action: { type: 'runCli', executable: 'another-tool', args: ['same-effect'] }, messages: [] });
  assert.equal(alternative.code, 'WORK_NOT_INFLIGHT');
  assert.deepEqual(currentWork(model, work).localOperations, [original]);
  model.endWindow(101);
  assert.equal(model.c.outcome, 'partial'); assert.equal(model.c.resilience!.cleanup[0]!.state, 'pending');
  assert.equal(currentWork(model, work).localOperations![0]!.status, 'uncertain');
  return { unknownStatus: original.status, noReplacementOperation: true, outcome: model.c.outcome, custody: 'pending' };
}

function cancellationIsNotPhysicalSettlement() {
  const model = new LocalModel(); assert(model.request().ok); assert(model.claim().ok); assert(model.started().ok);
  assert(model.send({ type: 'STOP' }).ok);
  assert.equal(taskPhase(model.snapshot), 'ended'); assert.equal(model.c.outcome, 'stopped');
  assert.equal(model.op!.status, 'cancelling');
  assert.equal(model.send({ type: 'SETTLE', intentId: model.work.id }).code, 'LOCAL_OPERATION_PENDING');
  assert.equal(model.c.resilience!.cleanup.find(item => item.operationId === model.op!.id)?.state, 'pending');
  assert.equal(model.op!.result, undefined);
  return { logical: model.c.outcome, physical: model.op!.status, custody: 'pending' };
}

function clarificationKeepsTheExistingProtocol() {
  const interpretation = { ...capacityModelIntent(), confidence: 0.5, clarification: null, decomposition: null };
  const invalid = new CapacityModel(input => { input.config.resilience = { automaticTimeoutMs: 100 }; });
  invalid.claim(); invalid.consume();
  assert.equal(invalid.interpret(interpretation).code, 'INVALID_INPUT_INTENT');
  assert.equal(invalid.context.candidate, null);
  const model = new CapacityModel(input => { input.config.resilience = { automaticTimeoutMs: 100 }; });
  model.claim(); model.consume();
  assert(model.interpret({ ...interpretation, clarification: '请明确当前要保留的来源范围' }).ok);
  assert.equal(taskPhase(model.snapshot), 'waitingHuman'); assert.equal(taskHumanGate(model.context)?.kind, 'clarification');
  assert.equal(processingWindow(model.context).hardDeadline, 100);
  return { confidence: 0.5, clarificationRequiredByExistingProtocol: true, phase: taskPhase(model.snapshot) };
}

/** Existing host boundaries, not a measurement of whether an LLM obeys the new text. */
export function verifySharedAgentBehaviorModel() {
  const cases: [string, () => unknown][] = [
    ['content-judgment-without-tool-execution', () => fixedContentJudgment('passed')],
    ['missing-fixed-source-remains-unverified', () => fixedContentJudgment('unverified')],
    ['fixed-check-cannot-acquire-new-evidence', fixedCheckCannotAcquireEvidence],
    ['human-question-is-durable-action-not-description', humanDecisionRequiresAnAction],
    ['partial-member-report-is-not-owner-independent-verification', assistancePreservesPartialProvenance],
    ['unknown-external-effect-is-not-replayed', unknownEffectDoesNotBecomeAFailedAttempt],
    ['cancellation-does-not-prove-process-settlement', cancellationIsNotPhysicalSettlement],
    ['normal-recovery-does-not-renew-window', () => { const model = resilienceWindowGate(); return { deadline: processingWindow(model.c).hardDeadline, outcome: model.c.outcome }; }],
    ['required-human-silence-does-not-consent', () => { const model = resilienceHumanGate(); return { deadline: processingWindow(model.c).hardDeadline, outcome: model.c.outcome }; }],
    ['ordinary-report-does-not-grant-host-approval', () => approvalGateDecision('门的普通回复')],
    ['supplement-does-not-grant-host-approval', () => approvalGateDecision('普通用户补充')],
    ['existing-confidence-protocol-is-not-redefined', clarificationKeepsTheExistingProtocol],
    ['fixed-check-citation-catalog-and-optional-omission', () => (['candidate', 'omit', 'rawInput'] as const).map(fixedCheckCitationCatalog)],
  ];
  return { model: 'real taskMachine; persist/restore at every event', scope: 'host protocol and lifecycle compatibility, not model semantic effectiveness',
    results: cases.map(([name, run]) => ({ name, observed: run() })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifySharedAgentBehaviorModel(), null, 2));
