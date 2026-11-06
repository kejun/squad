import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import type { HostApproval } from '../src/local-operation.js';
export class SessionModel extends LocalModel {
  index = 0;
  prepare(change: (a: HostApproval) => void = () => {}, workspaceId = 'project') {
    const id = `command${++this.index}`;
    assert(this.send({ type: 'LOCAL_REQUEST', intentId: this.work.id, operationId: id, namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
      action: { type: 'runCli', executable: 'node', args: [id], execution: 'host', reason: '登录态' }, parentAttempt: this.work.attempt, messages: [], workspaceId, fence: this.work }).ok);
    assert(this.claimCurrent().ok);
    const approval: HostApproval = { id: `approval${this.index}`, digest: 'd'.repeat(64), status: 'pending', expiresAt: 900,
      plan: { executable: '/bin/node', args: [id], cwd: '/project', workspaceRevision: 'b'.repeat(64), executableHash: 'c'.repeat(64), environmentHash: 'e'.repeat(64), host: 'mac', account: 'user', reason: '登录态' } };
    change(approval);
    return this.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: this.work.id, operationId: id, sessionId: id, approval, fence: this.work });
  }
  get current() { return this.c.intents.find(w => w.id === this.work.id)!.localOperations!.at(-1)!; }
  decideCurrent(decision = 'approveSession') { return this.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: this.work.id, operationId: this.current.id, approvalId: this.current.approval!.id, decision, fence: this.work }); }
  claimCurrent() { return this.send({ type: 'LOCAL_CLAIM', intentId: this.work.id, operationId: `command${this.index}`, sessionId: `command${this.index}`, parentAttempt: this.work.attempt, leaseAvailable: true, fence: this.work }); }
  startCurrent() { return this.send({ type: 'LOCAL_STARTED', intentId: this.work.id, operationId: this.current.id, sessionId: this.current.sessionId }); }
  finishCurrent() { assert(this.claimCurrent().ok); assert(this.startCurrent().ok); return this.send({ type: 'LOCAL_RESULT', intentId: this.work.id, operationId: this.current.id, sessionId: this.current.sessionId, result: { ok: true, code: 'succeeded', data: {} }, settled: true, effectsKnown: true }); }
}
export function grantedSession() { const m = new SessionModel(); assert(m.prepare().ok); assert(m.decideCurrent().ok); assert(m.finishCurrent().ok); return m; }

export function askSessionHelper(m: SessionModel) {
  assert(m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'help-B', target: 'B', question: '核查命令结果', expected: '真实回执' }).ok);
  const helper = m.c.intents.find(work => work.kind === 'assistance')!; assert(m.send({ type: 'CLAIM', intentId: helper.id }).ok); m.work = m.c.intents.find(work => work.id === helper.id)!;
}
export function startSessionBackgroundHelper(m: SessionModel) {
  assert(m.send({ type: 'USER_INPUT', text: '请 B 同时核查', reviewTargets: ['B'] }).ok);
  const coordinator = m.c.intents.at(-1)!; assert(m.send({ type: 'CLAIM', intentId: coordinator.id }).ok);
  assert(m.send({ type: 'DISCUSSION_PLAN', workId: coordinator.id, fence: coordinator, discussionId: coordinator.discussionId,
    decision: { action: 'review', question: '核查工程', expected: '证据', reason: '用户邀请' } }).ok);
  const helper = m.c.intents.find(work => work.kind === 'assistance')!; assert(m.send({ type: 'CLAIM', intentId: helper.id }).ok); m.work = m.c.intents.find(work => work.id === helper.id)!;
}
