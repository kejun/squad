import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { HostRetryFixture } from '../host-retry-fixture.js';
import { hostUntil } from '../host-approval-fixture.js';
import { claimCheck, claimRetryWork, decideRetry, deliver, failedSandbox, passCheck, prepareRetry, request, retryOp, retryWork, settleRetry, startRetry, twoQueued } from '../host-retry-model-fixture.js';
import { localModelInput, type LocalModel } from '../local-model-fixture.js';

interface State {
  fixture?: HostRetryFixture;
  model?: LocalModel;
  work?: string;
  originalOrdinary?: number;
  first?: string;
  change?: string;
}
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld) {
  const existing = states.get(world);
  if (existing) return existing;
  const fresh: State = {}; states.set(world, fresh); return fresh;
}
After(async function (this: SpecWorld) { await states.get(this)?.fixture?.close(); });
function model(world: SpecWorld) { return state(world).model!; }

Given('负责人正在整理已有资料并保留两条确定失败的沙箱命令', async function (this: SpecWorld) {
  const fixture = new HostRetryFixture(); state(this).fixture = fixture; await fixture.pauseAfterTwoFailures(); state(this).originalOrdinary = fixture.context().usage.ordinary;
});
When('用户分别申请续办这两条命令并重复提交第一条', async function (this: SpecWorld) {
  const f = state(this).fixture!, [first, second] = f.snapshot().failedSandboxCommands!;
  state(this).first = first!.operationId;
  const accepted = await f.requestRetry(f.retryData(first));
  assert.equal(accepted.status, 200);
  assert.equal((await f.requestRetry(f.retryData(second))).status, 200);
  assert.deepEqual((await f.requestRetry(f.retryData(first))).data, accepted.data);
});
Then('当前整理工作应继续且只登记两条固定请求', function (this: SpecWorld) {
  const f = state(this).fixture!, c = f.service.engine.view(f.room.id, f.taskId)!.context;
  assert.deepEqual(c.hostRetryRequests?.map(r => r.status), ['pending', 'pending']);
  assert.equal(c.intents[0]?.status, 'inflight'); assert.equal(c.epoch, 1); assert.equal(c.usage.ordinary, state(this).originalOrdinary); assert(!c.intents.some(w => w.kind === 'cancel')); assert.equal(c.hostRetryBatch, undefined);
  assert.deepEqual(f.snapshot().hostApprovals, []);
});
When('当前结果保存后用户按顺序批准两条续办命令', async function (this: SpecWorld) {
  const f = state(this).fixture!; f.resumeMain();
  const first = await f.approval(); assert.equal(first.args.at(-1), 'command-1');
  const c = f.context(); assert.equal(c.candidate?.text, '已处理真实命令回执'); assert.equal(c.outcome, null);
  const batch = c.intents.find(work => work.id === c.hostRetryBatch?.workId)!; assert.equal(batch.localOperations?.length, 1); assert.equal(batch.localOperations?.[0]?.hostRetryOf, state(this).first);
  assert.equal((await f.request(f.decisionData(first, 'approve'))).status, 200);
  const second = await hostUntil(() => f.snapshot().hostApprovals?.[0], approval => approval?.args.at(-1) === 'command-2');
  assert.equal(await f.runs(), 'once\n');
  assert.equal((await f.request(f.decisionData(second!, 'approve'))).status, 200);
});
Then('负责人应收到两条命令的实际结果再提交交付', async function (this: SpecWorld) {
  const f = state(this).fixture!; const snapshot = await f.complete();
  assert.equal(snapshot.tasks.at(-1)?.outcome, 'complete'); assert.equal(await f.runs(), 'once\nonce\n');
  assert.equal(f.requests.at(-1)?.messages.filter(m => m.content.startsWith('{"type":"local_tool_result",') && m.content.includes('"execution":"host"')).length, 2);
});

