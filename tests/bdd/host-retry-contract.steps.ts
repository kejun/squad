import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { HostRetryFixture } from '../host-retry-fixture.js';
import { hostUntil } from '../host-approval-fixture.js';
import type { SpecWorld } from './steps.js';
import { LocalModel, localModelInput } from '../local-model-fixture.js';
import { claimCheck, claimRetryWork, decideRetry, deliver, failedSandbox, legacyBlockedHostRetry, passCheck, prepareRetry, request, requestSecond, retryOp, retryWork, retryWithQueuedSuccessor, settleRetry, startFirstRetry, startRetry, twoQueued } from '../host-retry-model-fixture.js';

interface State { m: LocalModel; variant: string; before?: { candidate: unknown; usage: unknown; epoch: number; goalVersion: number }; batch?: string; beforeOrdinary?: number; first?: string; replyCode?: string; firstOperation?: unknown; fixture?: HostRetryFixture; candidateRevision?: string; afterClaimOrdinary?: number; postExpiryCode?: string; fixtureFirst?: { workId: string; operationId: string; approvalId: string }; trigger?: string }
const states = new WeakMap<SpecWorld, State>();
const state = (w: SpecWorld) => states.get(w)!;
After(async function (this: SpecWorld) { await states.get(this)?.fixture?.close(); });

Given('未启动的宿主续办处于{string}', function (this: SpecWorld, variant: string) {
  const m = variant === '后续请求尚未到期' ? failedSandbox(false, true) : failedSandbox(variant === '等待批准');
  assert(request(m).ok);
  if (variant === '后续请求尚未到期') { m.at = 20; assert(requestSecond(m).ok); assert(deliver(m).ok); }
  if (variant !== '原负责人尚未结束') { claimRetryWork(m); prepareRetry(m); }
  states.set(this, { m, variant });
});
When('该宿主续办到期并在原负责人返回时保存结果', function (this: SpecWorld) {
  const { m, variant } = state(this);
  if (variant === '原负责人尚未结束') {
    const original = structuredClone(m.c.intents[0]);
    m.at = m.c.hostRetryRequests![0]!.deadline; assert(m.send({ type: 'HOST_RETRY_EXPIRE' }).ok);
    assert.deepEqual(m.c.intents[0], original, 'Expiring a queued host request may not pretend its original owner settled');
    // The original owner shares the same bounded timeout and is already late here.
    // A late candidate cannot manufacture partial delivery after that deadline.
    assert.equal(deliver(m).code, 'WORK_EXPIRED');
  }
  else { const work = retryWork(m), op = retryOp(m); m.at = op.deadline!; assert.equal(decideRetry(m).code, variant === '后续请求尚未到期' ? 'HOST_APPROVAL_EXPIRED' : 'WORK_EXPIRED'); assert(m.send({ type: 'LOCAL_RETRY_EXPIRED', intentId: work.id, operationId: op.id }).ok); if (variant === '等待批准') state(this).postExpiryCode = decideRetry(m).code; }
});
Then('到期请求应未执行且只允许未过期的后续请求继续', function (this: SpecWorld) {
  const { m, variant } = state(this); assert.equal(m.c.hostRetryRequests?.[0]?.status, 'expired');
  if (variant === '原负责人尚未结束') {
    assert.equal(m.c.outcome, 'failed'); assert.equal(m.c.candidate, null);
    assert(!m.c.artifacts.some(artifact => artifact.content.includes('候选说明')), 'Rejected late delivery may not become saved business material');
    assert.equal(m.c.hostRetryRequests?.[0]?.reason, 'WORK_EXPIRED');
    assert.equal(m.c.hostRetryRequests?.[0]?.operationId, undefined);
    assert(!m.c.intents.some(work => work.localOperations?.some(op => op.action.type === 'runCli' && op.action.execution === 'host' && op.startedAt !== undefined)));
  }
  else if (variant === '后续请求尚未到期') { assert.equal(retryOp(m).hostRetryOf, 'op2'); assert.equal(retryOp(m).startedAt, undefined); }
  else { assert.notEqual(state(this).postExpiryCode, 'OK'); assert.equal(retryOp(m).startedAt, undefined); }
});

