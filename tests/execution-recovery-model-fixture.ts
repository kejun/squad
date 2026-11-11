import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { executionState, initialTask, persistTask, restoreTask, startTaskExecution, stepTask, taskPhase, type TaskSnapshot } from '../src/task.machine.js';
import type { Intent, TaskEvent } from '../src/types.js';
import { LocalModel, localModelInput } from './local-model-fixture.js';
import { CapacityModel } from './map-capacity-model-fixture.js';
import { MapQueueModel } from './map-queue-fixture.js';
import { toolRecoveryModelGate } from './tool-recovery-model-fixture.js';
import { toolGuidanceModelGate } from './tool-guidance-model-fixture.js';
import { verifyServiceLifecycleModel } from './service-lifecycle-model-fixture.js';
import { taskHumanGate } from '../src/task/resilience.js';

export const recoveryRoles = ['输入解析', '负责人', '协助成员', '系统协调员', '交付检查', '讨论汇总', '分片成员'] as const;
export type RecoveryRole = typeof recoveryRoles[number];
const kinds: Record<RecoveryRole, Intent['kind']> = { 输入解析: 'interpretation', 负责人: 'owner', 协助成员: 'assistance',
  系统协调员: 'facilitator', 交付检查: 'check', 讨论汇总: 'discussionSummary', 分片成员: 'assistance' };

export function executionRecoverySeed(role: RecoveryRole): TaskSnapshot {
  if (role === '负责人') return initialTask(localModelInput());
  if (role === '输入解析') return new CapacityModel().snapshot;
  if (role === '分片成员') return new MapQueueModel().snapshot;
  if (role === '讨论汇总') { const model = new MapQueueModel(); model.drain(); return model.snapshot; }
  const model = new LocalModel();
  if (role === '系统协调员') assert(model.send({ type: 'BLOCKED', workId: model.work.id, fence: model.work, reason: '需要换方法' }).ok);
  if (role === '协助成员') assert(model.send({ type: 'HELP', workId: model.work.id, fence: model.work,
    requestId: 'recovery-help', caller: 'A', target: 'B', question: '核对来源', expected: '真实依据' }).ok);
  if (role === '交付检查') assert(model.send({ type: 'DELIVER', workId: model.work.id, fence: model.work, text: '已有候选', artifactIds: [] }).ok);
  return model.snapshot;
}

function roundTrip(snapshot: TaskSnapshot): TaskSnapshot { return restoreTask(structuredClone(persistTask(snapshot))); }

/** Probe the actual model's public CLAIM guard rather than approximating eligibility from status. */
function hasExecutableSuccessor(snapshot: TaskSnapshot, at: number): boolean {
  return snapshot.context.intents.filter(work => work.status === 'pending').some(work => {
    const next = stepTask(roundTrip(snapshot), { type: 'CLAIM', id: `probe-successor:${work.id}:${at}`, at, intentId: work.id });
    return next.context.reply.ok;
  });
}

export function notStartedRecoveryModel(role: RecoveryRole, lateBy = 0) {
  let snapshot = executionRecoverySeed(role);
  const pending = snapshot.context.intents.find(work => work.kind === kinds[role] && work.status === 'pending')!;
  assert(pending && pending.deadline !== null, `${role}: expected deadline-bound pending work`);
  const at = pending.deadline! + lateBy;
  snapshot = roundTrip(stepTask(snapshot, { type: 'CLAIM', id: `claim-before:${role}`, intentId: pending.id, at: pending.deadline! - 1 }));
  assert(snapshot.context.reply.ok, `${role}: must claim before the deadline`);
  const claimed = structuredClone(snapshot.context.intents.find(work => work.id === pending.id)!);
  const permit = startTaskExecution(snapshot, claimed.id, claimed.attempt, at);
  assert.equal(permit.allowed, false, `${role}: deadline must prevent adapter start`);
  snapshot = roundTrip(permit.snapshot);
  assert.notEqual(executionState(snapshot, claimed.id, claimed.attempt), 'running');
  const event = { type: 'EXECUTION_NOT_STARTED', id: `not-started:${role}`, at, intentId: claimed.id,
    attempt: claimed.attempt, fence: claimed, reason: 'Execution permit expired before adapter start' } as TaskEvent;
  snapshot = roundTrip(stepTask(snapshot, event));
  assert(snapshot.context.reply.ok, `${role}: trusted not-started evidence must be accepted`);
  const result = { role, lateBy, phase: taskPhase(snapshot), outcome: snapshot.context.outcome,
    executableSuccessor: hasExecutableSuccessor(snapshot, at), reason: snapshot.context.reason };
  assert(result.outcome !== null || result.executableSuccessor || result.phase === 'waitingHuman' && !!result.reason.trim(),
    `${role}: no executable successor, explicit human reason or terminal result after not-started receipt`);
  assert(!snapshot.context.intents.some(work => work.id === claimed.id && work.attempt === claimed.attempt && work.status === 'inflight'),
    `${role}: the confirmed unstarted attempt cannot retain its inflight reservation`);
  return { snapshot, result };
}

