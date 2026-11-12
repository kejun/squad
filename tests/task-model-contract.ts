import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initialTask, stepTask, persistTask, restoreTask, taskMachine, type TaskSnapshot } from '../src/task.machine.js';
import { inspectInitialTask, inspectTask, type DebugEvidence } from '../src/task-inspection.js';
import { taskGraph, type MachineGraph, type MachineTransition } from '../src/task-structure.js';
import { capabilities, completeProblem } from '../src/task/facts.js';
import { conversationInput, deliveryArtifacts } from '../src/task/operations.js';
import { localEnabled } from '../src/local-operation.js';
import type { Candidate, Intent, Phase, TaskContext, TaskEvent, TaskInput } from '../src/types.js';

interface Frame { digest: string; phase: Phase; usage: TaskContext['usage']; reply: TaskContext['reply']; evidence: DebugEvidence }
interface Trace { name: string; input: TaskInput; events: TaskEvent[]; frames: Frame[] }
interface LegacyContract { schema: 1; sourceSha: string; xstate: string; graph: MachineGraph; seeds: Record<Phase, unknown>; savedResult: unknown; traces: Trace[] }
export const legacyTaskContract = JSON.parse(readFileSync(new URL('./fixtures/task-model-v1.json', import.meta.url), 'utf8')) as LegacyContract;
assert.equal(legacyTaskContract.sourceSha, 'dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9');
// Approval and host retry extensions add rules without changing the original frozen business traces.
// BT_M23–M29 add one explanation action to the existing current-coordination rejection.
// KEJ-111 adds one explicit host-only failure-record event; frozen business traces remain intact.
const extendedDefinition = '5a6c24ef';
const toolFailureRules = [
  { id: '*:RECORD_TOOL_FAILURE:0', order: 0, source: '*', event: 'RECORD_TOOL_FAILURE', target: null, guards: ['valid'], actions: ['apply'] },
  { id: '*:RECORD_TOOL_FAILURE:1', order: 1, source: '*', event: 'RECORD_TOOL_FAILURE', target: null, guards: [], actions: ['reject'] },
];
const lifecycleRules = [
  { id: '*:@always:0', order: 0, source: '*', event: '@always', target: null, guards: ['hostRetryBatchNeedsSync'], actions: ['syncHostRetryBatch'] },
  { id: '*:@always:1', order: 1, source: '*', event: '@always', target: null, guards: ['mapQueueNeedsProgress'], actions: ['advanceMapQueue'] },
];
const shiftedGlobal = (id: string) => id.startsWith('*:@always:') ? `*:@always:${Number(id.split(':').at(-1)) + 2}` : id;
const coordinationRejectionId = 'coordinating:COORDINATE:6';
const sessionRules = [
  { id: '*:REVOKE_HOST_SESSION:0', order: 0, source: '*', event: 'REVOKE_HOST_SESSION', target: null, guards: ['valid'], actions: ['apply'] },
  { id: '*:REVOKE_HOST_SESSION:1', order: 1, source: '*', event: 'REVOKE_HOST_SESSION', target: null, guards: [], actions: ['reject'] },
];
const hostRetryRules = [
  { id: '*:REQUEST_HOST_RETRY:0', order: 0, source: '*', event: 'REQUEST_HOST_RETRY', target: 'running', guards: ['reactivateHostRetry'], actions: ['apply'] },
  { id: '*:REQUEST_HOST_RETRY:1', order: 1, source: '*', event: 'REQUEST_HOST_RETRY', target: null, guards: ['valid'], actions: ['apply'] },
  { id: '*:REQUEST_HOST_RETRY:2', order: 2, source: '*', event: 'REQUEST_HOST_RETRY', target: null, guards: [], actions: ['reject'] },
  { id: '*:HOST_RETRY_RECONCILE:0', order: 0, source: '*', event: 'HOST_RETRY_RECONCILE', target: null, guards: ['valid'], actions: ['apply'] },
  { id: '*:HOST_RETRY_EXPIRE:0', order: 0, source: '*', event: 'HOST_RETRY_EXPIRE', target: null, guards: ['valid'], actions: ['apply'] },
  { id: '*:LOCAL_RETRY_EXPIRED:0', order: 0, source: '*', event: 'LOCAL_RETRY_EXPIRED', target: null, guards: ['valid'], actions: ['apply'] },
  { id: '*:LOCAL_RETRY_EXPIRED:1', order: 1, source: '*', event: 'LOCAL_RETRY_EXPIRED', target: null, guards: [], actions: ['reject'] },
];
const hostRetryAlwaysRules = [
  { id: '*:@always:2', order: 2, source: '*', event: '@always', target: 'running', guards: ['hostRetryReady'], actions: ['startHostRetry'] },
  { id: '*:@always:3', order: 3, source: '*', event: '@always', target: 'ended', guards: ['hostRetryBoundary'], actions: ['failHostRetry'] },
  { id: '*:@always:4', order: 4, source: '*', event: '@always', target: null, guards: ['hostRetryBatchRetirable'], actions: ['retireHostRetry'] },
];
const heldFinish = { id: 'coordinating:COORDINATE:4', order: 4, source: 'coordinating', event: 'COORDINATE', target: 'running', guards: ['hostRetryHoldsFinish'], actions: ['apply'] };
const rules = (source: string, event: string, branches: [string | null, string | null, string?][]) => branches.map(([guard, target, action], order) => ({
  id: `${source}:${event}:${order}`, order, source, event, target, guards: guard ? [guard] : [], actions: [action ?? 'apply'],
}));
const localResumeRules: [string | null, string | null][] = [
  ['localResumeOwner', 'running'], ['localResumeHelp', 'waitingAssistance'], ['localResumeFacilitator', 'coordinating'],
  ['localCheckExhausted', 'ended'], ['localResumeCheck', 'checking'],
];
const localEndRules: [string | null, string | null, string?][] = [['valid', null], [null, null, 'reject']];
const checkSettleRules = rules('checking', 'SETTLE', [['settlingCheckHandoff', 'running'], ['settlingCheck', 'ended'], ['valid', null]]);
const boundedTransitions = [
  rules('running', 'DELIVER', [['holdingDelivery', null], ['deliveryReady', 'checking'], ['deliveryCanRevise', null], ['valid', 'ended']]),
  rules('running', 'BLOCKED', [['revisionFailed', 'ended'], ['canCoordinate', 'coordinating'], ['valid', null]]),
  rules('running', 'WORK_FAILED', [['failedDiscussion', null], ['retryable', null], ['revisionFailed', 'ended'], ['valid', 'waitingHuman']]),
  rules('checking', 'CLAIM', [['claimCheckUnavailable', 'ended', 'failCheckClaim'], ['claimCheck', null]]),
  rules('checking', 'CHECK_RESULT', [['checkCanRetry', null], ['checkContinues', 'running'], ['valid', 'ended']]),
  rules('checking', 'WORK_FAILED', [['failedDiscussion', null], ['checkFailureHandoff', 'running'], ['retryable', null], ['checkFailed', 'ended'], ['valid', 'waitingHuman']]),
  rules('*', 'RECOVER', [['recoveredCheckExhausted', 'ended'], ['recoveredSafe', null], [null, 'waitingHuman']]),
  rules('*', 'LOCAL_RESULT', [...localResumeRules, ['uncertainLocalResult', 'waitingHuman'], ...localEndRules]),
  rules('*', 'LOCAL_RECONCILE', [...localResumeRules, ...localEndRules]),
];
const boundedRules = (source: string, event: string) => boundedTransitions.find(group => group[0]?.source === source && group[0]?.event === event);
function nextRuleId(ruleId: string) {
  const parts = ruleId.split(':');
  parts[parts.length - 1] = String(Number(parts.at(-1)) + 1);
  return parts.join(':');
}
const approvalRules = ['LOCAL_APPROVAL_REQUIRED', 'LOCAL_APPROVAL_DECISION', 'LOCAL_APPROVAL_EXPIRED'].flatMap(event => [
  { id: `*:${event}:0`, order: 0, source: '*', event, target: null, guards: ['valid'], actions: ['apply'] },
  { id: `*:${event}:1`, order: 1, source: '*', event, target: null, guards: [], actions: ['reject'] },
]);
const supervisionActions: Record<string, string> = { interpreting: 'superviseInterpreting', running: 'superviseRunning',
  waitingAssistance: 'superviseAssistance', coordinating: 'superviseCoordinating', waitingHuman: 'superviseHuman',
  checking: 'superviseChecking', stopping: 'superviseStopping', ended: 'superviseEnded' };
