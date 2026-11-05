import { describe, expect, it } from 'vitest';
import { LocalModel, localModelInput } from './local-model-fixture.js';

import { claimCheck, claimRetryOp, claimRetryWork, decideRetry, deliver, failedSandbox, passCheck, prepareRetry, request, requestSecond, retryOp, retryWork, settleRetry, startRetry, twoQueued } from './host-retry-model-fixture.js';
import { legacyBlockedHostRetry, rejectRetryOwner, retryWithQueuedSuccessor, startFirstRetry } from './host-retry-model-fixture.js';
describe('用户从失败沙箱记录续办（真实XState，每步持久化）', () => {
  it.each([
    { output: 'delivery', submit: (m: LocalModel) => deliver(m, retryWork(m)), code: 'OK' },
    { output: 'rejected help', submit: rejectRetryOwner, code: 'SELF_DEPENDENCY' },
  ])('[BT_L53] dispatches the queued successor after the settled batch owner submits $output', ({ submit, code }) => {
    const m = retryWithQueuedSuccessor();
    startFirstRetry(m);
    expect(settleRetry(m).ok).toBe(true);
    const first = retryOp(m);

    const reply = submit(m);

    expect(reply.code).toBe(code);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['settled', 'active']);
    expect(m.c.intents.find(work => work.id === m.c.hostRetryRequests?.[0]?.workId)?.localOperations).toContainEqual(first);
    expect(retryOp(m)).toMatchObject({ hostRetryOf: 'op2', status: 'queued' });
    expect(retryOp(m).approval).toBeUndefined();
  });
  it.each([
    { type: 'SETTLE' },
    { type: 'WORK_FAILED', reason: '已确认失败', transient: false },
  ])('[BT_L53] $type retires only the unfinished commands of its own batch', event => {
    const m = retryWithQueuedSuccessor();

    const reply = m.send({ ...event, intentId: retryWork(m).id });

    expect(reply.ok).toBe(true);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['cancelled', 'active']);
    expect(retryOp(m)).toMatchObject({ hostRetryOf: 'op2', status: 'queued' });
  });
  it('[BT_L53] records an unstarted request even if its batch never assigned it an operation', () => {
    const m = twoQueued();

    expect(m.send({ type: 'SETTLE', intentId: retryWork(m).id }).ok).toBe(true);

    expect(m.c.hostRetryRequests?.[1]).toMatchObject({ status: 'cancelled', reason: 'WORK_NOT_STARTED' });
    expect(m.c.intents.some(work => work.localOperations?.some(op => op.hostRetryOf === 'op2'))).toBe(false);
  });
  it.each([
    { type: 'RECOVER', config: localModelInput().config },
    { type: 'HOST_RETRY_RECONCILE' },
  ])('[BT_L54] $type repairs the old snapshot once without replacing the candidate or charging usage', event => {
    const m = legacyBlockedHostRetry();
    const { candidate, usage, epoch, goalVersion } = m.c;
    const oldBatch = m.c.hostRetryBatch!.id;

    expect(m.send(event).ok).toBe(true);
    expect(m.send(event).ok).toBe(true);

    expect(m.c).toMatchObject({ candidate, usage, epoch, goalVersion, outcome: null });
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['settled', 'active']);
    expect(m.c.intents.flatMap(work => work.localOperations ?? []).filter(op => op.hostRetryOf === 'op2')).toHaveLength(1);
    const retirements = m.c.trace.filter(entry => entry.event === 'HOST_RETRY_BATCH_RETIRED');
    expect(retirements.map(entry => JSON.parse(entry.detail).batchId)).toEqual([oldBatch]);
  });
  it('[BT_L54] recovers an orphaned batch pointer when all its command results are known', () => {
    const m = legacyBlockedHostRetry();
    m.c.hostRetryBatch!.workId = 'missing-owner';

    expect(m.send({ type: 'HOST_RETRY_RECONCILE' }).ok).toBe(true);

    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['settled', 'active']);
    expect(retryOp(m)).toMatchObject({ hostRetryOf: 'op2', status: 'queued' });
  });
  it('[BT_L54] retains a denial saved before its deadline when reconciling a later snapshot', () => {
    const m = retryWithQueuedSuccessor();
    const queued = m.c.hostRetryRequests![1]!;
    queued.deadline += 100;
    prepareRetry(m);
    expect(decideRetry(m, 'deny').ok).toBe(true);
    retryWork(m).status = 'done';
    // The persisted operation already has a receipt, while its request still has the earlier status.
    m.c.hostRetryRequests![0]!.status = 'active';
    m.at = retryOp(m).deadline!;

    expect(m.send({ type: 'HOST_RETRY_RECONCILE' }).ok).toBe(true);

    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['settled', 'active']);
    expect(m.c.hostRetryRequests?.[0]?.reason).toBe('HOST_APPROVAL_DENIED');
  });
  it('[BT_L55] keeps a missing batch owner fenced when its command has no confirmed receipt', () => {
    const m = retryWithQueuedSuccessor();
    retryWork(m).status = 'done';
    m.c.hostRetryBatch!.workId = 'missing-owner';

    expect(m.send({ type: 'HOST_RETRY_RECONCILE' }).ok).toBe(true);

    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['active', 'pending']);
    expect(m.c.trace.some(entry => entry.event === 'HOST_RETRY_BATCH_RETIRED')).toBe(false);
  });
  it('[BT_L55] preserves a recorded uncertain execution when the batch owner reference is missing', () => {
    const m = retryWithQueuedSuccessor();
    startFirstRetry(m);
    expect(settleRetry(m, { uncertain: true }).ok).toBe(true);
    m.c.hostRetryBatch!.workId = 'missing-owner';

    expect(m.send({ type: 'HOST_RETRY_RECONCILE' }).ok).toBe(true);

    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['uncertain', 'pending']);
    expect(m.c.trace.some(entry => entry.event === 'HOST_RETRY_BATCH_RETIRED')).toBe(false);
  });
  it('[BT_L55] keeps the active batch while the first command has unconfirmed effects', () => {
    const m = retryWithQueuedSuccessor();
    startFirstRetry(m);
    expect(settleRetry(m, { uncertain: true }).ok).toBe(true);

    expect(m.send({ type: 'RECOVER', config: localModelInput().config }).ok).toBe(true);

    expect(m.snapshot.value).toBe('waitingHuman');
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['uncertain', 'pending']);
    expect(retryOp(m)).toMatchObject({ hostRetryOf: 'op1', status: 'uncertain' });
    expect(m.c.intents.flatMap(work => work.localOperations ?? []).some(op => op.hostRetryOf === 'op2')).toBe(false);
  });
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
  it('[BT_L33] returns the saved identity when a different click identity is received', () => {
    const m = failedSandbox(true); const first = request(m); const count = m.c.intents.length;
    expect(request(m)).toEqual(first); expect(m.c.intents).toHaveLength(count);
  });
  it('[BT_L45] records multiple requests without cancelling the main work or advancing its fence', () => {
    const m = failedSandbox(false, true); const before = m.c.usage.ordinary;
    const first = request(m); expect(requestSecond(m).ok).toBe(true);
    expect(request(m)).toEqual(first);
    expect(m.c.epoch).toBe(1);
    expect(m.c.usage.ordinary).toBe(before);
    expect(m.c.intents[0]?.status).toBe('inflight');
    expect(m.c.intents.some(work => work.kind === 'cancel')).toBe(false);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['pending', 'pending']);
    expect(m.c.hostRetryBatch).toBeUndefined();
    expect(deliver(m).ok).toBe(true);
    expect(m.c.candidate?.text).toBe('候选说明');
    expect(m.c.outcome).toBeNull();
    expect(retryOp(m).hostRetryOf).toBe('op1');
    expect(retryWork(m).localOperations).toHaveLength(1);
  });
  it('[BT_L50] preserves ordinary assistance and its saved handoff for owner synthesis', () => {
    const m = failedSandbox();
    m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'H', target: 'B', question: '核查', expected: '证据' });
    expect(request(m).ok).toBe(true);
    expect(m.c.assists[0]?.status).toBe('pending');
    expect(m.c.hostRetryBatch).toBeUndefined();
    expect(m.send({ type: 'HELP_RESULT', requestId: 'H', resultId: 'help-result', status: 'success', answer: '保留的协助结论' }).ok).toBe(true);
    expect(m.c.assists[0]?.answer).toBe('保留的协助结论');
    expect(retryWork(m).payload.answer).toBe('保留的协助结论');
  });
  it('[BT_L46] holds a check that finishes after retry acceptance', () => {
    const m = failedSandbox(); deliver(m);
    const check = claimCheck(m);
    expect(request(m).ok).toBe(true);
    expect(m.snapshot.value).toBe('checking');
    expect(passCheck(m, check, 'old-check').ok).toBe(true);
    expect(m.c.consumedResults).toContain('old-check');
    expect(m.c.candidate?.text).toBe('候选说明');
    expect(m.c.outcome).toBeNull();
    expect(retryWork(m).localOperations).toHaveLength(1);
  });
  it('[BT_L46] applies a coordinator finish only after the pending retry boundary', () => {
    const m = failedSandbox(); m.send({ type: 'BLOCKED', workId: m.work.id, fence: m.work, reason: '已有阻塞' });
    const work = m.c.intents.at(-1)!; m.send({ type: 'CLAIM', intentId: work.id });
    expect(request(m).ok).toBe(true);
    expect(m.send({ type: 'COORDINATE', workId: work.id, fence: work, decision: { action: 'finish', reason: '阶段结束' } }).ok).toBe(true);
    expect(m.c.outcome).toBeNull();
    expect(retryOp(m).hostRetryOf).toBe('op1');
  });
  it('[BT_L47] a denial preserves its receipt and exposes only the next fixed operation', () => {
    const m = twoQueued(); prepareRetry(m);
    expect(decideRetry(m, 'deny').ok).toBe(true);
    expect(retryWork(m).localOperations?.[0]?.result?.code).toBe('HOST_APPROVAL_DENIED');
    expect(retryOp(m).hostRetryOf).toBe('op2');
    expect(retryOp(m).approval).toBeUndefined();
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['settled', 'active']);
  });
  it('[BT_L47] a known failure advances exactly once and keeps independent approvals', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m); startRetry(m);
    expect(settleRetry(m, { failed: true }).ok).toBe(true);
    expect(retryOp(m).hostRetryOf).toBe('op2');
    prepareRetry(m, 'approval2');
    expect(retryOp(m).status).toBe('awaitingApproval');
    expect(retryOp(m).approval?.id).toBe('approval2');
  });
  it('[BT_L48] freezes unknown effects and advances only after trusted reconciliation', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m); startRetry(m);
    expect(settleRetry(m, { uncertain: true }).ok).toBe(true);
    expect(retryWork(m).localOperations).toHaveLength(1);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['uncertain', 'active']);
    expect(m.snapshot.value).toBe('waitingHuman');
    const op = retryOp(m);
    expect(m.send({ type: 'LOCAL_RECONCILE', intentId: retryWork(m).id, operationId: op.id, sessionId: op.sessionId, resolution: 'receipt',
      result: { ok: true, code: 'succeeded', data: {} }, detail: '可信回执' }).ok).toBe(true);
    expect(retryOp(m).hostRetryOf).toBe('op2');
    expect(m.snapshot.value).toBe('running');
  });
  it('[BT_L48] stops subsequent commands and settles a late receipt without reviving the task', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m); startRetry(m);
    const work = retryWork(m), op = retryOp(m);
    expect(m.send({ type: 'STOP' }).ok).toBe(true);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['active', 'cancelled']);
    expect(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: op.sessionId,
      result: { ok: true, code: 'succeeded', data: {} }, settled: true, effectsKnown: true }).ok).toBe(true);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['settled', 'cancelled']);
    expect(m.c.intents.find(w => w.id === work.id)?.localOperations).toHaveLength(1);
  });
  it('[BT_L49] recovery preserves settled operations, invalidates approval and does not charge owner twice', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m, 'approveSession'); startRetry(m); settleRetry(m);
    prepareRetry(m, 'approval2');
    expect(retryOp(m).status).toBe('queued');
    const prior = retryOp(m).approval!.id, before = m.c.usage.ordinary;
    expect(m.send({ type: 'RECOVER', config: localModelInput().config }).ok).toBe(true);
    expect(retryWork(m).localOperations?.[0]?.status).toBe('succeeded');
    expect(retryOp(m).status).toBe('awaitingApproval');
    expect(retryOp(m).approval?.id).not.toBe(prior);
    expect(m.c.hostSession).toBeUndefined();
    expect(decideRetry(m).ok).toBe(true); claimRetryWork(m);
    expect(m.c.usage.ordinary).toBe(before);
  });
  it('[BT_L49] charges a new owner model attempt after recovery from an authorized synthesis', () => {
    const m = failedSandbox(true); request(m); claimRetryWork(m); prepareRetry(m); decideRetry(m); startRetry(m); settleRetry(m);
    const work = retryWork(m);
    expect(m.send({ type: 'CONSUME', intentId: work.id, fence: work }).ok).toBe(true);
    const before = m.c.usage.ordinary;
    expect(m.send({ type: 'RECOVER', config: localModelInput().config }).ok).toBe(true);
    claimRetryWork(m);
    expect(m.c.usage.ordinary).toBe(before + 1);
    expect(m.send({ type: 'CONSUME', intentId: work.id, fence: work }).ok).toBe(true);
    expect(m.c.usage.ordinary).toBe(before + 1);
  });
  it('[BT_L51] lets current work consume unreserved budget and reports boundary exhaustion', () => {
    const m = failedSandbox(); m.c.config.limits.ordinary = m.c.usage.ordinary + 2;
    expect(m.send({ type: 'CONSUME', intentId: m.work.id }).ok).toBe(true);
    expect(request(m).ok).toBe(true);
    expect(m.send({ type: 'CONSUME', intentId: m.work.id }).ok).toBe(true);
    expect(deliver(m).ok).toBe(true);
    expect(m.c.outcome).toBe('partial');
    expect(m.c.hostRetryRequests?.[0]?.reason).toBe('BUDGET_EXHAUSTED');
    expect(m.c.intents.flatMap(w => w.localOperations ?? []).filter(op => op.hostRetryOf)).toHaveLength(0);
  });
  it('[BT_L52] expires a saved request before launch and advances an unexpired successor', () => {
    const m = failedSandbox(false, true);
    request(m); m.at = 20; requestSecond(m); deliver(m); claimRetryWork(m); prepareRetry(m);
    const work = retryWork(m), op = retryOp(m); m.at = op.deadline!;
    expect(decideRetry(m).code).toBe('HOST_APPROVAL_EXPIRED');
    expect(m.send({ type: 'LOCAL_RETRY_EXPIRED', intentId: work.id, operationId: op.id }).ok).toBe(true);
    expect(m.c.hostRetryRequests?.[0]?.status).toBe('expired');
    expect(retryOp(m).hostRetryOf).toBe('op2');
  });
  it('[BT_L48] preserves started timeout effects and freezes the next request', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m); startRetry(m);
    m.at = retryOp(m).deadline!;
    expect(settleRetry(m, { uncertain: true }).ok).toBe(true);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['uncertain', 'active']);
    expect(retryWork(m).localOperations).toHaveLength(1);
    expect(m.c.outcome).toBeNull();
  });
  it('[BT_L48] a new goal invalidates remaining requests and keeps the prior receipt separate', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m); startRetry(m);
    const work = retryWork(m), op = retryOp(m);
    expect(m.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok).toBe(true);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['active', 'cancelled']);
    expect(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: op.sessionId,
      result: { ok: true, code: 'succeeded', data: {} }, settled: true, effectsKnown: true }).ok).toBe(true);
    expect(m.c.hostRetryRequests?.map(r => r.status)).toEqual(['settled', 'cancelled']);
    expect(m.c.candidate).toBeNull();
    expect(m.c.goalVersion).toBe(2);
  });
  it('[BT_L37] revoking an approved but unstarted batch command requires a fresh approval', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m, 'approveSession');
    const originalApproval = retryOp(m).approval!.id;
    expect(claimRetryOp(m, 'run-claim').ok).toBe(true);
    const work = retryWork(m), op = retryOp(m);
    expect(m.send({ type: 'REVOKE_HOST_SESSION', grantId: m.c.hostSession!.id, fence: work }).ok).toBe(true);
    expect(m.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: 'run-claim' }).code).toBe('HOST_APPROVAL_REQUIRED');
    expect(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: 'run-claim',
      result: { ok: false, code: 'HOST_APPROVAL_REQUIRED', data: {} }, settled: true, effectsKnown: true }).ok).toBe(true);
    expect(retryOp(m).status).toBe('awaitingApproval');
    expect(retryOp(m).approval?.id).not.toBe(originalApproval);
    expect(retryWork(m).localOperations).toHaveLength(1);
    const before = m.c.usage.ordinary; m.c.config.limits.ordinary = before + 1;
    expect(decideRetry(m).ok).toBe(true);
    expect(startRetry(m, 'run-fresh').ok).toBe(true);
    expect(m.c.usage.ordinary).toBe(before);
    expect(settleRetry(m).ok).toBe(true);
    expect(retryOp(m).hostRetryOf).toBe('op2');
  });
  it('[BT_L36] an invalidated plan is prepared again and requires a fresh user decision', () => {
    const m = twoQueued(); prepareRetry(m); decideRetry(m, 'approveSession');
    expect(claimRetryOp(m, 'changed-plan').ok).toBe(true);
    const work = retryWork(m), op = retryOp(m);
    expect(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: 'changed-plan',
      result: { ok: false, code: 'HOST_APPROVAL_STALE', data: {} }, settled: true, effectsKnown: true }).ok).toBe(true);
    expect(retryOp(m).status).toBe('queued');
    expect(retryOp(m).approval).toBeUndefined();
    prepareRetry(m, 'updated-plan');
    expect(retryOp(m).status).toBe('awaitingApproval');
    expect(retryOp(m).approval?.id).toBe('updated-plan');
    expect(m.c.hostSession).toBeDefined();
  });
  it('[BT_L52] persists expiry while original work is still active and reports it at handoff', () => {
    const m = failedSandbox(); request(m); m.at = m.c.hostRetryRequests![0]!.deadline;
    expect(m.send({ type: 'HOST_RETRY_EXPIRE' }).ok).toBe(true);
    expect(m.c.hostRetryRequests?.[0]?.status).toBe('expired');
    expect(m.c.intents[0]?.status).toBe('inflight');
    expect(deliver(m).ok).toBe(true);
    expect(m.c.outcome).toBe('partial');
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
  it.each([
    { name: 'checking', change: (m: LocalModel) => { m.c.intents[0]!.kind = 'check'; } },
    { name: 'discussion', change: (m: LocalModel) => { m.c.intents[0]!.discussionId = 'discussion'; } },
    { name: 'explicitly isolated', change: (m: LocalModel) => { m.op!.isolated = true; } },
  ])('[BT_L34] prevents $name source operations from moving into the owner workspace', ({ change }) => {
    const m = failedSandbox(true); change(m);
    expect(request(m).code).toBe('HOST_RETRY_ISOLATED_SOURCE');
    expect(m.c.hostRetryRequests).toBeUndefined();
  });
  it('[BT_L34] rechecks the original member permission before a prepared command can run', () => {
    const m = failedSandbox(true);
    m.c.intents[0]!.target = 'B';
    request(m); claimRetryWork(m); prepareRetry(m);
    const source = m.c.config.bots.find(bot => bot.id === 'B')!;
    source.localTools = false;
    expect(decideRetry(m).code).toBe('LOCAL_TOOLS_DISABLED');
    expect(retryOp(m).startedAt).toBeUndefined();
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