Given('续办首批处于{string}且其他请求已经登记', async function (this: SpecWorld, variant: string) {
  const m = variant === '后续命令尚未分配' ? twoQueued() : retryWithQueuedSuccessor();
  const s: State = { m, variant }; states.set(this, s);
  if (variant === '已有确定回执') { startFirstRetry(m); assert(settleRetry(m).ok); s.first = retryOp(m).id; s.firstOperation = structuredClone(retryOp(m)); const f = new HostRetryFixture(); s.fixture = f; s.fixtureFirst = await f.pauseAfterFirstRetry(); s.candidateRevision = f.context().candidate!.revision!; }
});
When('负责人以{string}结束首批续办', function (this: SpecWorld, output: string) {
  const s = state(this), m = s.m;
  if (output === '交付候选') s.replyCode = deliver(m, retryWork(m)).code;
  else if (output === '无效协助') { const work = retryWork(m); s.replyCode = m.send({ type: 'HELP', workId: work.id, fence: work, caller: work.target, target: work.target, requestId: 'self-help', question: '核查续办结果', expected: '证据' }).code; }
  else s.replyCode = m.send({ type: output === '明确失败' ? 'WORK_FAILED' : 'SETTLE', intentId: retryWork(m).id, reason: '已确认失败', transient: false }).code;
  if (s.fixture) s.fixture.resumeSynthesis(output === '无效协助' ? 'invalidHelp' : 'delivery');
});
Then('首批应得到{string}且真实回执不得丢失', async function (this: SpecWorld, code: string) {
  const s = state(this), m = s.m; assert.equal(s.replyCode, code);
  if (s.variant === '已有确定回执') { assert.deepEqual(m.c.hostRetryRequests?.map(r => r.status), ['settled', 'active']); assert.deepEqual(m.c.intents.flatMap(w => w.localOperations ?? []).find(op => op.id === s.first), s.firstOperation); }
  else if (s.variant === '后续命令尚未分配') { assert.equal(m.c.hostRetryRequests?.[1]?.status, 'cancelled'); assert.equal(m.c.hostRetryRequests?.[1]?.reason, 'WORK_NOT_STARTED'); }
  else assert.deepEqual(m.c.hostRetryRequests?.map(r => r.status), ['cancelled', 'active']);
  if (s.fixture) { const f = s.fixture; await hostUntil(() => f.context().trace, t => t.some(e => e.event === 'HOST_RETRY_BATCH_RETIRED')); if (code === 'SELF_DEPENDENCY') { assert(f.context().trace.some(e => e.event === 'REJECTED' && e.detail.endsWith(':SELF_DEPENDENCY'))); assert.equal(f.context().candidate?.revision, s.candidateRevision); } else { assert.notEqual(f.context().candidate?.revision, s.candidateRevision); assert.equal(f.context().candidate?.workId, s.fixtureFirst!.workId); } const first = f.context().intents.find(w => w.id === s.fixtureFirst!.workId)?.localOperations?.find(op => op.id === s.fixtureFirst!.operationId); assert.equal(first?.result?.ok, true); assert.equal(await f.runs(), 'once\n'); }
});
Then('后续应遵循{string}的授权边界', async function (this: SpecWorld, policy: string) {
  const s = state(this), m = s.m;
  if (policy === '本批未分配请求取消') assert(!m.c.intents.some(work => work.localOperations?.some(op => op.hostRetryOf === 'op2')));
  else { assert.equal(retryOp(m).hostRetryOf, 'op2'); assert.equal(retryOp(m).status, 'queued'); assert.equal(retryOp(m).approval, undefined); }
  if (s.fixture) { const a = await s.fixture.approval(); assert.equal(a.args.at(-1), 'command-2'); assert.notEqual(a.approvalId, s.fixtureFirst!.approvalId); assert.equal(await s.fixture.runs(), 'once\n'); }
});