export function cancellationOwnershipModel() {
  const model = new LocalModel();
  const original = structuredClone(model.work);
  assert(model.send({ type: 'STOP' }).ok);
  const cancel = model.c.intents.find(work => work.kind === 'cancel' && work.status === 'pending')!;
  assert(cancel);
  assert.equal(model.c.intents.find(work => work.id === original.id)!.status, 'inflight',
    'Sending cancellation does not establish original execution settlement');
  assert(model.send({ type: 'CLAIM', intentId: cancel.id }).ok);
  assert(model.send({ type: 'SETTLE', intentId: cancel.id, attempt: model.c.intents.find(work => work.id === cancel.id)!.attempt }).ok);
  assert.equal(model.c.intents.find(work => work.id === original.id)!.status, 'inflight',
    'A completed cancel callback is not an original execution receipt');
  assert.equal(model.c.outcome, null);
  assert(model.send({ type: 'SETTLE', intentId: original.id, attempt: original.attempt }).ok);
  assert.equal(model.c.outcome, 'stopped');
  assert.equal(model.c.intents.filter(work => work.status === 'inflight').length, 0);
  return { outcome: model.c.outcome, usage: structuredClone(model.c.usage) };
}

export function frozenCancellationModel() {
  const model = new LocalModel();
  assert(model.request({ type: 'discoverHost', commands: ['node'] }).ok);
  assert(model.claim(false).ok);
  assert(model.send({ type: 'STOP' }).ok);
  assert.equal(model.c.outcome, 'stopped');
  const cancel = model.c.intents.find(work => work.kind === 'cancel' && work.status === 'pending')!;
  assert(cancel);
  assert(model.send({ type: 'CLAIM', intentId: cancel.id }).ok,
    'Frozen business delivery must still permit the persisted cancellation intent');
  assert(model.result({ result: { ok: false, code: 'cancelled', data: {} } }).ok);
  assert.equal(model.op!.status, 'cancelled');
  assert.equal(model.c.resilience!.cleanup[0]!.state, 'settled');
  assert.equal(model.c.outcome, 'stopped');
  return { outcome: model.c.outcome, operationStatus: model.op!.status };
}

export function skippedContentCustodyModel() {
  const model = new LocalModel();
  const owner = structuredClone(model.work);
  assert(model.send({ type: 'USER_INPUT', text: 'B讨论目标来源', reviewTargets: ['B'] }).ok);
  let planner = model.c.intents.find(work => work.kind === 'facilitator' && work.status === 'pending')!;
  assert(model.send({ type: 'CLAIM', intentId: planner.id }).ok);
  planner = model.c.intents.find(work => work.id === planner.id)!;
  assert(model.send({ type: 'DISCUSSION_PLAN', discussionId: planner.discussionId, workId: planner.id, fence: planner,
    decision: { action: 'review', question: '核查目标来源', expected: '真实正文', reason: '用户明确要求' } }).ok);
  let member = model.c.intents.find(work => work.kind === 'assistance' && work.status === 'pending')!;
  assert(model.send({ type: 'CLAIM', intentId: member.id }).ok);
  member = model.c.intents.find(work => work.id === member.id)!;
  const identity = { intentId: member.id, operationId: 'unknown-reader' };
  assert(model.send({ type: 'LOCAL_REQUEST', ...identity, parentAttempt: member.attempt, fence: member,
    namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), action: { type: 'runCli', executable: 'reader', args: [] },
    messages: [], workspaceId: 'real-conflict-resource' }).ok);
  assert(model.send({ type: 'LOCAL_CLAIM', ...identity, parentAttempt: member.attempt, fence: member,
    sessionId: 'unknown-session', leaseAvailable: true }).ok);
  assert(model.send({ type: 'LOCAL_STARTED', ...identity, sessionId: 'unknown-session' }).ok);
  assert(model.send({ type: 'LOCAL_RESULT', ...identity, sessionId: 'unknown-session', settled: true, effectsKnown: false,
    result: { ok: false, code: 'timeout', data: {} } }).ok);
  assert(model.send({ type: 'WAIT_USER', workId: owner.id, fence: owner, question: '是否跳过当前缺失内容' }).ok);
  const gate = taskHumanGate(model.c)!;
  assert(gate);
  assert(model.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '明确跳过该内容' }).ok);
  assert(model.send({ type: 'RECOVER', config: model.c.config }).ok);
  const operation = model.c.intents.find(work => work.id === member.id)!.localOperations!.find(op => op.id === identity.operationId)!;
  const custody = model.c.resilience!.cleanup.find(item => item.operationId === identity.operationId)!;
  assert.equal(model.c.resilience!.gates.find(item => item.id === gate.id)!.status, 'skipped');
  assert(model.c.resilience!.skips.some(skip => skip.authorization === 'human' && skip.gateId === gate.id));
  assert.equal(operation.status, 'uncertain'); assert.equal(custody.state, 'pending');
  assert.deepEqual(custody.resourceKeys, ['real-conflict-resource']);
  assert.equal(model.c.intents.flatMap(work => work.hostAcquisitions ?? []).length, 0);
  return { gateStatus: 'skipped', operationStatus: operation.status, custodyState: custody.state,
    resourceKeys: custody.resourceKeys, contentVerified: false };
}