Given('当前候选的{string}尚在进行且用户已申请宿主续办', function (this: SpecWorld, role: string) {
  const s = state(this), m = failedSandbox(); s.model = m;
  if (role === '检查员') assert(deliver(m).ok);
  if (role === '协调员') assert(m.send({ type: 'BLOCKED', workId: m.work.id, fence: m.work, reason: '需要决策' }).ok);
  const current = role === '检查员' ? claimCheck(m) : m.c.intents.at(-1)!;
  s.work = current.id;
  if (role === '协调员') assert(m.send({ type: 'CLAIM', intentId: current.id }).ok);
  assert(request(m).ok);
  if (role === '检查员') assert.equal(m.snapshot.value, 'checking');
});
When('当前工作返回{string}', function (this: SpecWorld, result: string) {
  const m = model(this), w = m.c.intents.find(w => w.id === state(this).work)!;
  if (result === '提交候选') assert(deliver(m, w).ok);
  else if (result === '检查通过') assert(passCheck(m, w, 'old-check').ok);
  else assert(m.send({ type: 'COORDINATE', workId: w.id, fence: w, decision: { action: 'finish', reason: '阶段结束' } }).ok);
});
Then('应保留当前结果并等待已接受的续办处理', function (this: SpecWorld) {
  const m = model(this);
  assert.equal(m.c.intents.find(w => w.id === state(this).work)?.status, 'done');
  assert.equal(m.c.outcome, null); assert.equal(retryOp(m).hostRetryOf, 'op1'); assert.equal(retryWork(m).localOperations?.length, 1);
  if (m.c.intents.find(w => w.id === state(this).work)?.kind === 'check') { assert(m.c.consumedResults.includes('old-check')); assert.equal(m.c.candidate?.text, '候选说明'); }
});
When('用户批准续办后提交新候选并取得检查通过结果', function (this: SpecWorld) {
  const m = model(this); claimRetryWork(m); prepareRetry(m); assert(decideRetry(m).ok); assert(startRetry(m).ok); assert(settleRetry(m).ok);
  assert(deliver(m, retryWork(m)).ok);
  assert.equal(m.c.outcome, null);
  assert(passCheck(m, claimCheck(m), 'new-check').ok);
});
Then('续办结果交接后的候选须重新检查才可最终交付', function (this: SpecWorld) {
  const m = model(this);
  assert.equal(m.c.outcome, 'complete');
  assert.equal(m.c.publishedDelivery?.revision, m.c.candidate?.revision);
});

Given('两条固定宿主命令按序等待续办', function (this: SpecWorld) { const m = twoQueued(); state(this).model = m; prepareRetry(m); });
When('第一条命令{string}', function (this: SpecWorld, outcome: string) {
  const m = model(this);
  if (outcome === '被拒绝') assert(decideRetry(m, 'deny').ok);
  else { assert(decideRetry(m).ok); assert(startRetry(m).ok); assert(settleRetry(m, { failed: true }).ok); }
  state(this).first = outcome === '被拒绝' ? 'HOST_APPROVAL_DENIED' : 'failed';
  assert.deepEqual(m.c.hostRetryRequests?.map(request => request.status), ['settled', 'active']);
  assert.equal(retryOp(m).hostRetryOf, 'op2');
  assert.equal(retryOp(m).approval, undefined);
});
When('运行器为第二条命令准备独立审批', function (this: SpecWorld) {
  prepareRetry(model(this), 'second');
});
Then('第一条应保留真实结论且第二条仍须获得自己的有效授权', function (this: SpecWorld) {
  const m = model(this);
  assert.equal(retryWork(m).localOperations?.[0]?.result?.code, state(this).first);
  assert.equal(retryOp(m).hostRetryOf, 'op2');
  assert.equal(retryOp(m).status, 'awaitingApproval');
  assert.equal(retryOp(m).approval?.id, 'second');
});

