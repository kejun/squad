import { afterEach, describe, expect, it } from 'vitest';
import { HostRetryFixture } from './host-retry-fixture.js';
import { hostUntil } from './host-approval-fixture.js';
let f: HostRetryFixture;
afterEach(async () => { await f?.close(); });
async function failed() { f = new HostRetryFixture(); await f.failedRound(); return f.snapshot().failedSandboxCommands![0]!; }
describe('失败沙箱记录的手动宿主申请（真实HTTP/SQLite/模型协议/宿主进程）', () => {
  it('[BT_L31] distinguishes a mandatory approval request from unapproved host execution in the actual prompt', async () => {
    await failed(); const prompt = f.requests[0]!.messages[0]!.content;
    expect(prompt).toContain('PERM_DENIED'); expect(prompt).toContain('Operation not permitted'); expect(prompt).toContain('ENOTFOUND localhost');
    expect(prompt).toContain('MUST first REQUEST'); expect(prompt).toContain('Do not declare the task impossible');
    expect(prompt).toContain('Ordinary business errors'); expect(prompt).toContain('Requesting approval is NOT executing');
  });
  it('[BT_L32] continues the ended task from a stored command without a new model selection', async () => {
    const command = await failed(); expect(command.canRequest).toBe(true);
    const count = f.requests.length;
    expect((await f.requestRetry()).status).toBe(200); const approval = await f.approval();
    expect(f.requests).toHaveLength(count); expect(await f.runs()).toBe(''); expect(approval.executable).toBe(command.executable);
    expect(approval.args).toEqual(command.args);
    expect((await f.request(f.decisionData(approval, 'approve'))).status).toBe(200); await f.complete();
    expect(await f.runs()).toBe('once\n');
    expect(f.requests.at(-1)!.messages.some(m => m.content.includes('"execution":"host"') && m.content.includes('local_tool_result'))).toBe(true);
  });
  it('[BT_L33] deduplicates identical clicks and prevents a second retry with a new request ID', async () => {
    await failed(); const data = f.retryData();
    expect((await f.requestRetry(data)).status).toBe(200); expect((await f.requestRetry(data)).status).toBe(200);
    expect((await f.requestRetry({ ...data, id: 'another-click' })).status).toBe(200);
    const approval = await f.approval(); expect(f.snapshot().hostApprovals).toHaveLength(1);
    expect((await f.request(f.decisionData(approval, 'approve'))).status).toBe(200); await f.complete(); expect(await f.runs()).toBe('once\n');
  });
  it('[BT_L45] batches two in-flight requests and returns both real receipts with one owner synthesis', async () => {
    f = new HostRetryFixture(); const [first, second] = await f.pauseAfterTwoFailures();
    const workBefore = f.service.engine.view(f.room.id, f.taskId)!.context.intents[0]!;
    const initial = await f.requestRetry(f.retryData(first)); const other = await f.requestRetry(f.retryData(second));
    expect(initial.status).toBe(200); expect(other.status).toBe(200);
    const repeated = await f.requestRetry(f.retryData(first));
    expect(repeated.data).toEqual(initial.data);
    expect(f.snapshot().failedSandboxCommands?.map(row => row.retry?.status)).toEqual(['pending', 'pending']);
    expect(f.snapshot().hostApprovals).toEqual([]);
    expect(f.service.engine.view(f.room.id, f.taskId)!.context.intents[0]).toMatchObject({ id: workBefore.id, epoch: workBefore.epoch, status: 'inflight' });
    f.resumeMain();
    const approveFirst = await f.approval(); expect(approveFirst.args.at(-1)).toBe('command-1');
    expect((await f.request(f.decisionData(approveFirst, 'approve'))).status).toBe(200);
    const approveSecond = await hostUntil(() => f.snapshot().hostApprovals?.[0], approval => approval?.operationId !== approveFirst.operationId && approval?.args.at(-1) === 'command-2');
    expect(await f.runs()).toBe('once\n');
    expect((await f.request(f.decisionData(approveSecond!, 'approve'))).status).toBe(200);
    const result = await f.complete(); expect(result.tasks.at(-1)?.outcome).toBe('complete'); expect(await f.runs()).toBe('once\nonce\n');
    expect(f.requests).toHaveLength(4);
    expect(f.requests.at(-1)!.messages.filter(m => m.content.startsWith('{"type":"local_tool_result",') && m.content.includes('"execution":"host"'))).toHaveLength(2);
    expect(f.snapshot().failedSandboxCommands?.map(row => row.retry?.status)).toEqual(['settled', 'settled']);
  });
  it('[BT_L34] rejects cross-origin requests and client-supplied replacement arguments', async () => {
    await failed(); const data = f.retryData();
    expect((await f.requestRetry(data, 'http://untrusted.example')).status).toBe(403);
    expect((await f.requestRetry({ ...data, args: ['changed'] })).status).toBe(400);
    expect((await f.requestRetry({ ...data, sourceRequestHash: 'changed', id: 'forged-hash' })).status).toBe(409);
    expect(await f.runs()).toBe(''); expect(f.snapshot().hostApprovals).toEqual([]);
  });
  it('[BT_L34] refuses to revive an older task when another task is active', async () => {
    await failed(); const data = f.retryData();
    f.service.submit(f.room.id, { id: 'new-task', intent: 'new', text: '新任务' });
    expect((await f.requestRetry(data)).status).toBe(409); expect(await f.runs()).toBe('');
  });
  it('[BT_L34] blocks uncertain CLI effects at the actual trusted HTTP entry', async () => {
    f = new HostRetryFixture();
    f.sandboxBackend = { available: true, async execute() { return { result: { ok: false, code: 'cancelled', data: {} }, settled: false, effectsKnown: false }; } };
    await f.open(); if (f.action.type !== 'runCli') throw new Error('fixture CLI required'); f.action = { ...f.action, execution: 'sandbox' }; f.submit();
    await hostUntil(() => f.operation(), op => op?.status === 'uncertain');
    const c = f.service.engine.view(f.room.id, f.taskId)!.context, source = c.intents.find(w => w.localOperations?.length)!;
    expect((await f.requestRetry({ id: 'uncertain-retry', taskId: f.taskId, workId: source.id, operationId: f.operation()!.id, sourceRequestHash: f.operation()!.requestHash })).status).toBe(409);
    expect(await f.runs()).toBe('');
  });
});
