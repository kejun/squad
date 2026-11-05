import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { grantedSession, SessionModel } from './host-session-model-fixture.js';
import type { Intent } from '../src/types.js';

function claimHelper(m: SessionModel, helper: Intent) {
  assert(m.send({ type: 'CLAIM', intentId: helper.id }).ok);
  m.work = m.c.intents.find(work => work.id === helper.id)!;
}
function askHelper(m: SessionModel) {
  assert(m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'help-B', target: 'B', question: '核查命令结果', expected: '真实回执' }).ok);
  claimHelper(m, m.c.intents.find(work => work.kind === 'assistance')!);
}
function startBackgroundHelper(m: SessionModel) {
  assert(m.send({ type: 'USER_INPUT', text: '请 B 同时核查', reviewTargets: ['B'] }).ok);
  const coordinator = m.c.intents.at(-1)!;
  assert(m.send({ type: 'CLAIM', intentId: coordinator.id }).ok);
  assert(m.send({ type: 'DISCUSSION_PLAN', workId: coordinator.id, fence: coordinator, discussionId: coordinator.discussionId,
    decision: { action: 'review', question: '核查工程', expected: '证据', reason: '用户邀请' } }).ok);
  claimHelper(m, m.c.intents.find(work => work.kind === 'assistance')!);
}

describe('任务会话宿主授权在成员之间的范围', () => {
  it('[BT_L35] lets the same-task helper reuse its owner grant and charges the helper command once', () => {
    const m = grantedSession();
    const grantId = m.c.hostSession!.id;
    askHelper(m);

    expect(m.prepare().ok).toBe(true);

    expect(m.work.target).toBe('B');
    expect(m.current.status).toBe('queued');
    expect(m.current.approval?.sessionGrantId).toBe(grantId);
    expect(m.finishCurrent().ok).toBe(true);
    expect(m.c.usage.ordinary).toBe(4);
  });

  it('[BT_L35] adopts an already waiting parallel helper command when the owner allows this session', () => {
    const m = new SessionModel();
    m.prepare();
    const owner = m.work;
    startBackgroundHelper(m);
    m.prepare();
    const helper = m.work;
    expect(m.current.status).toBe('awaitingApproval');
    m.work = owner;

    expect(m.decideCurrent().ok).toBe(true);

    expect(m.current.status).toBe('queued');
    expect(m.current.approval?.sessionGrantId).toBe(m.c.hostSession?.id);
    m.work = helper;
    expect(m.current.status).toBe('queued');
    expect(m.current.approval?.sessionGrantId).toBe(m.c.hostSession?.id);
    expect(m.current.startedAt).toBeUndefined();
  });

  it('[BT_L36] leaves a parallel helper pending when its prepared host environment differs', () => {
    const m = new SessionModel();
    m.prepare();
    const owner = m.work;
    startBackgroundHelper(m);
    m.prepare(approval => { approval.plan.environmentHash = 'f'.repeat(64); });
    const helper = m.work;
    m.work = owner;

    expect(m.decideCurrent().ok).toBe(true);

    m.work = helper;
    expect(m.current.status).toBe('awaitingApproval');
    expect(m.current.approval?.status).toBe('pending');
    expect(m.current.approval?.sessionGrantId).toBeUndefined();
  });
});
