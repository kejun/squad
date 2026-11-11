import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { approvalModel, decideApproval } from './host-approval-model-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import { taskPhase } from '../src/task.machine.js';
import { processingWindow, taskHumanGate } from '../src/task/resilience.js';

export function approvalGateModel() {
  const m = approvalModel(), gate = taskHumanGate(m.c);
  assert(gate, 'A real LOCAL_APPROVAL_REQUIRED must create a durable required human gate');
  assert.equal(gate.kind, 'authorization'); assert.equal(gate.workId, m.work.id); assert.equal(gate.operationId, m.op!.id);
  assert.equal((gate as typeof gate & { approvalId?: string }).approvalId, m.op!.approval!.id);
  assert.equal(gate.status, 'open'); assert.equal(m.op!.startedAt, undefined);
  return m;
}
export function approvalGateDeadline(boundary: string) {
  if (boundary === '多个并行批准等待') return approvalGateParallel();
  if (boundary === '已批准但未领取时恢复' || boundary === '核对确认尚未启动后重新批准') return approvalGateRecovery(boundary);
  const m = approvalGateModel(), original = structuredClone(processingWindow(m.c)), gate = taskHumanGate(m.c)!;
  if (boundary === '批准token到期') {
    m.at = m.op!.approval!.expiresAt;
    assert(m.send({ type: 'LOCAL_APPROVAL_EXPIRED', intentId: m.work.id, operationId: m.op!.id }).ok);
  } else if (boundary === '父工作期限到期') { m.at = m.work.deadline!; m.send({ type: 'TICK' }); }
  else m.at = original.hardDeadline + 1;
  assert(m.send({ type: 'SUPERVISE', trigger: 'timer' }).ok);
  if (boundary === '到期后重复恢复') for (let repeat = 0; repeat < 2; repeat++) {
    assert(m.send({ type: 'RECOVER', config: m.c.config }).ok); assert(m.send({ type: 'SUPERVISE', trigger: 'recover' }).ok);
  }
  assert.equal(taskHumanGate(m.c)?.id, gate.id); assert.equal(taskHumanGate(m.c)?.status, 'open');
  assert.equal(taskPhase(m.snapshot), 'waitingHuman'); assert.equal(m.c.outcome, null);
  assert.deepEqual(processingWindow(m.c), original); assert.equal(m.op!.startedAt, undefined);
  assert.notEqual(m.op!.approval!.status, 'approved');
  return { boundary, gateOpen: true, unstarted: true, outcome: m.c.outcome };
}
export function approvalGateRecovery(boundary: string) {
  const m = approvalGateModel(); assert(decideApproval(m).ok);
  if (boundary === '核对确认尚未启动后重新批准') assert(m.claim().ok);
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  if (boundary === '核对确认尚未启动后重新批准') assert(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1',
    resolution: 'notStarted', detail: '宿主可信journal证明该次没有启动' }).ok);
  const gate = taskHumanGate(m.c); assert(gate, 'A new approval question after recovery must retain mandatory human responsibility');
  assert.equal(gate.workId, m.work.id); assert.equal(gate.operationId, m.op!.id); assert.equal(gate.approvalId, m.op!.approval!.id);
  assert.notEqual(m.op!.approval!.id, 'approval1'); assert.equal(m.op!.status, 'awaitingApproval');
  m.at = processingWindow(m.c).hardDeadline + 1; assert(m.send({ type: 'SUPERVISE', trigger: 'timer' }).ok);
  assert.equal(taskHumanGate(m.c)?.id, gate.id); assert.equal(m.c.outcome, null); assert.equal(m.op!.startedAt, undefined);
  return { boundary, gateOpen: true, unstarted: true, outcome: m.c.outcome };
}
export function approvalGateParallel() {
  const sample = approvalModel().op!.approval!, m = new LocalModel(), owner = m.work;
  assert(m.send({ type: 'USER_INPUT', text: '请核查员独立核对来源', reviewTargets: ['B'] }).ok);
  let planner = m.c.intents.find(work => work.kind === 'facilitator')!; assert(planner);
  assert(m.send({ type: 'CLAIM', intentId: planner.id }).ok); planner = m.c.intents.find(work => work.id === planner.id)!;
  assert(m.send({ type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, discussionId: planner.discussionId,
    decision: { action: 'review', question: '核对独立来源', expected: '独立结果', reason: '用户明确要求独立核对' } }).ok);
  let member = m.c.intents.find(work => work.kind === 'assistance')!; assert(member);
  assert(m.send({ type: 'CLAIM', intentId: member.id }).ok); member = m.c.intents.find(work => work.id === member.id)!;
  for (const [index, work] of [owner, member].entries()) {
    const operationId = `parallel-op-${index}`, sessionId = `parallel-session-${index}`;
    const action = { type: 'runCli', executable: 'gh', args: ['pr', 'list'], execution: 'host', reason: sample.plan.reason };
    assert(m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId, namespace: 'c'.repeat(64), requestHash: String(index + 1).repeat(64), action,
      parentAttempt: work.attempt, fence: work, workspaceId: 'project', messages: [] }).ok);
    assert(m.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId, parentAttempt: work.attempt, fence: work, sessionId, leaseAvailable: true }).ok);
    assert(m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId, sessionId, approval: { ...sample, id: `parallel-approval-${index}` }, fence: work }).ok);
  }
  const gates = m.c.resilience!.gates.filter(gate => gate.scope === 'task' && gate.kind === 'authorization' && gate.status === 'open');
  assert.equal(gates.length, 2, 'A second independent approval may not silently cancel the first mandatory permission decision');
  m.at = processingWindow(m.c).hardDeadline + 1; assert(m.send({ type: 'SUPERVISE', trigger: 'timer' }).ok);
  assert.equal(m.c.resilience!.gates.filter(gate => gate.scope === 'task' && gate.status === 'open').length, 2);
  assert.equal(taskPhase(m.snapshot), 'waitingHuman'); assert.equal(m.c.outcome, null);
  return { boundary: '多个并行批准等待', gateOpen: true, unstarted: true, outcome: m.c.outcome };
}
export function approvalGateDecision(decision: string) {
  const m = approvalGateModel(), gate = taskHumanGate(m.c)!;
  const originalId = gate.id, approvalId = m.op!.approval!.id;
  let replied = false;
  if (decision.startsWith('过期后')) {
    m.at = processingWindow(m.c).hardDeadline + 1;
    assert(m.send({ type: 'LOCAL_APPROVAL_EXPIRED', intentId: m.work.id, operationId: m.op!.id }).ok);
    assert(m.send({ type: 'SUPERVISE', trigger: 'timer' }).ok);
  }
  if (decision === '当前精确批准' || decision === '当前精确拒绝' || decision === '过期后的精确拒绝') {
    assert(decideApproval(m, decision === '当前精确批准' ? 'approve' : 'deny', approvalId).ok); replied = true;
  } else if (decision === '错误工作身份' || decision === '错误操作身份' || decision === '错误批准身份') {
    const response = m.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: decision === '错误工作身份' ? 'wrong-work' : m.work.id,
      operationId: decision === '错误操作身份' ? 'wrong-op' : m.op!.id, approvalId: decision === '错误批准身份' ? 'wrong-approval' : approvalId,
      decision: 'approve', fence: m.work }); assert.equal(response.ok, false);
  } else if (decision === '普通用户补充') assert(m.send({ type: 'USER_INPUT', text: '提供补充资料，这不是权限决定' }).ok);
  else if (decision === '门的普通回复') assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'reply', text: '继续查看资料' }).ok);
  else if (decision === '过期后的批准') assert.equal(decideApproval(m, 'approve', approvalId).ok, false);
  else throw Error('Unknown approval gate decision: ' + decision);
  const saved = m.c.resilience!.gates.find(item => item.id === originalId)!;
  assert.equal(saved.status === 'answered', replied);
  if (!replied) { assert.equal(taskHumanGate(m.c)?.id, originalId); assert.equal(saved.status, 'open'); }
  assert.equal(m.op!.startedAt, undefined);
  assert.equal(m.op!.approval!.status === 'approved', decision === '当前精确批准');
  if (decision === '过期后的精确拒绝') { assert.equal(m.op!.result!.code, 'HOST_APPROVAL_DENIED'); assert.notEqual(m.c.outcome, 'complete'); }
  return { decision, replied, unstarted: true };
}
export function approvalGateSkip(timing: string) {
  const m = approvalGateModel(), gate = taskHumanGate(m.c)!, window = structuredClone(processingWindow(m.c));
  if (timing === '自动窗口到期以后') {
    m.at = window.hardDeadline + 1; assert(m.send({ type: 'SUPERVISE', trigger: 'timer' }).ok);
  }
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '明确跳过此项需要宿主授权的内容' }).ok);
  assert.equal(m.c.resilience!.gates.find(item => item.id === gate.id)!.status, 'skipped'); assert.equal(taskHumanGate(m.c), undefined);
  assert.equal(m.op!.status, 'cancelled'); assert.equal(m.op!.startedAt, undefined); assert.notEqual(m.op!.approval!.status, 'approved');
  assert(['done', 'cancelled'].includes(m.c.intents.find(work => work.id === m.work.id)!.status));
  assert(m.c.resilience!.skips.some(item => item.gateId === gate.id && item.authorization === 'human'));
  assert.deepEqual(processingWindow(m.c), window); assert.notEqual(m.c.outcome, 'complete');
  if (timing === '自动窗口到期以后') assert.equal(taskPhase(m.snapshot), 'ended');
  else assert(m.c.intents.some(work => work.id !== m.work.id && work.kind === 'owner' && work.status === 'pending'));
  return { timing, cancelled: true, unstarted: true, outcome: m.c.outcome };
}
export function verifyApprovalGates() {
  return [
    ...['批准token到期', '父工作期限到期', '自动处理窗口到期', '到期后重复恢复', '多个并行批准等待', '已批准但未领取时恢复', '核对确认尚未启动后重新批准'].map(approvalGateDeadline),
    ...['当前精确批准', '当前精确拒绝', '错误工作身份', '错误操作身份', '错误批准身份', '普通用户补充', '门的普通回复', '过期后的批准', '过期后的精确拒绝'].map(approvalGateDecision),
    ...['自动窗口以内', '自动窗口到期以后'].map(approvalGateSkip),
  ];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify({ model: 'real taskMachine with persist/restore at every event', results: verifyApprovalGates() }, null, 2));
