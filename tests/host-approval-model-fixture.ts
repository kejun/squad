import assert from 'node:assert/strict';
import { LocalModel, localModelInput } from './local-model-fixture.js';
import { localAwaitingApproval, localPhysicalPending, type HostApproval } from '../src/local-operation.js';

export const hostAction = { type: 'runCli' as const, executable: 'gh', args: ['pr', 'list'], execution: 'host' as const, reason: '使用已登录账号' };
export function approvalModel() {
  const m = new LocalModel(); assert(m.request(hostAction).ok); assert(m.claim().ok);
  const approval: HostApproval = { id: 'approval1', digest: 'd'.repeat(64), status: 'pending', expiresAt: 900,
    plan: { executable: '/usr/bin/gh', args: ['pr', 'list'], cwd: '/task', workspaceRevision: 'b'.repeat(64), executableHash: 'c'.repeat(64),
      environmentHash: 'e'.repeat(64), host: 'my-mac', account: 'user', reason: hostAction.reason } };
  assert(m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', approval, fence: m.work }).ok);
  return m;
}
export const decideApproval = (m: LocalModel, decision = 'approve', approvalId = 'approval1') => m.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: m.work.id, operationId: 'op1', approvalId, decision, fence: m.work });
export function assertWaitingApproval(m: LocalModel) { assert.equal(m.op?.status, 'awaitingApproval'); assert(localAwaitingApproval(m.c.intents[0]!)); assert(!localPhysicalPending(m.c.intents[0]!));
  assert.equal(m.c.usage.ordinary, 1); assert.equal(m.c.intents[0]!.localCheckpoint?.pendingOperationId, 'op1');
}
export function assertApprovedReceipt(m: LocalModel) {
  assert.equal(m.c.usage.ordinary, 2); assert.equal(m.op?.status, 'succeeded'); assert.equal(m.c.intents[0]!.localCheckpoint?.pendingOperationId, undefined);
}
export function assertDeniedReceipt(m: LocalModel) { assert.equal(m.op?.result?.code, 'HOST_APPROVAL_DENIED');
  assert(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content.includes('HOST_APPROVAL_DENIED')); assert.equal(m.c.usage.ordinary, 1);
}
export function assertApprovalBoundary(m: LocalModel, change: string) {
  switch (change) {
    case '停止任务': assert(m.send({ type: 'STOP' }).ok); assert.equal(m.op?.status, 'cancelled'); assert.equal(m.op?.approval?.status, 'expired'); assert(!decideApproval(m).ok); assert(!m.claim().ok); break;
    case '超过期限': m.at = 900; assert.equal(decideApproval(m).code, 'HOST_APPROVAL_EXPIRED'); assert(m.send({ type: 'LOCAL_APPROVAL_EXPIRED', intentId: m.work.id, operationId: 'op1' }).ok); assert.equal(m.op?.result?.code, 'HOST_APPROVAL_EXPIRED'); assert.equal(m.op?.approval?.status, 'expired'); break;
    case '批准后超过期限': assert(decideApproval(m).ok); m.at = 900; assert.equal(m.claim().code, 'HOST_APPROVAL_EXPIRED'); assert.equal(m.c.usage.ordinary, 1); break;
    case '目标版本变化': m.c.goalVersion++; assert.equal(decideApproval(m).code, 'STALE_WORK'); break;
    case '批准标识不匹配': assert.equal(decideApproval(m, 'approve', 'other').code, 'HOST_APPROVAL_MISMATCH'); assert.equal(m.op?.status, 'awaitingApproval'); break;
    case '权限关闭': m.c.config.localTools = { enabled: false }; assert.equal(decideApproval(m).code, 'LOCAL_TOOLS_DISABLED'); break;
    default: throw Error('Unknown model approval boundary: ' + change);
  }
  assert.equal(m.op?.startedAt, undefined);
}
export function recoverApproval(m: LocalModel, window: string) { assert(decideApproval(m).ok);
  if (window !== '尚未领取') { assert(m.claim().ok); if (window === '已经启动') assert(m.started().ok); }
  assert(m.send({ type: 'RECOVER', config: localModelInput().config }).ok);
  if (window === '领取后确认未启动') assert(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'notStarted', detail: 'No durable launch journal' }).ok);
  return m;
}
export function assertRecoveredApproval(m: LocalModel, strategy: string) {
  if (strategy === '等待核对') {
    assert.equal(m.op?.status, 'uncertain'); assert.equal(m.c.intents[0]!.status, 'uncertain'); assert(!decideApproval(m).ok); assert(!m.claim().ok);
  } else {
    assert.equal(m.op?.status, 'awaitingApproval'); assert.equal(m.op?.approval?.status, 'pending'); assert.notEqual(m.op?.approval?.id, 'approval1');
    assert(!m.claim().ok); assert.equal(m.send({ type: 'CLAIM', intentId: m.work.id }).code, 'HOST_APPROVAL_REQUIRED');
    assert.equal(decideApproval(m).code, 'HOST_APPROVAL_MISMATCH'); assert(decideApproval(m, 'approve', m.op!.approval!.id).ok);
    assert(m.send({ type: 'CLAIM', intentId: m.work.id }).ok);
  }
}
export function assertHostRequestRejected(input: string) {
  const m = new LocalModel();
  if (input === '尚未批准就启动') { assert(m.request(hostAction).ok); assert(m.claim().ok); assert.equal(m.started().code, 'HOST_APPROVAL_REQUIRED'); }
  else {
    const actions: Record<string, unknown> = { '未知执行环境': { ...hostAction, execution: 'unknown' }, '缺少申请原因': { ...hostAction, reason: '' }, '模型伪造批准': { ...hostAction, approved: true } };
    assert(Object.hasOwn(actions, input)); assert.equal(m.request(actions[input] as typeof hostAction).code, 'INVALID_LOCAL_REQUEST'); assert.equal(m.op, undefined);
  }
  assert.equal(m.c.usage.ordinary, 1);
  return m;
}
