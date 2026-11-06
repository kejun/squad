import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initialTask, stepTask, persistTask, restoreTask, taskMachine, type TaskSnapshot } from '../src/task.machine.js';
import { inspectInitialTask, inspectTask, type DebugEvidence } from '../src/task-inspection.js';
import { taskGraph, type MachineGraph } from '../src/task-structure.js';
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
const extendedDefinition = '58b04973';
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
function assertLegacyEvidence(actual: DebugEvidence, expected: DebugEvidence, label: string, published = false, checkClaim = false) {
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
  const comparable = (keys: string[]) => keys.filter(key => key !== 'deliveryCycle');
  const expectedKeys = (keys: string[]) => checkClaim ? keys.filter(key => key !== 'usage')
    : published && keys.includes('outcome') ? [...keys, 'publishedDelivery'] : keys;
  assert.deepEqual({ ...actual, changed: comparable(actual.changed), microsteps: actual.microsteps.map(step => ({ ...step, changed: comparable(step.changed) })) },
    { ...expected, definition: extendedDefinition, evaluations, changed: expectedKeys(expected.changed),
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
  const cycle = context.deliveryCycle;
  assert(cycle, label);
  assert.equal(cycle.requests, expected.usage.checks, label);
  assert.equal(cycle.retry, undefined, label);
  assert.equal(cycle.revisionUsed, false, label);
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
      delete work.payload.maxPartitions;
    } else assert(!Object.hasOwn(work.payload, 'maxPartitions'), `${label}: only interpretation work can carry a planning capacity`);
  }
  assert.equal(digest(value), expected.digest, `${label}: full persisted snapshot differs`);
}
export function replayLegacyTrace(name: string, diagnostics = false): TaskSnapshot {
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
      assertLegacyEvidence(inspected.evidence, frame.evidence, `${name}:${index}:diagnostics`,
        before.context.outcome !== 'complete' && snapshot.context.outcome === 'complete', !!consume);
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
  assert.equal(snapshot.context.intents[0]?.payload.maxPartitions, 1);
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
  mustReject(work => { work.payload.unexpectedMetadata = true; });
  mustReject(work => { work.kind = 'owner'; });
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
    });
  assert.deepEqual(taskGraph(), { ...graph, definition: extendedDefinition, transitions });
  for (const trace of legacyTaskContract.traces) replayLegacyTrace(trace.name, true);
  verifyCoordinationExtensionFaultDetection();
  verifyInterpretationCapacityFaultDetection();
}