Given('两条固定命令按序续办且第一条已经启动', function (this: SpecWorld) {
  const m = twoQueued(); state(this).model = m; prepareRetry(m); assert(decideRetry(m).ok); assert(startRetry(m).ok); state(this).work = retryWork(m).id;
});
When('续办遇到{string}', function (this: SpecWorld, change: string) {
  const m = model(this);
  state(this).change = change;
  if (change === '用户停止后收到迟到回执') assert(m.send({ type: 'STOP' }).ok);
  else if (change === '目标变化后收到迟到回执') assert(m.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
  else {
    if (change === '运行已超时') m.at = retryOp(m).deadline!;
    assert(settleRetry(m, { uncertain: true }).ok);
    if (change === '核对确认实际结果') { const op = retryOp(m); assert(m.send({ type: 'LOCAL_RECONCILE', intentId: retryWork(m).id, operationId: op.id, sessionId: op.sessionId, resolution: 'receipt', result: { ok: true, code: 'succeeded', data: {} }, detail: '可信回执' }).ok); }
  }
  if (change.includes('迟到回执')) { const work = m.c.intents.find(w => w.id === state(this).work)!, op = work.localOperations![0]!; assert(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: op.sessionId, result: { ok: true, code: 'succeeded', data: {} }, settled: true, effectsKnown: true }).ok); }
});
Then('应保留第一条的实际执行状态且第二条不得启动', function (this: SpecWorld) {
  const m = model(this), work = m.c.intents.find(w => w.id === state(this).work)!;
  const change = state(this).change!; assert.equal(work.localOperations?.length, change === '核对确认实际结果' ? 2 : 1);
  assert(work.localOperations?.[0]?.startedAt !== undefined);
  if (change.includes('迟到回执')) { assert.deepEqual(m.c.hostRetryRequests?.map(r => r.status), ['settled', 'cancelled']); if (change.startsWith('目标变化')) { assert.equal(m.c.goalVersion, 2); assert.equal(m.c.candidate, null); } }
  else if (change === '核对确认实际结果') { assert.equal(retryOp(m).hostRetryOf, 'op2'); assert.equal(retryOp(m).startedAt, undefined); assert.equal(m.snapshot.value, 'running'); }
  else { assert.deepEqual(m.c.hostRetryRequests?.map(r => r.status), ['uncertain', 'active']); assert.equal(m.snapshot.value, 'waitingHuman'); assert.equal(m.c.outcome, null); }
});
Then('未核对的执行效果不得用于宣告正常完成', function (this: SpecWorld) { assert.notEqual(model(this).c.outcome, 'complete'); });

