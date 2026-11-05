import { describe, expect, it } from 'vitest';
import { grantedSession, SessionModel } from './host-session-model-fixture.js';
import type { HostApproval } from '../src/local-operation.js';
import { localModelInput } from './local-model-fixture.js';

describe('任务会话宿主授权：真实XState、每步持久化', () => {
  it('[BT_L35] approves a distinct next command while retaining exact per-operation plans and charges', () => {
    const m = grantedSession();
    expect(m.prepare(a => { a.plan.workspaceRevision = 'f'.repeat(64); a.plan.executable = '/bin/gh'; }).ok).toBe(true);
    expect(m.current.status).toBe('queued'); expect(m.current.approval?.sessionGrantId).toBe(m.c.hostSession?.id);
    expect(m.finishCurrent().ok).toBe(true); expect(m.c.usage.ordinary).toBe(3);
  });
  it('[BT_L35] keeps allow-once scoped to one command', () => {
    const m = new SessionModel(); m.prepare(); m.decideCurrent('approve'); m.finishCurrent(); m.prepare();
    expect(m.c.hostSession).toBeUndefined(); expect(m.current.status).toBe('awaitingApproval');
  });
  it.each([
    { name: 'host', change: (a: HostApproval) => { a.plan.host = 'other'; } },
    { name: 'account', change: (a: HostApproval) => { a.plan.account = 'other'; } },
    { name: 'environment', change: (a: HostApproval) => { a.plan.environmentHash = 'f'.repeat(64); } },
  ])('[BT_L36] requests a fresh decision on $name mismatch', ({ change }) => {
    const m = grantedSession(); m.prepare(change); expect(m.current.status).toBe('awaitingApproval');
  });
  it('[BT_L36] cannot reuse a grant for another workspace or independent task', () => {
    const m = grantedSession(); m.prepare(undefined, 'other-project'); expect(m.current.status).toBe('awaitingApproval');
    const other = new SessionModel(); other.prepare(); expect(other.current.status).toBe('awaitingApproval');
  });
  it.each(['STOP', 'EXHAUSTED', 'RECOVER'])('[BT_L36] clears scope on %s', type => {
    const m = grantedSession(); m.send({ type, config: localModelInput().config, reason: 'test' }); expect(m.c.hostSession).toBeUndefined();
  });
  it('[BT_L36] clears scope when explicitly continuing a waiting round', () => {
    const m = grantedSession(); m.send({ type: 'WAIT_USER', workId: m.work.id, question: '确认', fence: m.work });
    expect(m.send({ type: 'CONTINUE' }).ok).toBe(true); expect(m.c.hostSession).toBeUndefined();
  });
  it('[BT_L36] clears scope on goal change', () => {
    const m = grantedSession(); m.send({ type: 'USER_INPUT', text: 'new', goal: { text: 'new', constraints: [], criteria: [], requiredArtifacts: 0 } });
    expect(m.c.hostSession).toBeUndefined();
  });
  it('[BT_L36] rejects a launch when permission is revoked after the operation was claimed', () => {
    const m = grantedSession(); m.prepare(); m.claimCurrent(); m.c.config.localTools = { enabled: false };
    expect(m.startCurrent().code).toBe('HOST_APPROVAL_REQUIRED');
  });
  it('[BT_L37] revokes queued session approvals and requires a fresh pending identity', () => {
    const m = grantedSession(); m.prepare(); const old = m.current.approval!.id;
    expect(m.send({ type: 'REVOKE_HOST_SESSION', grantId: m.c.hostSession!.id, fence: m.work }).ok).toBe(true);
    expect(m.current.status).toBe('awaitingApproval'); expect(m.current.approval?.id).not.toBe(old); expect(m.c.hostSession).toBeUndefined();
  });
  it('[BT_L37] revocation prevents claimed commands from starting', () => {
    const m = grantedSession(); m.prepare(); m.claimCurrent(); m.send({ type: 'REVOKE_HOST_SESSION', grantId: m.c.hostSession!.id, fence: m.work });
    expect(m.startCurrent().code).toBe('HOST_APPROVAL_REQUIRED');
  });
  it('[BT_L37] refuses a stale revocation and model-injected grant on preparation', () => {
    const m = new SessionModel();
    expect(m.prepare(a => { a.sessionGrantId = 'model-forgery'; }).code).toBe('INVALID_HOST_APPROVAL');
    expect(m.send({ type: 'REVOKE_HOST_SESSION', grantId: 'forged', fence: m.work }).code).toBe('HOST_SESSION_MISMATCH');
  });
});
