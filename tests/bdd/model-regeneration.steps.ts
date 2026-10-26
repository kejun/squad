import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter, type MemoryStore, type SqliteStore } from '../../src/index.js';
import { WebService } from '../../src/web/service.js';
import { badModelOutput, goodModelOutput, modelResponse, RegenerationFixture, regenerationConfig, type ModelKind } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

interface RepairState { fixture: RegenerationFixture; directory?: string; web?: WebService; room?: string; failure?: unknown; expectFailure?: boolean; savedId?: string }
const states = new WeakMap<SpecWorld, RepairState>();
const state = (world: SpecWorld) => { const s = states.get(world); assert(s); return s; };
function setup(world: SpecWorld, kind: ModelKind = 'check', limits: Parameters<typeof regenerationConfig>[0] = {}, sqlite = false) {
  const fixture = new RegenerationFixture(kind, limits, sqlite); states.set(world, { fixture }); return fixture;
}
After(async function (this: SpecWorld) {
  const s = states.get(this); if (!s) return;
  await s.web?.close(); s.fixture.close(); if (s.directory) rmSync(s.directory, { recursive: true, force: true }); states.delete(this);
});

Given('检查模型先返回{string}再返回合法检查结果', function (this: SpecWorld, issue: string) {
  const f = setup(this); f.replies = [badModelOutput(issue), goodModelOutput('check')];
});
When('执行这次模型检查', async function (this: SpecWorld) {
  const s = state(this);
  try { await s.fixture.run(); } catch (error) { if (!s.expectFailure) throw error; s.failure = error; }
});
Then('应重新请求一次并只提交合法检查结果', function (this: SpecWorld) {
  const f = state(this).fixture, c = f.h.context();
  assert.equal(f.requests.length, 2); assert.equal(c.outcome, 'complete');
  assert.equal(c.trace.filter(t => t.event === 'CHECK_RESULT').length, 1);
  assert.equal(c.lateResults.length, 0); assert.equal(f.repairs.length, 1);
  assert(JSON.stringify(f.requests[1]!.messages).includes('model_output_validation_error'));
  assert(JSON.stringify(f.requests[1]!.messages).includes('gaps'));
});
Then('修正应消耗一次重试和一次检查额度', function (this: SpecWorld) {
  const f = state(this).fixture, c = f.h.context(); assert.equal(c.usage.retries, 1); assert.equal(c.usage.checks, 2);
  assert.equal(c.usage.ordinary, 1); assert.equal(f.work.outputRepair?.count, 1);
});

Given('{string}模型先返回{string}再返回该角色合法结果', function (this: SpecWorld, kind: string, issue: string) {
  assert(['owner', 'assistance', 'facilitator'].includes(kind)); const f = setup(this, kind as ModelKind);
  f.replies = [badModelOutput(issue), goodModelOutput(kind as ModelKind)];
});
When('执行该角色的模型工作', async function (this: SpecWorld) {
  const f = state(this).fixture; await f.run();
  if (f.kind === 'assistance') await f.run(); // Consume the saved result without starting the next owner's model call.
});
Then('应带校验反馈重新生成且只应用合法动作', function (this: SpecWorld) {
  const f = state(this).fixture, c = f.h.context(); assert.equal(f.requests.length, 2); assert.equal(f.repairs.length, 1);
  assert.equal(c.usage.retries, 1); assert.equal(c.usage.ordinary, 2);
  assert(JSON.stringify(f.requests[1]!.messages).includes('model_output_validation_error'));
  if (f.kind === 'owner') { assert.equal(f.h.view().phase, 'checking'); assert(c.candidate?.text.includes('合法完整结果')); }
  else if (f.kind === 'assistance') { assert.equal(f.h.view().phase, 'running'); assert(c.assists[0]!.answer?.includes('合法完整结果')); }
  else { assert.equal(f.h.view().phase, 'running'); assert.equal(c.trace.filter(t => t.event === 'COORDINATE').length, 1); }
});