Given('{string}仍需交接且当前无未结算物理操作', function (this: SpecWorld, kind: string) {
  const m = failedSandbox(); state(this).model = m; state(this).first = kind;
  if (kind === '普通协助') {
    assert(m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'H', target: 'B', question: '核查', expected: '证据' }).ok);
  } else if (kind === '成员评审') {
    assert(m.send({ type: 'BLOCKED', workId: m.work.id, fence: m.work, reason: '评审需要' }).ok);
    assert(m.send({ type: 'USER_INPUT', text: '请 B 评审', reviewTargets: ['B'] }).ok);
    assert.equal(m.c.review?.status, 'pending');
  } else {
    assert(m.send({ type: 'USER_INPUT', text: '请 B 讨论', reviewTargets: ['B'] }).ok);
    assert.equal(m.c.discussion?.status, 'planning');
  }
});
When('用户从确定失败的沙箱记录申请宿主续办', function (this: SpecWorld) {
  const m = model(this);
  assert(request(m).ok);
  assert.equal(m.c.hostRetryBatch, undefined);
  if (state(this).first === '普通协助') assert.equal(m.c.assists[0]?.status, 'pending');
});
When('原有工作交回其结果', function (this: SpecWorld) {
  const m = model(this), kind = state(this).first;
  if (kind === '普通协助') {
    assert(m.send({ type: 'HELP_RESULT', requestId: 'H', resultId: 'help-result', status: 'success', answer: '协助结论' }).ok);
  } else if (kind === '成员评审') {
    const plan = m.c.intents.at(-1)!; assert(m.send({ type: 'CLAIM', intentId: plan.id }).ok);
    assert(m.send({ type: 'COORDINATE', workId: plan.id, fence: plan, decision: { action: 'review', question: '核查', expected: '证据', reason: '用户要求' } }).ok);
    const review = m.c.assists.at(-1)!; assert(m.send({ type: 'HELP_RESULT', requestId: review.id, resultId: 'review-result', status: 'success', answer: '评审结论' }).ok);
  } else {
    const plan = m.c.intents.at(-1)!; assert(m.send({ type: 'CLAIM', intentId: plan.id }).ok);
    assert(m.send({ type: 'DISCUSSION_PLAN', workId: plan.id, discussionId: plan.discussionId, fence: plan, decision: { action: 'review', question: '讨论', expected: '证据', reason: '用户要求' } }).ok);
    const member = m.c.intents.at(-1)!; assert(m.send({ type: 'CLAIM', intentId: member.id }).ok);
    assert(m.send({ type: 'DISCUSSION_RESULT', workId: member.id, discussionId: member.discussionId, fence: member, text: '成员结论', status: 'success' }).ok);
    assert(deliver(m).ok);
    const summary = m.c.intents.at(-1)!; assert(m.send({ type: 'CLAIM', intentId: summary.id }).ok);
    assert(m.send({ type: 'DISCUSSION_RESULT', workId: summary.id, discussionId: summary.discussionId, fence: summary, text: '讨论汇总', status: 'success' }).ok);
  }
});
Then('已有工作继续交接且其结果被保留', function (this: SpecWorld) {
  const m = model(this), kind = state(this).first;
  if (kind === '普通协助') {
    assert.equal(m.c.assists[0]?.answer, '协助结论');
    assert.equal(retryWork(m).payload.answer, '协助结论');
  } else if (kind === '成员评审') assert.equal(m.c.assists.at(-1)?.answer, '评审结论');
  else assert.equal(m.c.discussion?.summary, '讨论汇总');
});
Then('宿主续办只能在安全边界开始', function (this: SpecWorld) {
  const m = model(this); assert.equal(retryOp(m).hostRetryOf, 'op1');
  assert.equal(retryOp(m).status, 'queued');
});

Given('当前工作还需一次模型请求且余额仅够一批宿主续办的最低要求', function (this: SpecWorld) {
  const m = failedSandbox(), s = state(this); s.model = m;
  assert(m.send({ type: 'CONSUME', intentId: m.work.id }).ok);
  s.originalOrdinary = m.c.usage.ordinary; m.c.config.limits.ordinary = s.originalOrdinary + 2;
});
When('用户在当前工作结束前提交续办请求', function (this: SpecWorld) { assert(request(model(this)).ok); });
When('当前工作继续申请一次模型请求', function (this: SpecWorld) {
  const m = model(this);
  assert(m.send({ type: 'CONSUME', intentId: m.work.id }).ok);
});
Then('当前模型请求仍可使用原有额度', function (this: SpecWorld) {
  const m = model(this);
  assert.equal(m.c.usage.ordinary, state(this).originalOrdinary! + 1);
});
When('负责人提交当前候选并跨入续办安全边界', function (this: SpecWorld) {
  assert(deliver(model(this)).ok);
});
Then('安全边界重核额度不足时应记录未执行原因且无宿主进程启动', function (this: SpecWorld) {
  const m = model(this);
  assert.equal(m.c.hostRetryRequests?.[0]?.reason, 'BUDGET_EXHAUSTED'); assert.equal(m.c.outcome, 'partial');
  assert.equal(m.c.intents.flatMap(w => w.localOperations ?? []).filter(op => op.hostRetryOf).length, 0);
});
