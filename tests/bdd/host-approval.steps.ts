import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Given, When, Then, After } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { HostApprovalFixture, hostUntil } from '../host-approval-fixture.js';
import { HostApprovalUISession } from '../host-approval-ui-session.js';
import type { WebHostApproval } from '../../src/web/contracts.js';
import { LocalModel, localModelInput } from '../local-model-fixture.js';

interface State { f?: HostApprovalFixture; ui?: HostApprovalUISession; a?: WebHostApproval; saved?: string; verified?: boolean; count?: number; usage?: number }
const states = new WeakMap<SpecWorld, State>();
const state = (w: SpecWorld) => { let s = states.get(w); if (!s) { s = {}; states.set(w, s); } return s; };
async function setup(w: SpecWorld, wait: boolean) {
  const s = state(w); s.f = new HostApprovalFixture(); await s.f.open(); s.f.submit();
  if (wait) s.a = await s.f.approval();
  return s;
}
After(async function (this: SpecWorld) { const s = states.get(this); await s?.ui?.close(); await s?.f?.close(); });
Given('Bot 提交了一条带原因的宿主命令请求', async function (this: SpecWorld) { await setup(this, false); });
Given('一个宿主请求正在等待批准', async function (this: SpecWorld) { await setup(this, true); });
When('运行器准备命令并等待用户', async function (this: SpecWorld) { const s = state(this); s.a = await s.f!.approval(); s.count = s.f!.requests.length; s.usage = s.f!.snapshot().tasks[0]!.usage.ordinary; });
Then('应持久显示命令参数、真实目录、宿主账号和原因且尚未启动命令', async function (this: SpecWorld) {
  const s = state(this), a = s.a!; assert.equal(a.executable, s.f!.executable); assert.equal(a.cwd, s.f!.source); assert(a.account && a.host && a.reason); assert.equal(await s.f!.runs(), '');
});
Then('等待期间不得反复请求模型、扣执行额度或占住工作区租约', function (this: SpecWorld) {
  const s = state(this), f = s.f!; f.service.engine.tick(f.room.id); assert.equal(f.requests.length, s.count); assert.equal(f.snapshot().tasks[0]!.usage.ordinary, s.usage);
  // A second task can claim this exact engineering root while the first waits.
  const room = f.service.createRoom('租约验证'), task = f.service.engine.submit(room.id, { id: 'lease-task', text: '核查' }).taskId!;
  const work = f.service.engine.claim(room.id, task, f.service.engine.pending(room.id, task)[0]!.id)!;
  const op = f.service.engine.requestLocal(room.id, task, work.id, work.attempt, { type: 'runCli', executable: 'node', args: [] }, [], f.runtime.workspaceId(work, f.service.engine.localNamespace(room.id, task)));
  const claim = f.service.engine.claimLocal(room.id, task, work.id, op.id, work.attempt); assert(claim.response.ok);
  f.service.engine.send(room.id, task, { type: 'LOCAL_RESULT', id: 'lease-fixture-result', at: Date.now(), intentId: work.id, operationId: op.id, sessionId: claim.operation!.sessionId!, result: { ok: false, code: 'fixture-not-started', data: {} }, settled: true, effectsKnown: true });
  f.service.stop(room.id, task, 'lease-stop');
});
When('用户批准对应的命令并重复提交同一次批准', async function (this: SpecWorld) {
  const s = state(this), data = s.f!.decisionData(s.a!, 'approve'); assert.equal((await s.f!.request(data)).status, 200); assert.equal((await s.f!.request(data)).status, 200);
});
Then('宿主命令只应执行一次且输出交还原 Bot', async function (this: SpecWorld) { await state(this).f!.assertSuccessfulRun(); });
Then('宿主命令应使用服务账号的真实用户目录并记录真实会话', async function (this: SpecWorld) { await state(this).f!.assertSuccessfulRun(); });
When('用户拒绝该请求', async function (this: SpecWorld) { const s = state(this); assert.equal((await s.f!.request(s.f!.decisionData(s.a!, 'deny'))).status, 200); await s.f!.complete(); });
Then('不得启动宿主进程且 Bot 应收到明确拒绝回执', async function (this: SpecWorld) { const f = state(this).f!; assert.equal(await f.runs(), ''); assert.equal(f.operation()?.result?.code, 'HOST_APPROVAL_DENIED'); assert(f.requests.at(-1)!.messages.some(m => m.content.includes('HOST_APPROVAL_DENIED'))); });
Then('拒绝后旧批准请求不得重新授权', async function (this: SpecWorld) { const s = state(this); assert.equal((await s.f!.request(s.f!.decisionData(s.a!, 'approve'))).status, 409); });
When('请求发生{string}后尝试批准或执行', async function (this: SpecWorld, change: string) {
  const s = state(this), f = s.f!, a = s.a!;
  if (change === '工作区内容变化' || change === '可执行文件变化') {
    await writeFile(change === '工作区内容变化' ? join(f.source, 'changed') : f.executable, 'changed');
    assert.equal((await f.request(f.decisionData(a, 'approve'))).status, 200); await f.complete(); assert.equal(f.operation()?.result?.code, 'HOST_APPROVAL_STALE');
  } else {
    if (change === '停止任务') f.service.stop(f.room.id, a.taskId, 'stop-bdd');
    else if (change === '超过期限') {
      // Explicit controlled clock event drives the actual persisted model expiration.
      const op = f.operation()!; assert(f.service.engine.send(f.room.id, a.taskId, { type: 'LOCAL_APPROVAL_EXPIRED', id: 'expire-bdd', at: op.approval!.expiresAt, intentId: a.workId, operationId: a.operationId }).ok);
    } else if (change === '目标版本变化') {
      f.service.stop(f.room.id, a.taskId, 'stop-old-goal');
      await hostUntil(() => f.snapshot(), snapshot => snapshot.tasks.at(-1)?.outcome === 'stopped');
      f.service.submit(f.room.id, { id: 'new-goal', text: '另一个目标', intent: 'new' });
    }
    const data = f.decisionData(a, 'approve'); if (change === '批准标识不匹配') data.approvalId = 'wrong';
    assert.equal((await f.request(data)).status, 409);
  }
  s.verified = true;
});
Then('不得执行过期或改变后的宿主命令', async function (this: SpecWorld) { const s = state(this); assert(s.verified); assert.equal(await s.f!.runs(), ''); });
Given('宿主命令已获批准但尚未领取执行', async function (this: SpecWorld) {
  const s = await setup(this, true), f = s.f!, a = s.a!;
  assert(f.service.engine.decideHostApproval(f.room.id, a.taskId, a.workId, a.operationId, a.approvalId, 'approve', 'approve-before-crash').ok);
  s.saved = f.savedRoom();
});
When('服务重启恢复原任务', async function (this: SpecWorld) { const s = state(this); await s.f!.restart(s.saved); });
Then('应重新等待用户确认且旧页面的批准标识失效', async function (this: SpecWorld) {
  const s = state(this), after = await s.f!.approval(); assert.notEqual(after.approvalId, s.a!.approvalId); assert.equal((await s.f!.request(s.f!.decisionData(s.a!, 'approve'))).status, 409); assert.equal(await s.f!.runs(), '');
});
Then('已开始但效果不明的宿主命令仍须核对而不得重放', function (this: SpecWorld) {
  const s = state(this), m = new LocalModel(); m.request({ type: 'runCli', executable: 'node', args: [], execution: 'host', reason: 'fixture' }); m.claim();
  const approval = structuredClone(s.f!.operation()!.approval!); approval.plan.reason = 'fixture'; approval.expiresAt = 900;
  assert(m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', approval }).ok);
  assert(m.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: m.work.id, operationId: 'op1', approvalId: approval.id, decision: 'approve', fence: m.work }).ok);
  m.claim(); m.started(); m.send({ type: 'RECOVER', config: localModelInput().config }); assert.equal(m.op?.status, 'uncertain'); assert(!m.claim().ok);
});
Then('崩溃后即使确认命令尚未启动也必须重新批准', function (this: SpecWorld) {
  const s = state(this), m = new LocalModel();
  m.request({ type: 'runCli', executable: 'node', args: [], execution: 'host', reason: 'fixture' }); m.claim();
  const approval = structuredClone(s.f!.operation()!.approval!); approval.plan.reason = 'fixture'; approval.expiresAt = 900;
  assert(m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', approval }).ok);
  assert(m.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: m.work.id, operationId: 'op1', approvalId: approval.id, decision: 'approve', fence: m.work }).ok);
  m.claim(); m.send({ type: 'RECOVER', config: localModelInput().config });
  assert(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'notStarted', detail: 'No launch journal' }).ok);
  assert.equal(m.op?.status, 'awaitingApproval'); assert.notEqual(m.op?.approval?.id, approval.id); assert(!m.claim().ok);
});
When('其他来源尝试提交批准或伪造命令参数', async function (this: SpecWorld) { const s = state(this), f = s.f!, data = f.decisionData(s.a!, 'approve'); assert.equal((await f.request(data, 'http://other.example')).status, 403); assert.equal((await f.request(data, null)).status, 403); assert.equal((await f.request({ ...data, args: ['changed'] })).status, 400); });
Then('服务应拒绝请求且命令仍等待用户决定', async function (this: SpecWorld) { const f = state(this).f!; assert.equal(f.operation()?.status, 'awaitingApproval'); assert.equal(await f.runs(), ''); });
Given('默认沙箱命令返回业务失败', async function (this: SpecWorld) { const s = state(this); s.f = new HostApprovalFixture(); await s.f.open(); s.f.action = { type: 'runCli', executable: s.f.executable, args: [] }; s.f.submit(); });
When('Bot 收到失败回执', async function (this: SpecWorld) { const f = state(this).f!; await hostUntil(() => f.operation(), op => op?.status === 'failed'); });
Then('不得自动在宿主重跑且任何宿主请求均需单独批准', async function (this: SpecWorld) { const f = state(this).f!; assert.equal(await f.runs(), ''); assert.equal(f.snapshot().hostApprovals!.length, 0); });
Given('网页收到正在等待的宿主命令请求', async function (this: SpecWorld) { const s = state(this); s.ui = new HostApprovalUISession(); await s.ui.open(); });
When('用户关闭提示后重新打开待处理请求并拒绝', async function (this: SpecWorld) { await state(this).ui!.interact(); });
Then('关闭提示不得批准或拒绝命令且拒绝只提交对应请求', function (this: SpecWorld) { const ui = state(this).ui!; assert(ui.posts.every(p => p.decision === 'deny')); assert.equal(ui.posts[0]!.approvalId, ui.posts[1]!.approvalId); });
Then('网页应显示提交错误并允许重试且切群不得批准其他请求', function (this: SpecWorld) { assert.equal(state(this).ui!.posts.length, 2); });