export function finiteDependencyRecoveryModel() {
  const model = new LocalModel(input => { input.config.limits.retries = 2; });
  const first = structuredClone(model.work);
  assert(model.send({ type: 'CONSUME', intentId: first.id, attempt: first.attempt, fence: first }).ok);
  assert(model.send({ type: 'WORK_FAILED', intentId: first.id, attempt: first.attempt, fence: first,
    transient: true, reason: 'SKILL_SEARCH_HTTP_503' }).ok);
  assert.equal(model.c.intents.find(work => work.id === first.id)!.status, 'pending');
  assert.equal(model.c.usage.retries, 1);
  assert(model.send({ type: 'CLAIM', intentId: first.id }).ok);
  const second = structuredClone(model.c.intents.find(work => work.id === first.id)!);
  assert(model.send({ type: 'CONSUME', intentId: second.id, attempt: second.attempt, fence: second }).ok);
  assert(model.send({ type: 'WORK_FAILED', intentId: second.id, attempt: second.attempt, fence: second,
    transient: true, reason: 'SKILL_SEARCH_HTTP_503' }).ok);
  assert.equal(model.c.usage.retries, 2);
  assert(model.send({ type: 'CLAIM', intentId: first.id }).ok);
  const third = structuredClone(model.c.intents.find(work => work.id === first.id)!);
  assert(model.send({ type: 'CONSUME', intentId: third.id, attempt: third.attempt, fence: third }).ok);
  assert(model.send({ type: 'WORK_FAILED', intentId: third.id, attempt: third.attempt, fence: third,
    transient: true, reason: 'SKILL_SEARCH_HTTP_503' }).ok);
  assert.equal(model.c.usage.retries, 2, 'A third dependency failure cannot replenish recovery budget');
  assert(!model.c.intents.some(work => work.id === first.id && ['pending', 'inflight'].includes(work.status)),
    'Exhausted retries cannot keep dispatching the same failed dependency');
  return { phase: taskPhase(model.snapshot), outcome: model.c.outcome, reason: model.c.reason, usage: structuredClone(model.c.usage) };
}

export function existingExecutionRecoveryModelGate() {
  const feedback = toolRecoveryModelGate();
  const guidance = toolGuidanceModelGate();
  verifyServiceLifecycleModel();
  return { feedback, guidance, cancellation: cancellationOwnershipModel(), frozenCancellation: frozenCancellationModel(), dependency: finiteDependencyRecoveryModel(),
    skippedContent: skippedContentCustodyModel() };
}

export function executionRecoveryModelGate() {
  const controls = existingExecutionRecoveryModelGate();
  const notStarted = recoveryRoles.flatMap(role => [0, 1].map(lateBy => notStartedRecoveryModel(role, lateBy).result));
  return { controls, notStarted, persistence: 'real taskMachine with persisted round trip after each public event' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(process.argv.includes('--existing-only') ? existingExecutionRecoveryModelGate() : executionRecoveryModelGate(), null, 2));
