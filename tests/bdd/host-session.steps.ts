import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, When, Then, After } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { HostSessionFixture } from '../host-session-fixture.js';
import { grantedSession, SessionModel, askSessionHelper, startSessionBackgroundHelper } from '../host-session-model-fixture.js';
import { twoQueued, prepareRetry, decideRetry, claimRetryOp, retryWork, retryOp, startRetry, settleRetry } from '../host-retry-model-fixture.js';
import type { LocalModel } from '../local-model-fixture.js';
import { localModelInput } from '../local-model-fixture.js';
import type { Intent } from '../../src/types.js';
import { validLocalAction } from '../../src/local-operation.js';

interface State { f?: HostSessionFixture; m?: SessionModel; verified?: boolean; refreshed?: boolean; permission?: string; role?: string; owner?: Intent; helper?: Intent; grantId?: string; before?: number; stage?: string; retry?: LocalModel; change?: string; observedCode?: string; other?: SessionModel }
const states = new WeakMap<SpecWorld, State>();
const state = (w: SpecWorld) => { let s = states.get(w); if (!s) { s = {}; states.set(w, s); } return s; };
async function setup(w: SpecWorld) { const f = new HostSessionFixture(); state(w).f = f; await f.pending(); return f; }
After(async function (this: SpecWorld) { await states.get(this)?.f?.close(); });
Given('同任务的{string}准备使用{string}授权', async function (this: SpecWorld, role: string, permission: string) {
  const s = state(this); s.role = role; s.permission = permission;
  if (permission === '仅本次') { s.m = new SessionModel(); assert(s.m.prepare().ok); }
  else if (role === '负责人') { await setup(this); s.m = grantedSession(); }
  else if (role === '普通协助成员') { s.m = grantedSession(); s.grantId = s.m.c.hostSession!.id; askSessionHelper(s.m); }
  else { s.m = new SessionModel(); assert(s.m.prepare().ok); s.owner = s.m.work; startSessionBackgroundHelper(s.m); assert(s.m.prepare().ok); s.helper = s.m.work; assert.equal(s.m.current.status, 'awaitingApproval'); }
});
When('用户按选择授权并继续处理下一条宿主命令', async function (this: SpecWorld) {
  const s = state(this), m = s.m!;
  if (s.permission === '仅本次') { assert(m.decideCurrent('approve').ok); assert(m.finishCurrent().ok); assert(m.prepare().ok); return; }
  if (s.role === '普通协助成员') { assert(m.prepare().ok); assert.equal(m.current.status, 'queued'); assert.equal(m.current.approval?.sessionGrantId, s.grantId); assert(m.finishCurrent().ok); return; }
  if (s.role === '并行等待的协助成员') { m.work = s.owner!; assert(m.decideCurrent().ok); assert.equal(m.current.status, 'queued'); assert.equal(m.current.approval?.sessionGrantId, m.c.hostSession?.id); m.work = s.helper!; return; }
  assert(m.prepare(a => { a.plan.workspaceRevision = 'f'.repeat(64); a.plan.executable = '/bin/gh'; }).ok);
  assert.equal(m.current.status, 'queued'); assert.equal(m.current.approval?.sessionGrantId, m.c.hostSession?.id); assert(m.finishCurrent().ok);
  const f = s.f!, a = await f.approval(), id = randomUUID();
  const grant = f.grantWithoutNotify(a, id);
  assert.deepEqual((await f.refresh()).hostSessions, [grant]); assert.deepEqual((await f.refresh()).hostSessions, [grant]); s.refreshed = true;
  const decision = f.decisionData(a, 'approveSession', id); assert.equal((await f.request(decision)).status, 200); assert.equal((await f.request(decision)).status, 200);
  await f.assertTwoRuns();
});
Then('对应成员应保留独立命令计划并仅使用匹配的会话授权', async function (this: SpecWorld) {
  const s = state(this), m = s.m!;
  if (s.permission === '仅本次') { assert.equal(m.c.hostSession, undefined); assert.equal(m.current.status, 'awaitingApproval'); }
  else if (s.role === '负责人') { await s.f!.assertTwoRuns(); assert.equal(m.c.usage.ordinary, 3); assert.equal(m.current.approval?.plan.executable, '/bin/gh'); }
  else if (s.role === '普通协助成员') { assert.equal(m.work.target, 'B'); assert.equal(m.c.usage.ordinary, 4); assert.equal(m.current.status, 'succeeded'); }
  else { assert.equal(m.current.status, 'queued'); assert.equal(m.current.approval?.sessionGrantId, m.c.hostSession?.id); assert.equal(m.current.startedAt, undefined); }
});
Then('会话授权保持原有范围且仅允许本次命令不会授权下一条', function (this: SpecWorld) {
  const s = state(this); if (s.f) assert.equal(s.refreshed, true);
  assert.equal(!!s.m!.c.hostSession, s.permission !== '仅本次');
});
Given('{string}的宿主会话准备核对边界', function (this: SpecWorld, preparation: string) {
  const s = state(this);
  if (preparation === '续办已经批准') { s.retry = twoQueued(); prepareRetry(s.retry); assert(decideRetry(s.retry, 'approveSession').ok); }
  else if (preparation === '已有授权') s.m = grantedSession();
  else { s.m = new SessionModel(); assert(s.m.prepare().ok); s.owner = s.m.work; startSessionBackgroundHelper(s.m); assert(s.m.prepare(a => { a.plan.environmentHash = 'f'.repeat(64); }).ok); s.helper = s.m.work; s.m.work = s.owner; }
});
When('会话遇到{string}', function (this: SpecWorld, change: string) {
  const s = state(this), m = s.m!; s.change = change;
  switch (change) {
    case '续办授权撤销后重新批准': {
      const r = s.retry!, old = retryOp(r).approval!.id; assert(claimRetryOp(r, 'run-claim').ok); const work = retryWork(r), op = retryOp(r);
      assert(r.send({ type: 'REVOKE_HOST_SESSION', grantId: r.c.hostSession!.id, fence: work }).ok);
      assert.equal(r.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: 'run-claim' }).code, 'HOST_APPROVAL_REQUIRED');
      assert(r.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: 'run-claim', result: { ok: false, code: 'HOST_APPROVAL_REQUIRED', data: {} }, settled: true, effectsKnown: true }).ok);
      assert.equal(retryOp(r).status, 'awaitingApproval'); assert.notEqual(retryOp(r).approval?.id, old); assert.equal(retryWork(r).localOperations?.length, 1);
      const before = r.c.usage.ordinary; s.before = before; r.c.config.limits.ordinary = before + 1; assert(decideRetry(r).ok); assert(startRetry(r, 'run-fresh').ok); assert.equal(r.c.usage.ordinary, before); assert(settleRetry(r).ok); assert.equal(retryOp(r).hostRetryOf, 'op2'); break;
    }
    case '续办计划变化后重新准备': {
      const r = s.retry!; assert(claimRetryOp(r, 'changed-plan').ok); const work = retryWork(r), op = retryOp(r);
      assert(r.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: 'changed-plan', result: { ok: false, code: 'HOST_APPROVAL_STALE', data: {} }, settled: true, effectsKnown: true }).ok);
      assert.equal(retryOp(r).status, 'queued'); assert.equal(retryOp(r).approval, undefined); prepareRetry(r, 'updated-plan'); assert.equal(retryOp(r).status, 'awaitingApproval'); assert.equal(retryOp(r).approval?.id, 'updated-plan'); assert(r.c.hostSession); break;
    }
    case '任务结束': assert(m.send({ type: 'EXHAUSTED', reason: '验证结束' }).ok); assert.equal(m.c.hostSession, undefined); break;
    case '停止': assert(m.send({ type: 'STOP' }).ok); assert.equal(m.c.hostSession, undefined); break;
    case '目标变化': assert(m.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok); assert.equal(m.c.hostSession, undefined); break;
    case '服务重启': assert(m.send({ type: 'RECOVER', config: localModelInput().config }).ok); assert.equal(m.c.hostSession, undefined); assert(m.send({ type: 'CLAIM', intentId: m.work.id }).ok); m.work = m.c.intents.find(w => w.id === m.work.id)!; assert(m.prepare().ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    case '其他任务': { const other = new SessionModel(); s.other = other; assert(other.prepare().ok); assert.equal(other.current.status, 'awaitingApproval'); break; }
    case '宿主变化': assert(m.prepare(a => { a.plan.host = 'other'; }).ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    case '账号变化': assert(m.prepare(a => { a.plan.account = 'other'; }).ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    case '工作区变化': assert(m.prepare(undefined, 'other-project').ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    case '明确继续': assert(m.send({ type: 'WAIT_USER', workId: m.work.id, question: '确认', fence: m.work }).ok); assert(m.send({ type: 'CONTINUE' }).ok); assert.equal(m.c.hostSession, undefined); break;
    case '领取后权限关闭': assert(m.prepare().ok); assert(m.claimCurrent().ok); m.c.config.localTools = { enabled: false }; assert.equal(m.startCurrent().code, 'HOST_APPROVAL_REQUIRED'); break;
    case '并行协助环境变化': assert(m.decideCurrent().ok); m.work = s.helper!; assert.equal(m.current.status, 'awaitingApproval'); assert.equal(m.current.approval?.status, 'pending'); assert.equal(m.current.approval?.sessionGrantId, undefined); break;
    case '环境变化': assert(m.prepare(a => { a.plan.environmentHash = 'f'.repeat(64); }).ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    case '权限关闭': assert(m.prepare().ok); m.c.config.localTools = { enabled: false }; assert.equal(m.claimCurrent().code, 'LOCAL_TOOLS_DISABLED'); break;
    case '用户撤销': assert(m.send({ type: 'REVOKE_HOST_SESSION', grantId: m.c.hostSession!.id, fence: m.work }).ok); assert.equal(m.c.hostSession, undefined); assert(m.prepare().ok); assert.equal(m.current.status, 'awaitingApproval'); break;
    default: throw new Error('Unknown session boundary: ' + change);
  }
  s.observedCode = (s.retry ?? m).c.reply.code;
});
Then('后续命令不得复用失效或不匹配的授权', function (this: SpecWorld) {
  const s = state(this), change = s.change!, m = s.m;
  if (change === '续办授权撤销后重新批准') { const r = s.retry!; assert.equal(r.c.hostSession, undefined); assert.equal(r.c.usage.ordinary, s.before); assert.equal(retryOp(r).hostRetryOf, 'op2'); assert.equal(retryOp(r).status, 'queued'); assert.equal(retryOp(r).startedAt, undefined); }
  else if (change === '续办计划变化后重新准备') { const r = s.retry!; assert(r.c.hostSession); assert.equal(retryOp(r).status, 'awaitingApproval'); assert.equal(retryOp(r).approval?.id, 'updated-plan'); assert.equal(retryOp(r).approval?.sessionGrantId, undefined); }
  else if (['任务结束', '停止', '目标变化', '明确继续'].includes(change)) assert.equal(m!.c.hostSession, undefined);
  else if (change === '其他任务') { assert.equal(s.other!.current.status, 'awaitingApproval'); assert.equal(s.other!.c.hostSession, undefined); }
  else if (change === '权限关闭' || change === '领取后权限关闭') { assert.equal(s.observedCode, change === '权限关闭' ? 'LOCAL_TOOLS_DISABLED' : 'HOST_APPROVAL_REQUIRED'); assert.equal(m!.current.startedAt, undefined); }
  else { assert.equal(m!.current.status, 'awaitingApproval'); assert.equal(m!.current.approval?.status, 'pending'); assert.equal(m!.current.approval?.sessionGrantId, undefined); if (change === '服务重启' || change === '用户撤销') assert.equal(m!.c.hostSession, undefined); }
});
Given('会话授权撤销或伪造发生在{string}', async function (this: SpecWorld, stage: string) {
  const s = state(this); s.stage = stage;
  if (stage === '网页用户撤销') { await setup(this); return; }
  s.m = stage === '伪造会话身份' ? new SessionModel() : grantedSession();
  if (stage !== '伪造会话身份') { assert(s.m.prepare().ok); s.grantId = s.m.current.approval!.id; if (stage === '命令已经领取') assert(s.m.claimCurrent().ok); }
});
When('用户撤销或模型尝试替代该会话授权', async function (this: SpecWorld) {
  const s = state(this);
  if (s.stage === '网页用户撤销') { const f = s.f!, a = await f.approval(), grant = f.grantWithoutNotify(a); assert.equal((await f.revoke(grant.grantId)).status, 200); assert.deepEqual(f.snapshot().hostSessions, []); const fresh = await f.approval(); assert.notEqual(fresh.approvalId, a.approvalId); assert.equal(await f.runs(), ''); return; }
  const m = s.m!;
  if (s.stage === '伪造会话身份') { assert.equal(m.prepare(a => { a.sessionGrantId = 'model-forgery'; }).code, 'INVALID_HOST_APPROVAL'); assert.equal(m.send({ type: 'REVOKE_HOST_SESSION', grantId: 'forged', fence: m.work }).code, 'HOST_SESSION_MISMATCH'); }
  else { assert(m.send({ type: 'REVOKE_HOST_SESSION', grantId: m.c.hostSession!.id, fence: m.work }).ok); if (s.stage === '命令已经领取') s.observedCode = m.startCurrent().code; }
});
Then('旧会话不得启动命令且未领取命令应恢复独立审批', async function (this: SpecWorld) {
  const s = state(this);
  if (s.stage === '网页用户撤销') { const f = s.f!, a = await f.approval(), data = f.decisionData(a, 'approveSession'); assert.equal((await f.request(data, 'http://other.example')).status, 403); assert.equal((await f.request({ ...data, sessionGrantId: 'forged' })).status, 400); assert.equal(validLocalAction({ type: 'runCli', executable: 'node', args: [], execution: 'host', reason: '模型申请', sessionGrantId: 'forged' }), false); assert.equal(await f.runs(), ''); assert.equal(f.snapshot().hostApprovals!.length, 1); return; }
  const m = s.m!; assert.equal(m.c.hostSession, undefined);
  if (s.stage === '命令已经领取') { assert.equal(s.observedCode, 'HOST_APPROVAL_REQUIRED'); assert.equal(m.current.startedAt, undefined); }
  else if (s.stage !== '伪造会话身份') { assert.equal(m.current.status, 'awaitingApproval'); assert.notEqual(m.current.approval?.id, s.grantId); }
});