Given('格式修正的共享重试上限为2且模型持续返回不合规检查', function (this: SpecWorld) {
  setup(this, 'check', { retries: 2 }).fallback = badModelOutput('gaps缺失');
});
Then('实际请求应为3次且修正计数为2', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 3); assert.equal(f.h.context().usage.retries, 2);
  assert.equal(f.h.context().usage.checks, 3); assert.equal(f.work.outputRepair?.count, 2); assert.equal(f.repairs.length, 2);
});
Then('应等待用户并保留明确原因而不批准交付', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.h.view().phase, 'waitingHuman'); assert.equal(f.h.context().outcome, null);
  assert(f.h.context().reason.includes('OUTPUT_REPAIR_EXHAUSTED'));
  assert(!f.h.context().trace.some(t => t.event === 'CHECK_RESULT'));
});

Given('首次返回格式错误时{string}已耗尽', function (this: SpecWorld, limit: string) {
  const f = limit === '普通额度' ? setup(this, 'owner', { ordinary: 1 })
    : limit === '检查额度' ? setup(this, 'check', { checks: 1 }) : setup(this, 'check', { retries: 0 });
  f.fallback = f.kind === 'check' ? badModelOutput('gaps缺失') : badModelOutput('空答案');
});
When('执行受限的模型工作', async function (this: SpecWorld) { await state(this).fixture.run(); });
Then('应只发出首次请求且不应用不合规输出', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 1); assert.equal(f.repairs.length, 0);
  assert.equal(f.h.context().usage.retries, 0); assert.equal(f.h.view().phase, 'waitingHuman');
  assert.equal(f.h.context().outcome, null); assert(!f.h.context().trace.some(t => t.event === 'CHECK_RESULT'));
  if (f.kind === 'owner') assert.equal(f.h.context().candidate, null);
});

Given('首次不合规检查返回前发生{string}', function (this: SpecWorld, change: string) {
  const f = setup(this); f.fallback = badModelOutput('gaps缺失'); f.beforeResponse = () => {
    if (change === '用户停止') assert(f.h.event({ type: 'STOP' }).ok);
    else if (change === '工作超时') f.h.now = f.work.deadline!;
    else assert(f.h.event({ type: 'USER_INPUT', text: '更新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
  };
});
Then('不得发出第二次请求或提交检查通过', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 1); assert.equal(f.repairs.length, 0);
  assert(!f.h.context().trace.some(t => t.event === 'CHECK_RESULT')); assert.notEqual(f.h.context().outcome, 'complete');
});

Given('模型请求返回{string}', function (this: SpecWorld, fault: string) {
  const f = setup(this); f.responseFactory = () => fault === 'HTTP401' ? new Response('private-provider-body', { status: 401 })
    : fault === '输出截断' ? modelResponse(goodModelOutput('check'), 'length') : Response.json({ unrelated: 'not-a-completion' });
});
Then('不应保存格式修正记录且沿用原有故障处理', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 1); assert.equal(f.repairs.length, 0);
  assert.equal(f.h.view().phase, 'waitingHuman'); assert.equal(f.h.context().usage.retries, 0);
});

const secret = 'INVALID_RETURN_SECRET_DO_NOT_RETAIN';
Given('负责人已读到工具结果后返回含敏感回显的不合规输出', function (this: SpecWorld) {
  const f = setup(this, 'owner'); f.replies = [{ type: 'findSkills', query: 'review' }, { type: 'deliver', text: secret }, goodModelOutput('owner')];
});
When('在同一次工作内修正并继续', async function (this: SpecWorld) { await state(this).fixture.run(); });
Then('应保留工具结果且不重新执行工具', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 3); assert.equal(f.searches, 1);
  assert(JSON.stringify(f.requests[2]!.messages).includes('已取得的工具资料'));
  assert.equal(f.h.context().usage.ordinary, 4); assert.equal(f.h.context().usage.retries, 1);
});
Then('修正反馈和持久化记录不得包含原始无效返回', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert(!JSON.stringify(f.requests).includes(secret)); assert(!JSON.stringify(f.currentStore.read(f.h.room)).includes(secret));
});

