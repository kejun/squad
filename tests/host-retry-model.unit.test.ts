import { describe, expect, it } from 'vitest';
import { LocalModel } from './local-model-fixture.js';

import { failedSandbox, request } from './host-retry-model-fixture.js';
describe('用户从失败沙箱记录续办（真实XState，每步持久化）', () => {
  it('[BT_L32] revives an ended round with a fixed, unapproved host operation and a saved model checkpoint', () => {
    const m = failedSandbox(true); expect(m.c.outcome).toBe('complete');
    expect(request(m).ok).toBe(true);
    const retry = m.c.intents.at(-1)!;
    expect(m.snapshot.value).toBe('running'); expect(m.c.outcome).toBeNull(); expect(m.c.goalVersion).toBe(1);
    expect(retry.target).toBe('A'); expect(retry.status).toBe('pending');
    expect(retry.localOperations?.[0]?.action).toEqual({ type: 'runCli', executable: 'node', args: ['script.js'], execution: 'host', reason: '用户请求在宿主重试已确定失败的沙箱命令' });
    expect(retry.localOperations?.[0]?.approval).toBeUndefined();
    expect(retry.localCheckpoint?.pendingOperationId).toBe(retry.localOperations?.[0]?.id);
    expect(m.op?.status).toBe('failed'); expect(m.op?.hostRetryIntentId).toBe(retry.id);
  });
  it('[BT_L33] creates one retry even when a different click identity is received twice', () => {
    const m = failedSandbox(true); request(m); const count = m.c.intents.length;
    expect(request(m).code).toBe('HOST_RETRY_ALREADY_REQUESTED'); expect(m.c.intents).toHaveLength(count);
  });
  it('[BT_L32] cancels safe inflight model work before the new owner continuation runs', () => {
    const m = failedSandbox(); request(m);
    expect(m.c.intents.some(work => work.kind === 'cancel' && work.payload.intentId === m.work.id)).toBe(true);
    expect(m.c.intents.at(-1)?.localOperations?.[0]?.status).toBe('queued');
  });
  it('[BT_L32] retires outstanding assistance when the user explicitly continues from a failed command', () => {
    const m = failedSandbox();
    m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'H', target: 'B', question: '核查', expected: '证据' });
    expect(request(m).ok).toBe(true);
    expect(m.c.assists[0]?.status).toBe('cancelled');
    expect(m.c.intents.at(-1)?.target).toBe('A');
  });
  it.each([
    { name: 'stopped', change: (m: LocalModel) => { m.c.stopped = true; } },
    { name: 'stale goal', change: (m: LocalModel) => { m.c.goalVersion++; } },
    { name: 'uncertain effects', change: (m: LocalModel) => { m.op!.status = 'uncertain'; } },
    { name: 'disabled', change: (m: LocalModel) => { m.c.config.localTools = { enabled: false }; } },
    { name: 'succeeded', change: (m: LocalModel) => { m.op!.status = 'succeeded'; m.op!.result!.ok = true; } },
    { name: 'host command', change: (m: LocalModel) => { if (m.op!.action.type === 'runCli') m.op!.action.execution = 'host'; } },
    { name: 'pending local command', change: (m: LocalModel) => { m.c.intents[0]!.localOperations!.push({ ...m.op!, id: 'other', status: 'running' }); } },
    { name: 'truncated effects', change: (m: LocalModel) => { m.op!.result!.data.outputFilesTruncated = true; } },
    { name: 'budget', change: (m: LocalModel) => { m.c.config.limits.ordinary = m.c.usage.ordinary; } },
  ])('[BT_L34] refuses $name without creating another operation', ({ change }) => {
    const m = failedSandbox(true); change(m); const count = m.c.intents.length;
    expect(request(m).ok).toBe(false); expect(m.c.intents).toHaveLength(count);
  });
  it('[BT_L34] binds the request to the immutable source hash', () => {
    const m = failedSandbox(true); expect(request(m, 'forged').code).toBe('SOURCE_COMMAND_CHANGED');
  });
  it('[BT_L32] carries a partial-write warning into the approval reason', () => {
    const m = failedSandbox(true); m.op!.result!.data.outputFiles = [{ path: 'changed.txt' }]; request(m);
    const action = m.c.intents.at(-1)!.localOperations![0]!.action;
    expect(action.type === 'runCli' && action.reason).toContain('1个文件变更');
  });
});