/** Exact structural extension; unexpected old/new rules remain in the equality comparison. */
function resilienceTransitions(base: MachineTransition[]): MachineTransition[] {
  const added = [
    ...rules('*', 'RECORD_ACQUISITION', [['valid', null], [null, null, 'reject']]),
    ...rules('*', 'HUMAN_GATE_DECISION', [['gateReplyExpired', 'waitingHuman'], ['gateDecisionEnds', 'ended'], ['gateDecisionHelp', 'waitingAssistance'], ['gateDecisionTask', 'running'], ['valid', null], [null, null, 'reject']]),
  ];
  const seen = new Set<string>();
  for (const row of base) {
    if (row.source !== '*' && !seen.has(row.source)) {
      seen.add(row.source);
      const action = supervisionActions[row.source]; assert(action);
      added.push(...rules(row.source, 'SUPERVISE', [['supervisionEnds', 'ended', action],
        ['supervisionWaitsForHuman', 'waitingHuman', action],
        ['supervisionRepairs', 'coordinating', action], [null, null, action]]));
    }
    if (row.source === '*' && row.event === 'LOCAL_STARTED' && row.order === 0)
      added.push(...rules('*', 'LOCAL_PREPARED', [['valid', null], [null, null, 'reject']]));
    if (row.source === '*' && row.event === 'LOCAL_APPROVAL_DECISION') {
      if (row.order === 0) added.push(...rules('*', row.event, [['approvalDecisionEnds', 'waitingHuman'],
        ['localResumeOwner', 'running'], ['localResumeHelp', 'waitingAssistance'], ['localResumeFacilitator', 'coordinating'],
        ['localResumeCheck', 'checking'], ['valid', null], [null, null, 'reject']]));
      continue;
    }
    let shift = 0;
    const prefixes: Record<string, [string, string][]> = {
      HUMAN_DECISION: [['humanDecisionExpired', 'waitingHuman']], USER_INPUT: [['directHumanResponseExpired', 'waitingHuman']],
      RETRY_ASSISTANCE: [['directHumanResponseExpired', 'waitingHuman']],
      RECOVER: [['recoverStopped', 'ended'], ['recoverIncompatible', 'waitingHuman'], ['activeWindowExpired', 'waitingHuman'], ['hasTaskHumanGate', 'waitingHuman']], EXHAUSTED: [['activeWindowExpired', 'waitingHuman'], ['hasTaskHumanGate', 'waitingHuman']],
    };
    const prefix = row.source === '*' ? prefixes[row.event] : undefined;
    if (prefix) {
      if (row.order === 0) added.push(...rules(row.source, row.event, prefix));
      shift = prefix.length;
    }
    if (row.source === 'running' && row.event === 'DELIVER' || row.source === 'coordinating' && row.event === 'COORDINATE'
      || row.source === 'checking' && ['CHECK_RESULT', 'SETTLE'].includes(row.event)) {
      if (row.order === 0) added.push(...rules(row.source, row.event, [['businessBlockedByHuman', 'waitingHuman']]));
      shift++;
    }
    if (row.source === 'stopping' && row.event === '@always') {
      if (row.order === 0) added.push({ id: 'stopping:@always:0', source: 'stopping', event: '@always', order: 0, target: 'ended', guards: ['logicalStopped'], actions: [] });
      shift = 1;
    }
    if (row.source === 'ended' && row.event === 'CLAIM') {
      if (row.order === 0) added.push(...rules('ended', 'CLAIM', [['claimCancel', null]]));
      shift = 1;
    }
    const retryAt = row.source === 'checking' ? 2 : 1;
    if (row.event === 'WORK_FAILED' && row.source !== 'stopping') {
      if (row.order === 0) added.push(...rules(row.source, row.event, [['windowFailed', 'waitingHuman'], ['approvalBlockedFailure', 'waitingHuman']]));
      shift = 2 + Number(row.source !== '*' && row.order > retryAt);
    }
    const projected = { ...row, order: row.order + shift, id: `${row.source}:${row.event}:${row.order + shift}` };
    added.push(projected);
    if (row.event === 'WORK_FAILED' && row.guards.includes('retryable')) added.push({ id: `${row.source}:WORK_FAILED:${row.order + 3}`,
      source: row.source, event: row.event, order: row.order + 3, target: null, guards: ['safeFailureRetry'], actions: ['apply'] });
  }
  return added;
}
function beforeResilienceEvidence(actual: DebugEvidence, label: string, salvage: boolean): DebugEvidence {
  assert.equal(actual.definition, taskGraph().definition);
  const inserted = new Set(['windowFailed', 'activeWindowExpired', 'gateReplyExpired', 'recoverIncompatible', 'businessBlockedByHuman', 'approvalBlockedFailure', 'approvalDecisionEnds', 'directHumanResponseExpired', 'humanDecisionExpired', 'recoverStopped', 'hasTaskHumanGate', 'logicalStopped', 'safeFailureRetry']);
  const evaluations = actual.evaluations.flatMap(row => {
    if (row.guard === 'recoverIncompatible' && row.passed) {
      assert(label.startsWith('不兼容恢复:') && row.event === 'RECOVER' && row.source === '*', `${label}: unexpected incompatible recovery`);
      // The explicit early recovery gate replaces the original equivalent false/false/fallback branch.
      // Its cause, decisions and public RECOVER origin are independently checked in assertFrame.
      return [
        { ...row, ruleId: '*:RECOVER:0', guard: 'recoveredCheckExhausted', passed: false },
        { ...row, ruleId: '*:RECOVER:1', guard: 'recoveredSafe', passed: false },
        { ...row, ruleId: '*:RECOVER:2', guard: null, passed: true },
      ];
    }
    if (row.guard && inserted.has(row.guard)) { assert.equal(row.passed, false, `${label}: new guard changes this frozen trace`); return []; }
    const parts = row.ruleId.split(':'); let order = Number(parts.at(-1));
    if (row.source === 'running' && row.event === 'DELIVER' || row.source === 'coordinating' && row.event === 'COORDINATE'
      || row.source === 'checking' && ['CHECK_RESULT', 'SETTLE'].includes(row.event)) order--;
    if (row.source === '*' && ['HUMAN_DECISION', 'USER_INPUT', 'RETRY_ASSISTANCE'].includes(row.event) || row.source === 'stopping' && row.event === '@always') order--;
    if (row.source === '*' && row.event === 'RECOVER') order -= 4;
    if (row.source === '*' && row.event === 'EXHAUSTED') order -= 2;
    if (row.event === 'WORK_FAILED' && row.source !== 'stopping') order -= 2;
    if (row.event === 'WORK_FAILED' && row.source !== '*' && row.source !== 'stopping' && order > (row.source === 'checking' ? 3 : 2)) order--;
    return [{ ...row, ruleId: `${row.source}:${row.event}:${order}` }];
  });
  const changed = (keys: string[]) => keys.filter(key => key !== 'resilience' && !(salvage && key === 'artifacts'));
  return { ...actual, definition: extendedDefinition, evaluations, changed: changed(actual.changed),
    microsteps: actual.microsteps.map(step => ({ ...step, changed: changed(step.changed) })) };
}
function assertLegacyEvidence(actualRaw: DebugEvidence, expected: DebugEvidence, label: string, published = false, checkClaim = false, salvage = false) {
  const actual = beforeResilienceEvidence(actualRaw, label, salvage);
  assert.equal(actual.definition, extendedDefinition);
  const evaluations = expected.evaluations.flatMap((evaluation, index) => {
    const group = boundedRules(evaluation.source, evaluation.event);
    if (group) {
      const observe = (order: number, passed: boolean) => ({ ...evaluation, ruleId: group[order]!.id, guard: group[order]!.guards[0] ?? null, passed });
      const order = Number(evaluation.ruleId.split(':').at(-1));
      if (evaluation.event === 'DELIVER') {
        if (order === 0) return [observe(0, evaluation.passed)];
        return evaluation.passed ? [observe(1, true)] : [observe(1, false), observe(2, false), observe(3, false)];
      }
      if (evaluation.event === 'CHECK_RESULT') return order === 0 ? [observe(0, false), observe(1, false), observe(2, true)] : [];
      if (evaluation.event === 'LOCAL_RESULT' || evaluation.event === 'LOCAL_RECONCILE') {
        if (order < 3) return [evaluation];
        return order === 3 ? [observe(3, false), observe(4, evaluation.passed)] : [observe(order + 1, evaluation.passed)];
      }
      if (evaluation.event === 'WORK_FAILED') return order < 2 ? [evaluation] : [observe(2, false), observe(3, evaluation.passed)];
      return order === 0 ? [observe(0, false), observe(1, evaluation.passed)] : [observe(order + 1, evaluation.passed)];
    }
    if (evaluation.source === heldFinish.source && evaluation.event === heldFinish.event && Number(evaluation.ruleId.split(':').at(-1)) >= heldFinish.order) {
      const first = !expected.evaluations.slice(0, index).some(previous => previous.ruleId === heldFinish.id);
      return [...(first ? [{ ...evaluation, ruleId: heldFinish.id, guard: heldFinish.guards[0]!, passed: false }] : []),
        { ...evaluation, ruleId: nextRuleId(evaluation.ruleId) }];
    }
    return evaluation.ruleId === '*:@always:1' && evaluation.passed === false ? [evaluation,
      ...hostRetryAlwaysRules.map(rule => ({ ...evaluation, ruleId: rule.id, guard: rule.guards[0], passed: false }))] : [evaluation];
  });
  const lifecycleEvaluations = evaluations.flatMap(evaluation => [
    ...(evaluation.ruleId === '*:@always:0' ? lifecycleRules.map(rule => ({ ...evaluation, ruleId: rule.id, guard: rule.guards[0]!, passed: false })) : []),
    { ...evaluation, ruleId: shiftedGlobal(evaluation.ruleId) },
  ]);
  const comparable = (keys: string[]) => keys.filter(key => key !== 'deliveryCycle');
  const expectedKeys = (keys: string[]) => checkClaim ? keys.filter(key => key !== 'usage')
    : published && keys.includes('outcome') ? [...keys, 'publishedDelivery'] : keys;
  assert.deepEqual({ ...actual, changed: comparable(actual.changed), microsteps: actual.microsteps.map(step => ({ ...step, changed: comparable(step.changed) })) },
    { ...expected, definition: extendedDefinition, evaluations: lifecycleEvaluations, changed: expectedKeys(expected.changed),
      microsteps: expected.microsteps.map(step => ({ ...step, changed: expectedKeys(step.changed) })) }, label);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)]));
  return value;
}
// The actor refactor adds the explicitly specified execution tree. The frozen *business*
// snapshot remains unchanged; validate the added native structure before excluding it from that comparison.
export function businessSnapshot(snapshot: TaskSnapshot): unknown {
  const value = JSON.parse(JSON.stringify(persistTask(snapshot)));
  for (const [id, raw] of Object.entries(value.children)) {
    const child = raw as { src: string; snapshot: { context: { intentId: string; attempt: number }; value: string } };
    assert.equal(child.src, 'execution');
    const work = snapshot.context.intents.find(work => work.id === child.snapshot.context.intentId);
    assert(work, id); assert(child.snapshot.context.attempt <= work.attempt);
    assert.equal(id, `execution:${work.id}:${child.snapshot.context.attempt}`);
    assert(['authorized', 'running', 'cancelling', 'uncertain', 'settled', 'cancelled', 'interrupted'].includes(child.snapshot.value));
  }
  return { ...value, children: {} };
}
export function snapshotDigest(snapshot: TaskSnapshot): string {
  // Persisted JSON omits undefined properties; property insertion order is not part of its contract.
  return digest(businessSnapshot(snapshot));
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function restoreLegacyTask(phase: Phase): TaskSnapshot {
  const saved = structuredClone(legacyTaskContract.seeds[phase]);
  assert(saved, phase);
  const snapshot = restoreTask(saved);
  assert.deepEqual(businessSnapshot(snapshot), saved);
  assert.equal(snapshot.value, phase);
  return snapshot;
}
type FacilitatorOwners = Map<string, string>;
type HistoricalChecks = Map<string, Intent['payload']>;
const replayRequestPrefix = 'replay-check-request:';

/** Remember the retired check payload only for the frozen digest comparison. */
function recordCreatedChecks(snapshot: TaskSnapshot, checks: HistoricalChecks) {
  const c = snapshot.context;
  for (const work of c.intents) {
    if (work.kind !== 'check' || checks.has(work.id)) continue;
    assert.equal(work.payload.deliveryProtocol, 'bounded');
    assert.deepEqual(work.payload.candidate, c.candidate);
    assert.deepEqual(work.payload.priorFindings, []);
    assert.deepEqual(work.payload.artifacts, deliveryArtifacts(c).artifacts);
    const rawInputs = work.payload.rawInputs as { id: string; text: string }[];
    const trusted = new Map(c.messages.filter(item => item.author === 'user').map(item => [item.id, item.text]));
    for (const input of c.inputAnalyses ?? []) trusted.set(input.id, input.rawText);
    assert(Array.isArray(rawInputs) && rawInputs.every(input => trusted.get(input.id) === input.text));
    assert.equal(work.requestCount, 0);
    checks.set(work.id, structuredClone({ goal: c.goal, ...deliveryArtifacts(c), board: c.board, ...conversationInput(c),
      deterministicGap: completeProblem(c), capabilities: { ...capabilities(c, work.target), localTools: localEnabled(c.config, work.target) } }));
  }
}

function boundCheckResult(snapshot: TaskSnapshot, event: TaskEvent): TaskEvent {
  if (event.type !== 'CHECK_RESULT') return event;
  const { passed, gaps, ...envelope } = event;
  assert.equal(passed, true);
  assert.deepEqual(gaps, []);
  const candidate = snapshot.context.candidate;
  const work = snapshot.context.intents.find(item => item.id === event.workId && item.kind === 'check');
  assert(candidate?.acceptance && candidate.revision && work);
  return { ...envelope, attempt: work.attempt, candidateRevision: candidate.revision,
    criteriaResults: candidate.acceptance.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed' })) };
}

function checkAuthorization(snapshot: TaskSnapshot, event: TaskEvent): TaskEvent | undefined {
  if (event.type !== 'CLAIM') return undefined;
  const work = snapshot.context.intents.find(item => item.id === event.intentId && item.kind === 'check');
  if (!work) return undefined;
  return { type: 'CONSUME', id: `${replayRequestPrefix}${event.id}`, at: event.at, intentId: work.id, attempt: work.attempt,
    fence: { epoch: work.epoch, goalVersion: work.goalVersion } };
}

function recordCreatedFacilitators(snapshot: TaskSnapshot, owners: FacilitatorOwners) {
  for (const work of snapshot.context.intents) {
    if (work.kind === 'facilitator' && !owners.has(work.id)) owners.set(work.id, snapshot.context.owner);
  }
}
function assertFrame(snapshot: TaskSnapshot, expected: Frame, label: string, owners: FacilitatorOwners, checks: HistoricalChecks = new Map()) {
  assert.equal(snapshot.value, expected.phase, label);
  assert.deepEqual(snapshot.context.usage, expected.usage, label);
  assert.deepEqual(snapshot.context.reply, expected.reply, label);
  const value = businessSnapshot(snapshot) as { context: TaskContext };
  // Assert the new identifiers and publication, then compare all remaining legacy data byte-for-byte by digest.
  const { context } = value;
  // KEJ-113 adds independently checked supervision facts. The retired frozen
  // model is unchanged: compare all old fields after validating this extension.
  const resilience = context.resilience;
  assert(resilience, `${label}: newly evaluated task must preserve its fixed window`);
  const createdAt = context.messages[0]!.at;
  assert.deepEqual(resilience.window, { id: `${context.taskId}:window:initial`, openedAt: createdAt,
    hardDeadline: createdAt + 10_800_000, repairUsed: 0, repairLimit: 2 }, label);
  assert.deepEqual(resilience.skips, [], label); assert.deepEqual(resilience.cleanup, [], label);
  assert.equal(resilience.lastSupervisedAt, undefined, label); assert.equal(resilience.frozenHistory, undefined, label);
  for (const gate of resilience.gates) {
    assert.equal(gate.scope, 'task'); assert.equal(gate.required, true); assert.equal(gate.windowId, resilience.window.id);
    if (gate.cause === 'incompatibleExecution') {
      assert(label.startsWith('不兼容恢复:')); assert.equal(gate.kind, 'recovery'); assert.deepEqual(gate.decisions, ['skip', 'stop']);
      assert.equal(gate.status, 'open'); assert.equal(context.reason, 'Execution version incompatible');
      assert.equal(gate.question, '当前宿主不支持原执行协议。请跳过剩余业务并交付缺口，或停止；需要继续请建立当前配置的新任务。');
      assert(context.trace.some(entry => entry.event === 'RECOVER' && gate.id === `${context.taskId}:gate:${entry.detail}:task`));
    } else {
      assert(context.trace.some(entry => ['WAIT_USER', 'COORDINATE', 'INTERPRETATION_RESULT'].includes(entry.event)
        && gate.id === `${context.taskId}:gate:${entry.detail}:task`), `${label}: gate must originate from a real question`);
      assert(context.messages.some(item => item.text.includes(gate.question) || item.detailText?.includes(gate.question)), label);
    }
    assert(gate.epoch <= context.epoch && gate.goalVersion <= context.goalVersion);
    if (gate.status !== 'open') assert(context.trace.some(entry => entry.detail === gate.responseId && entry.at === gate.resolvedAt));
  }
  const continued = context.trace.filter(entry => entry.event === 'CONTINUE').at(-1);
  assert.equal(resilience.nextSupervisionAt, resilience.frozen || resilience.gates.some(gate => gate.status === 'open') ? null
    : (continued?.at ?? createdAt) + 30_000, label);
  if (resilience.frozen) {
    // This one original trace intentionally gains a standalone failed report.
    // Validate the new report completely before projecting it to its old final notice.
    assert(label.startsWith('普通额度耗尽:'), `${label}: unexpected business change in frozen trace`);
    assert.equal(context.outcome, 'failed'); assert.equal(resilience.frozen.outcome, 'failed');
    assert.equal(resilience.frozen.verification, 'incomplete'); assert.deepEqual(resilience.frozen.cleanupIds, []);
    assert.deepEqual(resilience.frozen.items, []); assert.deepEqual(resilience.frozen.skippedIds, []);
    const report = context.artifacts.find(artifact => artifact.id === resilience.frozen!.reportArtifactId);
    assert(report && report.content === resilience.frozen.text && report.content.includes('状态：failed'));
    assert.deepEqual(resilience.frozen.artifactIds, [report.id]);
    assert.equal(context.artifacts.length, 1); context.artifacts = [];
    const final = context.messages.find(item => item.kind === 'final'); assert(final);
    assert.equal(final.author, 'facilitator'); assert.equal(final.detailText ?? final.text, report.content); assert.deepEqual(final.artifactIds, [report.id]);
    final.author = context.owner; final.text = context.reason; final.artifactIds = []; delete final.detailText;
  }
  delete context.resilience;
  const cycle = context.deliveryCycle;
  assert(cycle, label);
  assert.equal(cycle.requests, expected.usage.checks, label);
  assert.equal(cycle.retry, undefined, label);
  delete context.deliveryCycle;
  context.trace = context.trace.filter(entry => entry.event !== 'CONSUME' || !entry.detail.startsWith(replayRequestPrefix));
  for (const work of context.intents.filter(item => item.kind === 'check')) {
    const historic = checks.get(work.id);
    assert(historic, `${label}: check ${work.id} was never created`);
    assert.equal(work.requestCount, expected.usage.checks, label);
    if (context.outcome === 'complete') {
      const criteria = context.candidate?.acceptance?.criteria;
      assert(criteria?.length, label);
      assert.deepEqual(work.criteriaResults, criteria.map(item => ({ criterionId: item.id, status: 'passed' })), label);
    } else assert.equal(work.criteriaResults, undefined, label);
    work.payload = structuredClone(historic);
    work.requestCount = 0;
    delete work.criteriaResults;
  }
  const revisions = new Set(context.trace.filter(entry => entry.event === 'DELIVER').map(entry => `${context.taskId}:candidate:${entry.detail}`));
  const candidates = [context.candidate, ...context.intents.map(item => item.payload.candidate as Candidate | undefined)];
  for (const candidate of candidates) if (candidate?.revision) {
    assert(revisions.has(candidate.revision), `${label}: candidate identity must reference a delivered event`);
    if (candidate.requiresBoundCheck !== undefined) assert.equal(candidate.requiresBoundCheck, true);
    if (candidate.acceptance) {
      assert.equal(candidate.acceptance.revision, candidate.revision, label);
      assert(candidate.acceptance.criteria.length > 0, label);
    }
    delete candidate.acceptance;
    delete candidate.revision;
    delete candidate.requiresBoundCheck;
  }
  if (context.outcome === 'complete') {
    const published = context.publishedDelivery;
    assert(published && context.candidate && published.revision === snapshot.context.candidate?.revision);
    assert.deepEqual(published.artifactIds, context.candidate.artifactIds);
    assert.equal(published.goalVersion, context.goalVersion);
    assert.equal(published.at, context.trace.filter(entry => entry.event === 'CHECK_RESULT').at(-1)?.at);
    delete context.publishedDelivery;
  }
  // The facilitator owner remains pinned to the moment the work was created.
  for (const [id, owner] of owners) {
    const work = value.context.intents.find(item => item.id === id);
    assert(work?.kind === 'facilitator', `${label}: missing facilitator ${id}`);
    assert.equal(work.payload.owner, owner, `${label}: facilitator ${id} must retain its creation owner`);
    delete work.payload.owner;
  }
  // KEJ-99 adds a host planning hint, not a change to these frozen business traces.
  // Validate only that explicit extension; every other payload field remains in the full digest.
  for (const work of context.intents) {
    if (work.kind === 'interpretation') {
      const capacity = work.payload.maxPartitions;
      assert(typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity >= 0 && capacity <= 8,
        `${label}: interpretation ${work.id} must have a bounded host capacity`);
      const concurrent = work.payload.maxConcurrentPartitions;
      assert(typeof concurrent === 'number' && Number.isInteger(concurrent) && concurrent >= 0 && concurrent <= capacity
        && concurrent <= context.config.bots.length - 1, `${label}: concurrency must be a separate bounded host hint`);
      delete work.payload.maxConcurrentPartitions;
      delete work.payload.maxPartitions;
    } else assert(!Object.hasOwn(work.payload, 'maxPartitions'), `${label}: only interpretation work can carry a planning capacity`);
  }
  assert.equal(digest(value), expected.digest, `${label}: full persisted snapshot differs`);
}
export interface DiagnosticComparison { pureDigest: string; inspectedDigest: string; evidence: DebugEvidence }
export function replayLegacyTrace(name: string, diagnostics = false, comparisons?: DiagnosticComparison[]): TaskSnapshot {
  const trace = legacyTaskContract.traces.find(trace => trace.name === name);
  assert(trace, name);
  const input = structuredClone(trace.input);
  let snapshot = initialTask(input);
  const owners: FacilitatorOwners = new Map();
  const checks: HistoricalChecks = new Map();
  recordCreatedFacilitators(snapshot, owners);
  assertFrame(snapshot, trace.frames[0]!, `${name}:init`, owners);
  if (diagnostics) {
    const initial = inspectInitialTask(input);
    assert.equal(snapshotDigest(initial.snapshot), snapshotDigest(snapshot));
    comparisons?.push({ pureDigest: snapshotDigest(snapshot), inspectedDigest: snapshotDigest(initial.snapshot), evidence: initial.evidence });
    assertLegacyEvidence(initial.evidence, trace.frames[0]!.evidence, `${name}:initial diagnostics`);
  }
  for (const [index, recorded] of trace.events.entries()) {
    const before = snapshot;
    const event = boundCheckResult(before, structuredClone(recorded));
    snapshot = stepTask(before, event);
    recordCreatedFacilitators(snapshot, owners);
    recordCreatedChecks(snapshot, checks);
    const frame: Frame = trace.frames[index + 1]!;
    const consume = checkAuthorization(snapshot, event);
    if (diagnostics) {
      const inspected = inspectTask(before, event);
      assert.equal(snapshotDigest(inspected.snapshot), snapshotDigest(snapshot));
      comparisons?.push({ pureDigest: snapshotDigest(snapshot), inspectedDigest: snapshotDigest(inspected.snapshot), evidence: inspected.evidence });
      assertLegacyEvidence(inspected.evidence, frame.evidence, `${name}:${index}:diagnostics`,
        before.context.outcome !== 'complete' && snapshot.context.outcome === 'complete', !!consume,
        !before.context.resilience?.frozen && !!snapshot.context.resilience?.frozen);
    }
    if (consume) {
      assert.deepEqual(snapshot.context.usage, before.context.usage, 'Claiming a check does not charge a model request');
      const claimed = snapshot;
      snapshot = stepTask(claimed, consume);
      assert.equal(snapshot.context.reply.code, 'OK');
      assert.equal(snapshot.context.usage.checks, claimed.context.usage.checks + 1);
      if (diagnostics) {
        const inspected = inspectTask(claimed, consume);
        assert.equal(snapshotDigest(inspected.snapshot), snapshotDigest(snapshot));
        comparisons?.push({ pureDigest: snapshotDigest(snapshot), inspectedDigest: snapshotDigest(inspected.snapshot), evidence: inspected.evidence });
        assert.deepEqual(inspected.evidence.evaluations[0], { ruleId: '*:CONSUME:0', source: '*', event: 'CONSUME', guard: 'valid', passed: true });
        assert.deepEqual(inspected.evidence.changed, ['intents', 'trace', 'usage', 'deliveryCycle']);
      }
    }
    assertFrame(snapshot, frame, `${name}:${index}:${event.type}`, owners, checks);
    snapshot = restoreTask(structuredClone(persistTask(snapshot)));
    assertFrame(snapshot, frame, `${name}:${index}:persist/restore`, owners, checks);
  }
  assert.deepEqual(input, trace.input, 'Model must not mutate its input');
  return snapshot;
}
function verifyCoordinationExtensionFaultDetection() {
  const trace = legacyTaskContract.traces.find(item => item.name === '成员评审');
  assert(trace);
  const snapshot = initialTask(structuredClone(trace.input)), owners: FacilitatorOwners = new Map();
  recordCreatedFacilitators(snapshot, owners);
  const mustReject = (mutate: (work: Intent) => void) => {
    const saved = structuredClone(persistTask(snapshot)) as { context: TaskContext };
    const work = saved.context.intents.find(item => item.kind === 'facilitator');
    assert(work); mutate(work);
    assert.throws(() => assertFrame(restoreTask(saved), trace.frames[0]!, 'coordination extension fault injection', owners), assert.AssertionError);
  };
  mustReject(work => { delete work.payload.owner; });
  mustReject(work => { work.payload.owner = 'wrong-owner'; });
  mustReject(work => { work.payload.unexpectedMetadata = true; });
}
function verifyInterpretationCapacityFaultDetection() {
  const trace = legacyTaskContract.traces.find(item => item.name === '输入解析');
  assert(trace);
  const snapshot = initialTask(structuredClone(trace.input));
  assert.equal(snapshot.context.intents[0]?.payload.maxPartitions, 5);
  assert.equal(snapshot.context.intents[0]?.payload.maxConcurrentPartitions, 1);
  const mustReject = (mutate: (work: Intent) => void) => {
    const saved = structuredClone(persistTask(snapshot)) as { context: TaskContext };
    const work = saved.context.intents.find(item => item.kind === 'interpretation');
    assert(work); mutate(work);
    assert.throws(() => assertFrame(restoreTask(saved), trace.frames[0]!, 'interpretation capacity fault injection', new Map()), assert.AssertionError);
  };
  mustReject(work => { delete work.payload.maxPartitions; });
  mustReject(work => { work.payload.maxPartitions = -1; });
  mustReject(work => { work.payload.maxPartitions = 9; });
  mustReject(work => { work.payload.maxPartitions = 1.5; });
  mustReject(work => { work.payload.maxPartitions = '1'; });
  mustReject(work => { delete work.payload.maxConcurrentPartitions; });
  mustReject(work => { work.payload.maxConcurrentPartitions = 9; });
  mustReject(work => { work.payload.unexpectedMetadata = true; });
  mustReject(work => { work.kind = 'owner'; });
}
function verifyResilienceExtensionFaultDetection() {
  const trace = legacyTaskContract.traces.find(item => item.name === '协助结果交接'); assert(trace);
  const initial = initialTask(structuredClone(trace.input));
  for (const field of ['hardDeadline', 'repairUsed'] as const) {
    const saved = structuredClone(persistTask(initial)) as { context: TaskContext };
    saved.context.resilience!.window[field]++;
    assert.throws(() => assertFrame(restoreTask(saved), trace.frames[0]!, `resilience ${field} mutation`, new Map()), assert.AssertionError);
  }
  const exhausted = legacyTaskContract.traces.find(item => item.name === '普通额度耗尽'); assert(exhausted);
  let finished = initialTask(structuredClone(exhausted.input));
  for (const event of exhausted.events) finished = stepTask(finished, structuredClone(event));
  const saved = structuredClone(persistTask(finished)) as { context: TaskContext };
  saved.context.resilience!.frozen!.outcome = 'complete';
  assert.throws(() => assertFrame(restoreTask(saved), exhausted.frames.at(-1)!, '普通额度耗尽:tampered completion', new Map()), assert.AssertionError);
}
export function verifyLegacyDiagnostics() {
  const graph = legacyTaskContract.graph, insertion = graph.transitions.findIndex(t => t.event === 'LOCAL_RESULT');
  assert.deepEqual(graph.transitions.find(rule => rule.id === coordinationRejectionId), {
    id: coordinationRejectionId, order: 6, source: 'coordinating', event: 'COORDINATE', target: 'waitingHuman', guards: ['isCurrent'], actions: ['reject'],
  });
  const transitions = [...sessionRules, ...hostRetryRules, ...graph.transitions.slice(0, insertion), ...approvalRules, ...graph.transitions.slice(insertion)]
    .flatMap(original => {
      const rule = original.id === coordinationRejectionId ? { ...original, actions: ['reject', 'explainCoordinationRejection'] } : original;
      const group = boundedRules(rule.source, rule.event);
      if (group) {
        if (rule.order !== 0) return [];
        return rule.source === 'checking' && rule.event === 'WORK_FAILED' ? [...checkSettleRules, ...group] : group;
      }
      if (rule.source === heldFinish.source && rule.event === heldFinish.event && rule.order >= heldFinish.order) {
        const shifted = { ...rule, order: rule.order + 1, id: nextRuleId(rule.id) };
        return rule.order === heldFinish.order ? [heldFinish, shifted] : [shifted];
      }
      return rule.id === '*:@always:1' ? [rule, ...hostRetryAlwaysRules] : [rule];
    }).flatMap(rule => rule.source === '*' && rule.event === '@always'
      ? [...(rule.order === 0 ? lifecycleRules : []), { ...rule, id: shiftedGlobal(rule.id), order: rule.order + 2 }] : [rule])
    .flatMap(rule => rule.id === '*:REGENERATE_MODEL_OUTPUT:0' ? [rule, ...toolFailureRules] : [rule]);
  const extended = resilienceTransitions(transitions);
  assert.deepEqual(taskGraph().transitions, extended);
  assert.equal(taskGraph().id, graph.id); assert.equal(taskGraph().initial, graph.initial); assert.deepEqual(taskGraph().states, graph.states);
  const comparisons: DiagnosticComparison[] = [];
  for (const trace of legacyTaskContract.traces) replayLegacyTrace(trace.name, true, comparisons);
  verifyCoordinationExtensionFaultDetection();
  verifyInterpretationCapacityFaultDetection();
  verifyResilienceExtensionFaultDetection();
  // The full extended row structure was independently checked above. Its current
  // definition is an opaque compatibility token, not the retired fixture token.
  const checkedGraph = taskGraph();
  return { graph: checkedGraph, expectedGraph: { ...graph, definition: checkedGraph.definition, transitions: extended }, comparisons };
}