Given('{string}中已保存一次模型输出修正', function (this: SpecWorld, store: string) {
  const f = setup(this, 'check', {}, store === 'SQLite'), work = f.h.claim('check');
  const id = 'persisted-output-repair'; state(this).savedId = id;
  assert(f.h.event({ type: 'REGENERATE_MODEL_OUTPUT', id, intentId: work.id, issue: 'check_gaps_strings' }).ok);
});
When('重复提交相同修正回执并重新打开执行引擎', async function (this: SpecWorld) {
  const s = state(this), f = s.fixture;
  assert(f.h.event({ type: 'REGENERATE_MODEL_OUTPUT', id: s.savedId!, intentId: f.work.id, issue: 'check_gaps_strings' }).ok);
  await f.reopen(); await f.run();
});
Then('修正计数应只保留一次且后续请求携带修正要求', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.h.context().usage.retries, 1); assert.equal(f.work.outputRepair?.count, 1);
  assert.equal(f.repairs.length, 1); assert.equal(f.requests.length, 1);
  assert(JSON.stringify(f.requests[0]!.messages).includes('check_gaps_strings')); assert.equal(f.h.context().outcome, 'complete');
});

Given('网页任务的模型检查先不合规再修正通过', function (this: SpecWorld) {
  setup(this); const s = state(this), config = regenerationConfig();
  s.directory = mkdtempSync(join(tmpdir(), 'squad-web-schema-')); let calls = 0;
  const adapter = new OpenAICompatibleAdapter(config, { transport: async () => modelResponse(++calls === 1 ? goodModelOutput('owner') : calls === 2 ? badModelOutput('gaps缺失') : goodModelOutput('check')) });
  s.web = new WebService(config, join(s.directory, 'team.sqlite'), adapter); s.room = s.web.createRoom().id;
});
When('通过网页执行器完成任务', async function (this: SpecWorld) {
  const s = state(this); s.web!.submit(s.room!, { id: 'web-schema', text: '请形成可检查方案' });
  for (let n = 0; n < 100; n++) {
    if (s.web!.snapshot(s.room!).tasks[0]?.phase === 'ended') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('网页任务没有在有限时间内完成');
});
Then('任务应完成且过程记录包含格式修正和后续请求', function (this: SpecWorld) {
  const s = state(this), snapshot = s.web!.snapshot(s.room!);
  assert.equal(snapshot.tasks[0]!.outcome, 'complete'); assert(snapshot.events.some(e => e.title === '模型输出格式不合规，重新生成'));
  assert(snapshot.events.some(e => e.title === '发起后续请求'));
  assert.equal(s.web!.engine.view(s.room!, 'task:web-schema')!.context.usage.retries, 1);
});

Given('模型返回布尔false和真实字符串缺口数组', function (this: SpecWorld) { setup(this).fallback = { type: 'check', passed: false, gaps: ['证据仍需核实'] }; });
Then('应应用不通过判断且不消耗格式修正次数', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 1); assert.equal(f.repairs.length, 0);
  assert.equal(f.h.context().usage.retries, 0); assert.equal(f.h.view().phase, 'coordinating');
  assert(f.h.context().trace.some(t => t.event === 'CHECK_RESULT')); assert.equal(f.h.context().outcome, null);
});

Given('{string}在保存模型输出修正时失败', function (this: SpecWorld, store: string) {
  const f = setup(this, 'check', {}, store === 'SQLite'); f.fallback = badModelOutput('gaps缺失');
  state(this).expectFailure = true;
  f.beforeResponse = () => { (f.currentStore as MemoryStore | SqliteStore).failNextCommit = true; };
});
Then('不得发出第二次请求且修正计数不应提交', function (this: SpecWorld) {
  const s = state(this), f = s.fixture; assert(s.failure instanceof Error); assert.equal(f.requests.length, 1);
  assert.equal(f.h.context().usage.retries, 0); assert.equal(f.work.outputRepair, undefined);
});
