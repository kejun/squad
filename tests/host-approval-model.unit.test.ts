import { describe, expect, it } from 'vitest';
import { LocalModel, localModelInput } from './local-model-fixture.js';
import { localAwaitingApproval, localPhysicalPending, validLocalAction, type HostApproval } from '../src/local-operation.js';

export const hostAction = { type: 'runCli' as const, executable: 'gh', args: ['pr', 'list'], execution: 'host' as const, reason: '使用已登录账号' };
export function approvalModel() {
  const m = new LocalModel();
  m.request(hostAction); m.claim();
  const approval: HostApproval = { id: 'approval1', digest: 'd'.repeat(64), status: 'pending', expiresAt: 900,
    plan: { executable: '/usr/bin/gh', args: ['pr', 'list'], cwd: '/task', workspaceRevision: 'b'.repeat(64), executableHash: 'c'.repeat(64),
      environmentHash: 'e'.repeat(64), host: 'my-mac', account: 'user', reason: hostAction.reason } };
  m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', approval, fence: m.work });
  return m;
}
const decide = (m: LocalModel, decision = 'approve', approvalId = 'approval1') => m.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: m.work.id, operationId: 'op1', approvalId, decision, fence: m.work });

describe('按次宿主命令授权（真实 taskMachine，每步持久化恢复）', () => {
  it('[BT_L23] waits with a bound command and no process or execution charge', () => {
    const m = approvalModel();
    expect(m.c.reply.ok).toBe(true);
    expect(m.op?.status).toBe('awaitingApproval');
    expect(localAwaitingApproval(m.c.intents[0]!)).toBe(true);
    expect(localPhysicalPending(m.c.intents[0]!)).toBe(false);
    expect(m.c.usage.ordinary).toBe(1);
    expect(m.c.intents[0]!.localCheckpoint?.pendingOperationId).toBe('op1');
    expect(m.claim().ok).toBe(false);
    expect(m.started().ok).toBe(false);
  });
  it('[BT_L24] charges only the approved execution and accepts a single receipt', () => {
    const m = approvalModel();
    expect(decide(m).ok).toBe(true);
    expect(m.claim().ok).toBe(true);
    expect(m.started().ok).toBe(true);
    expect(m.result().ok).toBe(true);
    expect(m.c.usage.ordinary).toBe(2);
    expect(m.op?.status).toBe('succeeded');
    expect(m.c.intents[0]!.localCheckpoint?.pendingOperationId).toBeUndefined();
    expect(decide(m).ok).toBe(false);
    expect(m.result().ok).toBe(false);
  });
  it('[BT_L25] delivers a denial without charging or launching and rejects a later approval', () => {
    const m = approvalModel();
    expect(decide(m, 'deny').ok).toBe(true);
    expect(m.op?.result?.code).toBe('HOST_APPROVAL_DENIED');
    expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('HOST_APPROVAL_DENIED');
    expect(m.c.usage.ordinary).toBe(1);
    expect(decide(m).ok).toBe(false);
    expect(m.claim().ok).toBe(false);
  });
  it('[BT_L26] refuses a different approval identity', () => {
    const m = approvalModel();
    expect(decide(m, 'approve', 'other').code).toBe('HOST_APPROVAL_MISMATCH');
    expect(m.op?.status).toBe('awaitingApproval');
  });
  it('[BT_L26] expires a waiting approval and returns a receipt', () => {
    const m = approvalModel(); m.at = 900;
    expect(decide(m).code).toBe('HOST_APPROVAL_EXPIRED');
    expect(m.send({ type: 'LOCAL_APPROVAL_EXPIRED', intentId: m.work.id, operationId: 'op1' }).ok).toBe(true);
    expect(m.op?.result?.code).toBe('HOST_APPROVAL_EXPIRED');
    expect(m.op?.approval?.status).toBe('expired');
  });
  it('[BT_L26] refuses an approved command after its permit expires', () => {
    const m = approvalModel(); decide(m); m.at = 900;
    expect(m.claim().code).toBe('HOST_APPROVAL_EXPIRED');
    expect(m.c.usage.ordinary).toBe(1);
  });
  it('[BT_L26] revokes a waiting approval when the task stops', () => {
    const m = approvalModel(); m.send({ type: 'STOP' });
    expect(m.op?.status).toBe('cancelled');
    expect(m.op?.approval?.status).toBe('expired');
    expect(decide(m).ok).toBe(false);
    expect(m.claim().ok).toBe(false);
  });
  it('[BT_L26] refuses an old goal approval', () => {
    const m = approvalModel(); m.c.goalVersion++;
    expect(decide(m).code).toBe('STALE_WORK');
  });
  it('[BT_L26] respects revoked local capabilities', () => {
    const m = approvalModel(); m.c.config.localTools = { enabled: false };
    expect(decide(m).code).toBe('LOCAL_TOOLS_DISABLED');
  });
  it('[BT_L27] restores an unconsumed permit as a new pending approval without model work', () => {
    const m = approvalModel(); decide(m);
    expect(m.send({ type: 'RECOVER', config: localModelInput().config }).ok).toBe(true);
    expect(m.op?.status).toBe('awaitingApproval');
    expect(m.op?.approval?.status).toBe('pending');
    expect(m.op?.approval?.id).not.toBe('approval1');
    expect(m.send({ type: 'CLAIM', intentId: m.work.id }).code).toBe('HOST_APPROVAL_REQUIRED');
    expect(decide(m).code).toBe('HOST_APPROVAL_MISMATCH');
    expect(decide(m, 'approve', m.op!.approval!.id).ok).toBe(true);
    expect(m.send({ type: 'CLAIM', intentId: m.work.id }).ok).toBe(true);
  });
  it('[BT_L27] never replays a host command claimed before a crash', () => {
    const m = approvalModel(); decide(m); m.claim(); m.started();
    m.send({ type: 'RECOVER', config: localModelInput().config });
    expect(m.op?.status).toBe('uncertain');
    expect(m.c.intents[0]!.status).toBe('uncertain');
    expect(decide(m).ok).toBe(false);
    expect(m.claim().ok).toBe(false);
  });
  it('[BT_L27] requires a fresh permit even after trusted reconciliation proves no process started', () => {
    const m = approvalModel(); decide(m); m.claim(); m.send({ type: 'RECOVER', config: localModelInput().config });
    expect(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'notStarted', detail: 'No durable launch journal' }).ok).toBe(true);
    expect(m.op?.status).toBe('awaitingApproval');
    expect(m.op?.approval?.status).toBe('pending');
    expect(m.op?.approval?.id).not.toBe('approval1');
    expect(m.claim().ok).toBe(false);
  });
  it('[BT_L28] treats a claimed host command without a permit as preparation only', () => {
    const m = new LocalModel(); m.request(hostAction); m.claim();
    expect(m.started().code).toBe('HOST_APPROVAL_REQUIRED');
    expect(m.c.usage.ordinary).toBe(1);
  });
  it('[BT_L29] leaves ordinary failed sandbox operations failed', () => {
    const m = new LocalModel(); m.request(); m.claim();
    m.result({ result: { ok: false, code: 'failed', data: { exitCode: 1 } } });
    expect(m.op?.status).toBe('failed');
    expect(m.op?.approval).toBeUndefined();
  });
  it.each([
    { ...hostAction, execution: 'unknown' }, { ...hostAction, reason: '' }, { ...hostAction, approved: true },
  ])('[BT_L28] rejects invalid host requests and model-supplied permission: %j', action => {
    expect(validLocalAction(action)).toBe(false);
  });
});
