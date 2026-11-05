import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, When, Then, After } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { HostSessionFixture } from '../host-session-fixture.js';
import { grantedSession, SessionModel } from '../host-session-model-fixture.js';
import { localModelInput } from '../local-model-fixture.js';
import { validLocalAction } from '../../src/local-operation.js';

interface State { f?: HostSessionFixture; m?: SessionModel; verified?: boolean; refreshed?: boolean }
const states = new WeakMap<SpecWorld, State>();
const state = (w: SpecWorld) => { let s = states.get(w); if (!s) { s = {}; states.set(w, s); } return s; };
async function setup(w: SpecWorld) { const f = new HostSessionFixture(); state(w).f = f; await f.pending(); return f; }
After(async function (this: SpecWorld) { await states.get(this)?.f?.close(); });
Given('一条会话验证用宿主请求正在等待批准', async function (this: SpecWorld) { await setup(this); });
When('用户允许本次会话并执行两条不同的宿主命令', async function (this: SpecWorld) {
  const s = state(this), f = s.f!, a = await f.approval(), id = randomUUID();
  const grant = f.grantWithoutNotify(a, id);
  assert.deepEqual((await f.refresh()).hostSessions, [grant]); assert.deepEqual((await f.refresh()).hostSessions, [grant]); s.refreshed = true;
  const decision = f.decisionData(a, 'approveSession', id); assert.equal((await f.request(decision)).status, 200); assert.equal((await f.request(decision)).status, 200);
  await f.assertTwoRuns();
});
Then('两条命令各执行一次且第二条无需用户再次批准', async function (this: SpecWorld) { await state(this).f!.assertTwoRuns(); });
Then('网页刷新保留会话授权且仍可选择仅允许本次命令', function (this: SpecWorld) {
  assert.equal(state(this).refreshed, true);
  const m = new SessionModel(); assert(m.prepare().ok); assert(m.decideCurrent('approve').ok); assert(m.finishCurrent().ok); assert(m.prepare().ok);
  assert.equal(m.c.hostSession, undefined); assert.equal(m.current.status, 'awaitingApproval');
});
Given('当前任务已有宿主会话授权', function (this: SpecWorld) { state(this).m = grantedSession(); });
When('会话遇到{string}', function (this: SpecWorld, change: string) {
  const s = state(this), m = s.m!;
  switch (change) {
    case '任务结束': assert(m.send({ type: 'EXHAUSTED', reason: '验证结束' }).ok); assert.equal(m.c.hostSession, undefined); break;
    case '停止': assert(m.send({ type: 'STOP' }).ok); assert.equal(m.c.hostSession, undefined); break;
    case '目标变化': assert(m.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok); assert.equal(m.c.hostSession, undefined); break;
    case '服务重启': assert(m.send({ type: 'RECOVER', config: localModelInput().config }).ok); assert.equal(m.c.hostSession, undefined); assert(m.send({ type: 'CLAIM', intentId: m.work.id }).ok); m.work = m.c.intents.find(w => w.id === m.work.id)!; assert(m.prepare().ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    case '其他任务': { const other = new SessionModel(); assert(other.prepare().ok); assert.equal(other.current.status, 'awaitingApproval'); break; }
    case '环境变化': assert(m.prepare(a => { a.plan.environmentHash = 'f'.repeat(64); }).ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    case '权限关闭': assert(m.prepare().ok); m.c.config.localTools = { enabled: false }; assert.equal(m.claimCurrent().code, 'LOCAL_TOOLS_DISABLED'); break;
    case '用户撤销': assert(m.send({ type: 'REVOKE_HOST_SESSION', grantId: m.c.hostSession!.id, fence: m.work }).ok); assert.equal(m.c.hostSession, undefined); assert(m.prepare().ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    default: throw new Error('Unknown session boundary: ' + change);
  }
  s.verified = true;
});
Then('后续命令不得复用失效或不匹配的授权', function (this: SpecWorld) { assert.equal(state(this).verified, true); });
Given('网页提供仅本次及本次会话两种授权选择', async function (this: SpecWorld) { await setup(this); });
When('用户选择本次会话后撤销授权', async function (this: SpecWorld) {
  const f = state(this).f!, a = await f.approval(), grant = f.grantWithoutNotify(a);
  assert.equal((await f.revoke(grant.grantId)).status, 200); assert.deepEqual(f.snapshot().hostSessions, []);
  const fresh = await f.approval(); assert.notEqual(fresh.approvalId, a.approvalId); assert.equal(await f.runs(), '');
});
Then('后续宿主请求恢复按次审批且模型或跨来源请求不能授权', async function (this: SpecWorld) {
  const f = state(this).f!, a = await f.approval(), data = f.decisionData(a, 'approveSession');
  assert.equal((await f.request(data, 'http://other.example')).status, 403);
  assert.equal((await f.request({ ...data, sessionGrantId: 'forged' })).status, 400);
  assert.equal(validLocalAction({ type: 'runCli', executable: 'node', args: [], execution: 'host', reason: '模型申请', sessionGrantId: 'forged' }), false);
  assert.equal(await f.runs(), ''); assert.equal(f.snapshot().hostApprovals!.length, 1);
});
