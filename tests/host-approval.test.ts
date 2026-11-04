import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';

let f: HostApprovalFixture;
afterEach(async () => { await f?.close(); });
async function setup() { f = new HostApprovalFixture(); await f.open(); f.submit(); return f.approval(); }
describe('宿主授权：真实 HTTP、SQLite、模型协议和宿主子进程', () => {
  it('[BT_L23] [BT_L24] waits without model retries, then consumes one exact approval and returns a scrubbed real receipt', async () => {
    const approval = await setup(), requestCount = f.requests.length, usage = f.snapshot().tasks.at(-1)!.usage.ordinary;
    expect(approval.executable).toBe(f.executable); expect(approval.reason).toContain('终端登录态');
    expect(await f.runs()).toBe(''); expect(f.requests).toHaveLength(1);
    f.service.engine.tick(f.room.id);
    expect(f.requests).toHaveLength(requestCount); expect(f.snapshot().tasks.at(-1)!.usage.ordinary).toBe(usage);
    const data = f.decisionData(approval, 'approve');
    expect((await f.request(data)).status).toBe(200); expect((await f.request(data)).status).toBe(200);
    await f.assertSuccessfulRun();
  });
  it('[BT_L25] returns a denial to the owner without starting any process', async () => {
    const approval = await setup(); expect((await f.request(f.decisionData(approval, 'deny'))).status).toBe(200);
    await f.complete(); expect(await f.runs()).toBe(''); expect(f.operation()?.result?.code).toBe('HOST_APPROVAL_DENIED');
    expect(f.requests.at(-1)?.messages.some(m => m.content.includes('HOST_APPROVAL_DENIED'))).toBe(true);
    expect((await f.request(f.decisionData(approval, 'approve'))).status).toBe(409);
  });
  it.each(['工作区内容变化', '可执行文件变化'])('[BT_L26] refuses %s after approval preparation', async change => {
    const approval = await setup();
    if (change === '工作区内容变化') await writeFile(join(f.source, 'changed.txt'), 'changed');
    else await writeFile(f.executable, '#!/usr/bin/env node\nconsole.log("changed")\n');
    expect((await f.request(f.decisionData(approval, 'approve'))).status).toBe(200);
    await f.complete(); expect(await f.runs()).toBe(''); expect(f.operation()?.result?.code).toBe('HOST_APPROVAL_STALE');
  });
  it('[BT_L26] rejects a stopped approval through the real HTTP endpoint', async () => {
    const approval = await setup(); f.service.stop(f.room.id, approval.taskId, 'stop1');
    expect((await f.request(f.decisionData(approval, 'approve'))).status).toBe(409); expect(await f.runs()).toBe('');
  });
  it('[BT_L27] preserves pending approvals on graceful restart and requires a fresh click', async () => {
    const before = await setup(); await f.restart(); const after = await f.approval();
    expect(after.approvalId).not.toBe(before.approvalId); expect(await f.runs()).toBe(''); expect(f.requests).toHaveLength(1);
    expect((await f.request(f.decisionData(before, 'approve'))).status).toBe(409);
    expect((await f.request(f.decisionData(after, 'approve'))).status).toBe(200); await f.assertSuccessfulRun();
  });
  it('[BT_L28] rejects cross-origin, missing-origin, forged arguments and a different approval', async () => {
    const approval = await setup(), data = f.decisionData(approval, 'approve');
    expect((await f.request(data, 'http://untrusted.example')).status).toBe(403);
    expect((await f.request(data, null)).status).toBe(403);
    expect((await f.request({ ...data, executable: '/bin/sh' })).status).toBe(400);
    expect((await f.request({ ...data, approvalId: 'forged', id: 'other-request' })).status).toBe(409);
    expect(f.snapshot().hostApprovals).toHaveLength(1); expect(await f.runs()).toBe('');
  });
  it('[BT_L29] never upgrades an ordinary sandbox failure', async () => {
    f = new HostApprovalFixture(); await f.open(); f.action = { type: 'runCli', executable: f.executable, args: [] }; f.submit();
    await hostUntil(() => f.operation(), op => op?.status === 'failed');
    expect(f.operation()?.result?.code).toBe('CLI_SANDBOX_UNAVAILABLE'); expect(f.snapshot().hostApprovals).toEqual([]); expect(await f.runs()).toBe('');
  });
});