Given('旧宿主批次保存了{string}且新续办仍在排队', async function (this: SpecWorld, variant: string) {
  const m = variant === '截止前已有拒绝回执' ? retryWithQueuedSuccessor() : legacyBlockedHostRetry();
  if (variant === '负责人引用缺失') m.c.hostRetryBatch!.workId = 'missing-owner';
  if (variant === '截止前已有拒绝回执') {
    m.c.hostRetryRequests![1]!.deadline += 100; prepareRetry(m); assert(decideRetry(m, 'deny').ok); retryWork(m).status = 'done';
    m.c.hostRetryRequests![0]!.status = 'active'; m.at = retryOp(m).deadline!;
  }
  const s: State = { m, variant, before: structuredClone({ candidate: m.c.candidate, usage: m.c.usage, epoch: m.c.epoch, goalVersion: m.c.goalVersion }), batch: m.c.hostRetryBatch!.id }; states.set(this, s);
  if (variant === '正常结束记录') { s.fixture = new HostRetryFixture(); s.fixtureFirst = await s.fixture.pauseAfterFirstRetry(); s.candidateRevision = s.fixture.context().candidate!.revision!; }
});
When('从{string}重复核对遗留宿主批次', async function (this: SpecWorld, entry: string) {
  const { m } = state(this); state(this).trigger = entry === '服务恢复' ? 'RECOVER' : 'HOST_RETRY_RECONCILE'; const event = entry === '服务恢复' ? { type: 'RECOVER', config: localModelInput().config } : { type: 'HOST_RETRY_RECONCILE' };
  assert(m.send(event).ok); assert(m.send(event).ok);
  const f = state(this).fixture; if (f) { const saved = f.legacyRetiredBatch(); if (entry === '服务恢复') await f.restart(JSON.stringify(saved), () => f.resumeSynthesis()); else f.service.engine.store.transact(f.room.id, tx => { tx.room.tasks[f.taskId] = saved.tasks[f.taskId]; }); await f.approval(); f.service.engine.tick(f.room.id); assert.equal(f.context().candidate?.revision, state(this).candidateRevision); assert.equal(f.context().outcome, null); }
});
Then('遗留批次只解除一次且不得替换候选、已知回执或额度', function (this: SpecWorld) {
  const { m, before, batch, variant } = state(this); assert.deepEqual(m.c.candidate, before!.candidate); assert.deepEqual(m.c.usage, before!.usage); assert.equal(m.c.epoch, before!.epoch); assert.equal(m.c.goalVersion, before!.goalVersion); assert.equal(m.c.outcome, null);
  assert.deepEqual(m.c.hostRetryRequests?.map(r => r.status), ['settled', 'active']);
  assert.equal(m.c.intents.flatMap(work => work.localOperations ?? []).filter(op => op.hostRetryOf === 'op2').length, 1);
  if (variant === '截止前已有拒绝回执') assert.equal(m.c.hostRetryRequests?.[0]?.reason, 'HOST_APPROVAL_DENIED');
  else if (variant === '正常结束记录') assert.deepEqual(m.c.trace.filter(e => e.event === 'HOST_RETRY_BATCH_RETIRED').map(e => JSON.parse(e.detail).batchId), [batch]);
  assert.equal(retryOp(m).hostRetryOf, 'op2'); assert.equal(retryOp(m).status, 'queued');
  const s = state(this); if (s.fixture) { const c = s.fixture.context(); assert.deepEqual(c.trace.filter(e => e.event === 'HOST_RETRY_BATCH_RETIRED').map(e => { const data = JSON.parse(e.detail); return [data.batchId, data.trigger]; }), [[s.fixtureFirst!.workId, s.trigger]]); const source = c.hostRetryRequests?.[1]?.sourceOperationId; assert.equal(c.intents.flatMap(w => w.localOperations ?? []).filter(op => op.hostRetryOf === source).length, 1); }
});

Given('首条续办保存为{string}且另一次请求仍在排队', function (this: SpecWorld, variant: string) {
  const m = retryWithQueuedSuccessor();
  if (variant !== '缺失负责人且无回执') { startFirstRetry(m); assert(settleRetry(m, { uncertain: true }).ok); }
  if (variant !== '效果未确认') { retryWork(m).status = 'done'; m.c.hostRetryBatch!.workId = 'missing-owner'; }
  states.set(this, { m, variant });
});
When('核对缺失或未确认的首条续办记录', function (this: SpecWorld) {
  const { m, variant } = state(this); assert(m.send(variant === '效果未确认' ? { type: 'RECOVER', config: localModelInput().config } : { type: 'HOST_RETRY_RECONCILE' }).ok);
});
Then('不得越过缺失或未确认的首条记录启动后续命令', function (this: SpecWorld) {
  const { m, variant } = state(this); assert.deepEqual(m.c.hostRetryRequests?.map(r => r.status), [variant === '缺失负责人且无回执' ? 'active' : 'uncertain', 'pending']);
  assert(!m.c.intents.some(work => work.localOperations?.some(op => op.hostRetryOf === 'op2')));
  if (variant === '效果未确认') { assert.equal(m.snapshot.value, 'waitingHuman'); assert.equal(retryOp(m).status, 'uncertain'); assert.equal(retryOp(m).hostRetryOf, 'op1'); }
  else assert(!m.c.trace.some(entry => entry.event === 'HOST_RETRY_BATCH_RETIRED'));
});

