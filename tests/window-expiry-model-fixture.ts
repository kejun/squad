import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { initialTask, persistTask, restoreTask, startTaskExecution } from '../src/task.machine.js';
import { processingWindow, taskHumanGate, effectiveWork } from '../src/task/resilience.js';
import { localModelInput } from './local-model-fixture.js';
import { ResilienceModel, stageModel } from './task-resilience-model-fixture.js';
import type { Phase } from '../src/types.js';
import { grantedSession } from './host-session-model-fixture.js';
import { approvalModel, decideApproval } from './host-approval-model-fixture.js';
import { MapQueueModel } from './map-queue-fixture.js';
import { capacityModelIntent } from './map-capacity-model-fixture.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';

export function defaultWindowModel(prepared?: ResilienceModel) {
  const input = localModelInput(); delete input.config.resilience;
  const m = prepared ?? new ResilienceModel(); if (!prepared) m.snapshot = initialTask(input);
  const before = structuredClone(processingWindow(m.c)), usage = structuredClone(m.c.usage);
  assert.equal(before.hardDeadline - before.openedAt, 10_800_000);
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  m.snapshot = restoreTask(structuredClone(persistTask(m.snapshot)));
  assert.deepEqual(processingWindow(m.c), before); assert.deepEqual(m.c.usage, usage);
  return m;
}
export function expiredPhaseModel(phase: Phase, prepared?: ResilienceModel) {
  const m = prepared ?? stageModel(phase); m.artifact();
  const before = structuredClone(processingWindow(m.c)), usage = structuredClone(m.c.usage);
  const existing = taskHumanGate(m.c)?.id;
  assert(m.supervise(before.hardDeadline).ok);
  assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null);
  assert.equal(processingWindow(m.c).failure?.code, 'WINDOW_EXPIRED');
  assert.equal(processingWindow(m.c).failure?.at, before.hardDeadline);
  const gate = taskHumanGate(m.c)!; assert(gate);
  if (existing) assert.equal(gate.id, existing);
  else { assert.equal(gate.cause, 'windowExpired'); assert.equal(gate.code, 'WINDOW_EXPIRED'); assert.deepEqual(gate.decisions, ['newWindow', 'skip', 'stop']); }
  const identity = gate.id;
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); assert(m.supervise(before.hardDeadline + 100).ok);
  assert.equal(taskHumanGate(m.c)?.id, identity); assert.equal(processingWindow(m.c).hardDeadline, before.hardDeadline);
  assert.deepEqual(m.c.usage, usage); assert.equal(effectiveWork(m.c, m.phase, m.at).length, 0);
  assert(m.c.artifacts.some(item => item.id === 'current-artifact')); assert.equal(m.c.resilience!.frozen, undefined);
  return m;
}
export function expiredDecisionModel(decision: string, prepared?: ResilienceModel) {
  if (decision.startsWith('跳过旧宿主')) {
    const old = approvalModel(); old.at = processingWindow(old.c).hardDeadline;
    assert(old.send({ type: 'SUPERVISE' }).ok); const gate = taskHumanGate(old.c)!;
    assert(old.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '只跳过这个命令' }).ok);
    assert.equal(taskHumanGate(old.c)?.cause, 'windowExpired'); assert.equal(old.c.outcome, null);
    const m = new ResilienceModel(); m.snapshot = old.snapshot; m.at = old.at;
    assert(m.c.resilience!.skips.some(skip => skip.gateId === gate.id)); return m;
  }
  const m = prepared ?? new ResilienceModel(); if (!prepared) m.artifact();
  const oldGate = decision.includes('旧必需门') ? m.waiting() : undefined;
  m.supervise(100); const gate = taskHumanGate(m.c)!, before = structuredClone(processingWindow(m.c));
  const usage = structuredClone(m.c.usage);
  if (decision === '普通回复') {
    assert.equal(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'reply', text: '继续' }).code, 'HUMAN_GATE_DECISION_NOT_ALLOWED');
  } else if (decision === '关闭提示后恢复') assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  else if (decision.includes('旧必需门')) {
    assert(oldGate); assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: oldGate.id, decision: 'reply', text: '选甲' }).ok);
    assert.equal(taskHumanGate(m.c)?.cause, 'windowExpired');
  } else if (decision.includes('新窗口')) {
    const body = decision.startsWith('通过继续入口')
      ? { type: 'CONTINUE', id: 'explicit-window', text: '授权继续三小时', newWindowMs: 10_800_000 }
      : { type: 'HUMAN_GATE_DECISION', id: 'explicit-window', gateId: gate.id, decision: 'newWindow', text: '授权继续三小时', newWindowMs: 10_800_000 };
    assert(m.send(body).ok); const window = structuredClone(processingWindow(m.c));
    assert.equal(window.openedAt, 100); assert.equal(window.hardDeadline, 10_800_100); assert.equal(window.authorizationId, 'explicit-window');
    assert.equal(window.failure, undefined); assert.equal(m.phase, 'running'); assert.equal(m.c.outcome, null);
    assert(effectiveWork(m.c, m.phase, m.at).length > 0);
    const count = m.c.intents.length;
    if (body.type === 'HUMAN_GATE_DECISION') assert(m.send(body).ok);
    else assert.equal(m.send(body).ok, false);
    assert.equal(m.c.intents.length, count); assert.deepEqual(processingWindow(m.c), window);
  } else {
    assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: decision.includes('停止') ? 'stop' : 'skip', text: decision }).ok);
    assert.equal(m.phase, 'ended'); assert.equal(m.c.outcome, decision.includes('停止') ? 'stopped' : 'partial'); assert(m.c.resilience!.frozen);
  }
  if (['普通回复', '关闭提示后恢复'].includes(decision) || oldGate) {
    assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null); assert.equal(processingWindow(m.c).hardDeadline, before.hardDeadline);
  }
  assert.deepEqual(m.c.usage, usage); return m;
}
export function windowFailureModel(failure: string, prepared?: ResilienceModel) {
  const m = prepared ?? new ResilienceModel(); const work = prepared ? m.c.intents.find(work => work.status === 'inflight')! : m.claim(), before = m.c.usage.retries;
  if (failure.startsWith('WINDOW_EXPIRED')) {
    m.at = 100;
    assert(m.send({ type: 'WORK_FAILED', intentId: work.id, code: 'WINDOW_EXPIRED', reason: 'window deadline exceeded', transient: failure.includes('transient') }).ok);
    assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.outcome, null); assert.equal(taskHumanGate(m.c)?.cause, 'windowExpired');
    assert.equal(m.c.usage.retries, before); assert.equal(m.pending('owner').length, 0);
  } else if (failure.includes('网络')) {
    assert(m.send({ type: 'WORK_FAILED', intentId: work.id, code: 'MODEL_NETWORK_ERROR', reason: 'network request failed', transient: true }).ok);
    assert.equal(m.phase, 'running'); assert.equal(m.c.usage.retries, before + 1); assert.equal(m.pending('owner').length, 1);
    assert.equal(processingWindow(m.c).failure, undefined);
  } else {
    m.at = 2;
    assert(m.send({ type: 'WORK_FAILED', intentId: work.id, code: 'WORK_TIMEOUT', reason: 'single work deadline exceeded', transient: false }).ok);
    assert.equal(processingWindow(m.c).failure, undefined); assert.notEqual(taskHumanGate(m.c)?.cause, 'windowExpired');
  }
  return m;
}
export function expiryPhysicalCustodyModel() {
  const m = new ResilienceModel(); const work = m.unknown(); m.supervise(100);
  assert.equal(m.phase, 'waitingHuman'); assert.equal(m.c.resilience!.cleanup[0]!.state, 'pending');
  assert(m.c.resilience!.gates.some(g => g.scope === 'cleanup' && g.status === 'open'));
  assert.equal(startTaskExecution(m.snapshot, work.id, work.attempt, 100).allowed, false);
  return m;
}
export function expiryPermissionModel() {
  const approval = approvalModel(), prior = taskHumanGate(approval.c)!;
  approval.at = processingWindow(approval.c).hardDeadline;
  assert(approval.send({ type: 'SUPERVISE' }).ok);
  assert.equal(taskHumanGate(approval.c)?.id, prior.id); assert.equal(approval.op!.startedAt, undefined);
  assert.equal(approval.send({ type: 'HUMAN_GATE_DECISION', gateId: prior.id, decision: 'newWindow', newWindowMs: 10_800_000, text: '继续' }).code, 'HOST_APPROVAL_DECISION_REQUIRED');
  assert.equal(approval.send({ type: 'CONTINUE', newWindowMs: 10_800_000, text: '继续' }).code, 'HOST_APPROVAL_DECISION_REQUIRED');
  assert(decideApproval(approval, 'deny').ok);
  assert.equal(taskHumanGate(approval.c)?.cause, 'windowExpired'); assert.equal(approval.op!.startedAt, undefined);
  const granted = grantedSession(); assert(granted.c.hostSession);
  granted.at = processingWindow(granted.c).hardDeadline;
  assert(granted.send({ type: 'SUPERVISE' }).ok); assert.equal(granted.c.hostSession, undefined);
  const gate = taskHumanGate(granted.c)!;
  assert(granted.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'newWindow', newWindowMs: 10_800_000, text: '只授权时长' }).ok);
  assert.equal(granted.c.hostSession, undefined);
}
export function expiryOtherDeadlineModel() {
  const unstarted = new ResilienceModel(), work = unstarted.claim(); unstarted.at = 100;
  assert(unstarted.send({ type: 'EXECUTION_NOT_STARTED', intentId: work.id, reason: '未启动即到窗口边界' }).ok);
  assert.equal(unstarted.phase, 'waitingHuman'); assert.equal(taskHumanGate(unstarted.c)?.code, 'WINDOW_EXPIRED');
  const repair = new ResilienceModel(); repair.claim();
  assert(repair.send({ type: 'WORK_FAILED', intentId: repair.c.intents[0]!.id, reason: 'HTTP 503', transient: false }).ok);
  assert.equal(processingWindow(repair.c).repairDeadline, 21);
  repair.supervise(21); assert.equal(repair.phase, 'ended'); assert.equal(repair.c.outcome, 'failed');
  assert.equal(processingWindow(repair.c).failure, undefined); assert.equal(taskHumanGate(repair.c), undefined);
}
export function expiryClaimedInputResumeModel() {
  const m = stageModel('interpreting'), original = m.claim('interpretation');
  m.supervise(processingWindow(m.c).hardDeadline);
  assert(m.send({ type: 'SETTLE', intentId: original.id }).ok);
  const gate = taskHumanGate(m.c)!;
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'newWindow', newWindowMs: 10_800_000, text: '继续完成原输入' }).ok);
  assert.equal(m.phase, 'interpreting');
  const next = m.pending('interpretation')[0]; assert(next, 'renewal must restore an executable interpretation after the old attempt settles');
  assert.notEqual(next.id, original.id); assert(m.c.inputAnalyses!.some(input => input.status === 'pending' && input.workId === next.id));
  return m;
}
export function expiryPhaseCompletionModel(phase: Phase, withSavedAnswer = false) {
  const m = stageModel(phase);
  if (withSavedAnswer) {
    // The trustworthy result is saved before expiry; its normal consumer is deliberately delayed.
    const help = m.c.assists[0]!, old = m.c.intents.find(work => work.payload.requestId === help.id)!;
    // This historical task already settled the worker; use the public stored-result event without a live-work declaration.
    assert(m.send({ type: 'RECORD_RESULT', requestId: help.id, resultId: 'saved-before-expiry', status: 'success', answer: '已取得并保存的答复' }).ok);
    assert.equal(old.status, 'done');
  }
  m.supervise(100);
  const question = m.c.assists[0]?.question;
  for (const work of m.c.intents.filter(work => work.kind !== 'cancel' && work.status === 'inflight' && !work.localOperations?.length)) assert(m.send({ type: 'SETTLE', intentId: work.id }).ok);
  const gate = taskHumanGate(m.c)!;
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'newWindow', newWindowMs: 10_800_000, text: '完成原目标' }).ok);
  if (phase === 'interpreting') {
    const work = m.claim('interpretation'); assert(m.send({ type: 'CONSUME', intentId: work.id, fence: work }).ok);
    const { decomposition: _decomposition, ...spec } = capacityModelIntent();
    assert(m.send({ type: 'INTERPRETATION_RESULT', workId: work.id, fence: work, inputId: (work.payload.input as { id: string }).id, spec }).ok);
  }
  if (withSavedAnswer) {
    const saved = m.c.results.find(result => result.resultId === 'saved-before-expiry')!;
    assert.equal(saved.consumed, false); assert.equal(saved.answer, '已取得并保存的答复');
    assert(m.send({ type: 'HELP_RESULT', requestId: saved.requestId, resultId: saved.resultId, status: saved.status, answer: saved.answer }).ok);
    assert.equal(m.send({ type: 'HELP_RESULT', requestId: saved.requestId, resultId: saved.resultId, status: saved.status, answer: saved.answer }).code, 'DUPLICATE_RESULT');
    assert.equal(m.c.consumedResults.filter(id => id === saved.resultId).length, 1);
  }
  const owner = m.claim(); assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '完成原目标的可核验成果', artifactIds: [] }).ok);
  assert.equal(m.phase, 'checking', `${phase}: expiry must not retain an orphaned assistance or delivery wait`);
  const check = m.claim('check'); assert(m.send({ type: 'CONSUME', intentId: check.id, fence: check }).ok);
  assert(m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, candidateRevision: m.c.candidate!.revision,
    resultId: `completed-${phase}-${withSavedAnswer}`, criteriaResults: fixtureCheck(m.c.candidate!).criteriaResults }).ok);
  assert.equal(m.c.outcome, 'complete'); if (question) assert.equal(m.c.assists[0]!.question, question);
  return m;
}
export function expiryMapResumeModel(viaContinue = false) {
  const m = new MapQueueModel(), success = m.start(); assert(m.answer(success).ok);
  const saved = structuredClone(m.context.discussion!.results), identity = structuredClone(m.queue.map(part => ({ partitionId: part.partitionId, workId: part.workId, attempt: part.attempt })));
  const queuedBefore = m.queue.filter(part => part.status === 'queued').map(part => part.partitionId); assert(queuedBefore.length > 0);
  m.sequence = processingWindow(m.context).hardDeadline - 1;
  assert(m.send({ type: 'SUPERVISE' }).ok);
  assert.equal(m.queue.filter(part => part.status === 'succeeded').length, 1);
  assert.equal(m.queue.filter(part => part.status === 'timeout' && part.reason === 'WINDOW_EXPIRED').length, 7);
  assert.deepEqual(m.queue.map(part => ({ partitionId: part.partitionId, workId: part.workId, attempt: part.attempt })), identity);
  const gate = taskHumanGate(m.context)!;
  const epoch = m.context.epoch;
  const renewal = viaContinue
    ? { type: 'CONTINUE' as const, newWindowMs: 10_800_000, text: '继续补齐原任务' }
    : { type: 'HUMAN_GATE_DECISION' as const, gateId: gate.id, decision: 'newWindow' as const, newWindowMs: 10_800_000, text: '继续补齐原任务' };
  assert(m.send(renewal).ok);
  assert.equal(m.context.epoch, epoch, 'authorizing time must preserve the original epoch and recovery sources');
  const owner = m.start(m.pending('owner')[0]); assert.equal(m.context.discussion!.status, 'delivered');
  const sourceId = 'new-window-source', docs = Array.from({ length: 8 }, (_, i) => ({ id: `doc-${i + 1}`, body: `完整doc-${i + 1}正文` })), stdout = JSON.stringify(docs);
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: owner.id, operationId: sourceId, namespace: 'a'.repeat(64), requestHash: 'b'.repeat(64),
    action: { type: 'runCli', executable: 'yuque', args: ['show', 'all-eight', '--json'] }, parentAttempt: owner.attempt, fence: owner, messages: [], workspaceId: 'project' }).ok);
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: owner.id, operationId: sourceId, parentAttempt: owner.attempt, fence: owner, sessionId: 'new-window-source-session', leaseAvailable: true }).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: owner.id, operationId: sourceId, sessionId: 'new-window-source-session', settled: true, effectsKnown: true,
    result: { ok: true, code: 'succeeded', data: { exitCode: 0, stdout, truncated: false,
      capturedEvidence: { stdout: { capturedContentHash: 'c'.repeat(64), bytes: Buffer.byteLength(stdout), chars: [...stdout].length } } } } }).ok);
  assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, attempt: owner.attempt,
    text: '续窗后普通交付已完成', artifactIds: [], artifacts: [{ name: 'report.md', content: docs.map(d => d.body).join('\n') }] }).ok);
  const check = m.start(m.pending('check')[0]!);
  assert(m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt,
    candidateRevision: m.context.candidate!.revision!, resultId: 'ordinary-window-pass', criteriaResults: fixtureCheck(m.context.candidate!).criteriaResults }).ok);
  assert.equal(m.context.outcome, 'complete'); assert(m.queue.every(part => !Reflect.has(part, 'resolution')));
  assert.deepEqual(m.context.discussion!.results, saved); assert.equal(m.queue.filter(part => part.status === 'timeout').length, 7);
  assert.deepEqual(m.queue.map(part => ({ partitionId: part.partitionId, workId: part.workId, attempt: part.attempt })), identity);
  return m;
}
export function windowExpiryModelGate() {
  defaultWindowModel();
  const phases = (['interpreting', 'running', 'waitingAssistance', 'coordinating', 'waitingHuman', 'checking'] as Phase[]).map(phase => ({ phase, after: expiredPhaseModel(phase).phase }));
  for (const decision of ['普通回复', '关闭提示后恢复', '明确授权三小时新窗口', '通过继续入口明确授权三小时新窗口', '明确结束并交付现有成果', '明确停止', '解决旧必需门但未授权新窗口']) expiredDecisionModel(decision);
  for (const failure of ['WINDOW_EXPIRED', 'WINDOW_EXPIRED附带transient', '窗口内网络transient', '单次工作期限早于窗口']) windowFailureModel(failure);
  expiryPhysicalCustodyModel();
  expiryPermissionModel(); expiryOtherDeadlineModel();
  expiryClaimedInputResumeModel();
  expiryMapResumeModel(); expiryMapResumeModel(true);
  for (const phase of ['interpreting', 'running', 'waitingAssistance', 'coordinating', 'waitingHuman', 'checking'] as Phase[]) expiryPhaseCompletionModel(phase);
  expiryPhaseCompletionModel('waitingAssistance', true); expiredDecisionModel('跳过旧宿主命令后请求续窗');
  return { status: 'passed', phases, persistence: 'real XState round trip after each event', contracts: ['BT_Y131', 'BT_Y132', 'BT_Y133', 'BT_Y134'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(windowExpiryModelGate()));
