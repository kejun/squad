import assert from 'node:assert/strict';
import { debugEventTemplate, TaskSandbox } from '../src/task-debug.js';
import { persistTask, stepTask } from '../src/task.machine.js';

export function plannedSandbox(claimMember = false) {
  const sandbox = new TaskSandbox();
  const send = (event: object) => sandbox.send(JSON.stringify(event));
  send(debugEventTemplate(sandbox.snapshot, 'CLAIM'));
  send({ type: 'USER_INPUT', text: '所有人都参与讨论一下', reviewTargets: ['B'] });
  send(debugEventTemplate(sandbox.snapshot, 'CLAIM'));
  if (claimMember) {
    const work = sandbox.snapshot.context.intents.find(work => work.discussionId && work.status === 'inflight')!;
    send({ type: 'DISCUSSION_PLAN', workId: work.id, discussionId: work.discussionId, fence: { epoch: work.epoch, goalVersion: work.goalVersion }, decision: { action: 'review', question: '核查风险', expected: '依据与建议', reason: '用户邀请' } });
    send(debugEventTemplate(sandbox.snapshot, 'CLAIM'));
  }
  return sandbox;
}
export function completeWithTemplates(sandbox: TaskSandbox) {
  const send = (type: string) => {
    const next = sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, type)));
    assert.equal(next.context.reply.ok, true, type + ': ' + next.context.reply.code);
    return next;
  };
  send('DISCUSSION_PLAN'); send('CLAIM'); send('DISCUSSION_RESULT');
  assert.equal(sandbox.snapshot.context.discussion?.status, 'summarizing');
  send('CLAIM'); send('DISCUSSION_RESULT');
  assert.equal(sandbox.snapshot.context.discussion?.status, 'ready');
  send('DELIVER'); assert.equal(sandbox.snapshot.context.discussion?.status, 'delivered');
  send('CLAIM'); send('DELIVER'); send('CLAIM'); send('CHECK_RESULT');
  assert.equal(sandbox.snapshot.context.outcome, 'complete');
  assert.equal(sandbox.snapshot.context.messages.filter(message => message.kind === 'final').length, 1);
}
export function primaryDeliveryTemplate(sandbox: TaskSandbox) {
  const before = sandbox.snapshot;
  const primary = before.context.intents.find(work => work.kind === 'owner' && work.status === 'inflight')!;
  const member = before.context.intents.find(work => work.discussionId && work.kind === 'assistance' && work.status === 'inflight')!;
  const event = debugEventTemplate(before, 'DELIVER');
  assert.equal(event.workId, primary.id);
  const next = sandbox.send(JSON.stringify(event));
  assert.equal(next.context.reply.ok, true); assert.equal(next.context.discussion?.status, 'collecting');
  assert.equal(next.context.intents.find(work => work.id === member.id)?.status, 'inflight');
  assert.equal(next.context.candidate?.text, event.text);
}
export function rejectedDiscussionIdentity(sandbox: TaskSandbox, error: string) {
  const before = sandbox.snapshot;
  const member = before.context.intents.find(work => work.discussionId && work.kind === 'assistance' && work.status === 'inflight')!;
  const owner = before.context.intents.find(work => work.kind === 'owner' && work.status === 'inflight')!;
  const event = { type: 'DISCUSSION_RESULT' as const, id: 'invalid-identity', at: before.context.lastActivityAt + 1,
    workId: error === '关联主工作' ? owner.id : member.id,
    discussionId: error === '错误讨论轮次' ? 'other-round' : member.discussionId!,
    ...(error === '缺少版本边界' ? {} : { fence: { epoch: member.epoch, goalVersion: error === '过期版本边界' ? 99 : member.goalVersion } }),
    text: '无权结算当前工作的结果', status: 'success' as const };
  // Bypass only UI shape validation to exercise the actual domain rejection boundary.
  const next = stepTask(before, event);
  assert.equal(next.context.reply.ok, false);
  for (const work of [member, owner]) assert.equal(next.context.intents.find(item => item.id === work.id)?.status, 'inflight');
  assert.deepEqual(next.context.discussion?.results, before.context.discussion?.results);
  const valid = stepTask(next, { ...event, id: 'valid-result', workId: member.id, discussionId: member.discussionId!, fence: { epoch: member.epoch, goalVersion: member.goalVersion } });
  assert.equal(valid.context.reply.ok, true); assert.equal(valid.context.discussion?.results.length, 1);
  return { code: next.context.reply.code, snapshot: persistTask(next), valid: persistTask(valid) };
}
export function malformedDiscussion(sandbox: TaskSandbox) {
  const before = persistTask(sandbox.snapshot); const length = sandbox.history.length;
  assert.throws(() => sandbox.send('{"type":"DISCUSSION_PLAN"}'), /事件参数/);
  assert.deepEqual(persistTask(sandbox.snapshot), before); assert.equal(sandbox.history.length, length);
}