Given('宿主续办恢复前处于{string}', function (this: SpecWorld, variant: string) {
  const m = variant === '整理模型已消耗请求' ? failedSandbox(true) : twoQueued();
  if (variant === '整理模型已消耗请求') { assert(request(m).ok); claimRetryWork(m); }
  prepareRetry(m); assert(decideRetry(m, 'approveSession').ok); assert(startRetry(m).ok); assert(settleRetry(m).ok);
  if (variant === '整理模型已消耗请求') { const work = retryWork(m); assert(m.send({ type: 'CONSUME', intentId: work.id, fence: work }).ok); }
  else { prepareRetry(m, 'approval2'); assert.equal(retryOp(m).status, 'queued'); }
  states.set(this, { m, variant, beforeOrdinary: m.c.usage.ordinary, first: retryOp(m).approval!.id });
});
When('重启恢复该续办并重新领取后继续命令或模型请求', function (this: SpecWorld) {
  const { m, variant } = state(this); assert(m.send({ type: 'RECOVER', config: localModelInput().config }).ok);
  if (variant !== '整理模型已消耗请求') { assert.equal(retryOp(m).status, 'awaitingApproval'); assert(decideRetry(m).ok); }
  claimRetryWork(m); state(this).afterClaimOrdinary = m.c.usage.ordinary;
  if (variant === '整理模型已消耗请求') { const work = retryWork(m); assert(m.send({ type: 'CONSUME', intentId: work.id, fence: work }).ok); }
  else { assert(startRetry(m, 'run2').ok); assert(settleRetry(m).ok); }
});
Then('已结算命令不得重放且恢复后的收费对应真实新请求', function (this: SpecWorld) {
  const { m, variant, beforeOrdinary, first, afterClaimOrdinary } = state(this); assert.equal(retryWork(m).localOperations?.[0]?.status, 'succeeded'); assert.equal(m.c.hostSession, undefined);
  if (variant === '整理模型已消耗请求') { assert.equal(afterClaimOrdinary, beforeOrdinary! + 1); assert.equal(m.c.usage.ordinary, beforeOrdinary! + 1); }
  else { assert.notEqual(retryOp(m).approval!.id, first); assert.equal(afterClaimOrdinary, beforeOrdinary); assert.equal(m.c.usage.ordinary, beforeOrdinary! + 1); assert.deepEqual(retryWork(m).localOperations?.map(op => op.hostRetryOf), ['op1', 'op2']); const checkpoint = retryWork(m).localCheckpoint!; assert.deepEqual(checkpoint.messages.filter(msg => msg.content.startsWith('{"type":"local_tool_result",')).map(msg => JSON.parse(msg.content).operationId), retryWork(m).localOperations?.map(op => op.id)); }
});

When('用户批准新续办并交回负责人检查', async function (this: SpecWorld) {
  const s = state(this), m = s.m; claimRetryWork(m); prepareRetry(m, 'fresh-approval'); assert(decideRetry(m).ok); assert(startRetry(m).ok); assert(settleRetry(m).ok); assert(deliver(m, retryWork(m)).ok); assert.equal(m.c.outcome, null); assert(passCheck(m, claimCheck(m), 'rechecked').ok);
  if (s.fixture) { const f = s.fixture, a = await f.approval(); f.resumeSynthesis(); assert.equal((await f.request(f.decisionData(a, 'approve'))).status, 200); await f.complete(); }
});
Then('新回执交接后的候选通过检查才可交付', async function (this: SpecWorld) {
  const s = state(this); assert.equal(s.m.c.outcome, 'complete'); assert.equal(s.m.c.publishedDelivery?.revision, s.m.c.candidate?.revision);
  if (s.fixture) { const c = s.fixture.context(); assert.equal(c.outcome, 'complete'); assert.notEqual(c.publishedDelivery?.revision, s.candidateRevision); assert.equal(c.publishedDelivery?.revision, c.candidate?.revision); assert(c.intents.some(w => w.kind === 'check' && w.status === 'done' && w.requestCount === 1)); assert.equal(await s.fixture.runs(), 'once\nonce\n'); }
});
