import { afterEach, describe, expect, it } from 'vitest';
import { HostSessionFixture } from './host-session-fixture.js';
let f: HostSessionFixture;
afterEach(async () => { await f?.close(); });
async function pending() { f = new HostSessionFixture(); return f.pending(); }

describe('任务会话宿主授权接线：真实HTTP、SQLite及宿主进程', () => {
  it('[BT_L35] executes distinct commands once from one session approval and returns both real receipts', async () => {
    const a = await pending(); const data = f.decisionData(a, 'approveSession');
    expect((await f.request(data)).status).toBe(200); expect((await f.request(data)).status).toBe(200);
    await f.assertTwoRuns();
    expect(f.requests.at(-1)!.messages.filter(m => m.content.startsWith('{"type":"local_tool_result",')).length).toBe(2);
  });
  it('[BT_L35] keeps allow-once limited to the selected command', async () => {
    const a = await pending(); expect((await f.request(f.decisionData(a, 'approve'))).status).toBe(200);
    const second = await f.secondApproval(); expect(second.operationId).not.toBe(a.operationId);
    expect(await f.runs()).toBe('once\n'); expect(f.snapshot().hostSessions).toEqual([]);
  });
  it('[BT_L35] preserves an active grant across repeated page snapshot reads', async () => {
    const a = await pending(); const grant = f.grantWithoutNotify(a);
    expect((await f.refresh()).hostSessions).toEqual([grant]); expect((await f.refresh()).hostSessions).toEqual([grant]);
    expect(await f.runs()).toBe('');
  });
  it('[BT_L36] clears a saved session on service recovery and waits for a fresh user decision', async () => {
    const a = await pending(); f.grantWithoutNotify(a); const saved = f.savedRoom();
    await f.restart(saved); const restored = await f.approval();
    expect(restored.approvalId).not.toBe(a.approvalId); expect(f.snapshot().hostSessions).toEqual([]); expect(await f.runs()).toBe('');
  });
  it('[BT_L37] revokes an unconsumed session and restores per-command approval', async () => {
    const a = await pending(); const grant = f.grantWithoutNotify(a);
    expect((await f.revoke(grant.grantId)).status).toBe(200); const restored = await f.approval();
    expect(restored.approvalId).not.toBe(a.approvalId); expect(f.snapshot().hostSessions).toEqual([]); expect(await f.runs()).toBe('');
    expect((await f.request(f.decisionData(restored, 'approve'))).status).toBe(200);
    await f.secondApproval(); expect(await f.runs()).toBe('once\n');
  });
  it('[BT_L37] denies cross-origin grants and revocations, unknown decisions and model-supplied grants', async () => {
    const a = await pending(); const data = f.decisionData(a, 'approveSession');
    expect((await f.request(data, 'http://other.example')).status).toBe(403);
    expect((await f.request({ ...data, decision: 'approveForever' })).status).toBe(400);
    expect((await f.request({ ...data, grantId: 'forged' })).status).toBe(400);
    const grant = f.grantWithoutNotify(a); expect((await f.revoke(grant.grantId, 'http://other.example')).status).toBe(403);
    expect((await f.revoke('forged-grant')).status).toBe(409); expect(f.snapshot().hostSessions).toHaveLength(1); expect(await f.runs()).toBe('');
  });
});
