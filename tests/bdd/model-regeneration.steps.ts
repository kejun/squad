import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter, type MemoryStore, type SqliteStore } from '../../src/index.js';
import { WebService } from '../../src/web/service.js';
import { badModelOutput, goodModelOutput, modelResponse, RegenerationFixture, regenerationConfig, type ModelKind } from '../model-regeneration-fixture.js';
import { candidateJudgments, type EventBody } from '../helpers.js';
import type { SpecWorld } from './steps.js';
import { withFixtureAcceptance } from '../delivery-protocol-fixture.js';

interface RepairState { fixture: RegenerationFixture; directory?: string; web?: WebService; room?: string; failure?: unknown; expectFailure?: boolean; failureEvent?: Extract<EventBody, { type: 'WORK_FAILED' }>; expectedRequests?: number }
const states = new WeakMap<SpecWorld, RepairState>();
const state = (world: SpecWorld) => { const s = states.get(world); assert(s); return s; };
function setup(world: SpecWorld, kind: ModelKind = 'check', limits: Parameters<typeof regenerationConfig>[0] = {}, sqlite = false, sources: string[] = []) {
  const fixture = new RegenerationFixture(kind, limits, sqlite, sources); states.set(world, { fixture }); return fixture;
}
After(async function (this: SpecWorld) {
  const s = states.get(this); if (!s) return;
  await s.web?.close(); s.fixture.close(); if (s.directory) rmSync(s.directory, { recursive: true, force: true }); states.delete(this);
});

Given('检查模型先返回{string}再返回合法检查结果', function (this: SpecWorld, issue: string) {
  const f = setup(this, 'check', {}, false, issue === '引文不属于所指来源' ? ['原始第一份资料', '来自第二份资料的短引文'] : []);
  const results = candidateJudgments(f.h.context().candidate);
  if (issue === '验收项ID重复') f.replies = [{ type: 'check', criteriaResults: [...results, results[0]] }, goodModelOutput('check')];
  else if (issue === '验收项ID未知') f.replies = [{ type: 'check', criteriaResults: [{ criterionId: 'foreign', status: 'passed' }, ...results] }, goodModelOutput('check')];
  else if (issue === '引文不属于所指来源') f.replies = [{ type: 'check', criteriaResults: [
    { ...results[0], status: 'failed', reason: '内容争议', source: { id: f.sources[0], quote: '来自第二份资料的短引文' } }, ...results.slice(1),
  ] }, goodModelOutput('check')];
  else f.replies = [badModelOutput(issue), goodModelOutput('check')];
});
When('执行这次模型检查', async function (this: SpecWorld) {
  const s = state(this);
  try {
    await s.fixture.run();
    if (s.fixture.h.engine.pending(s.fixture.h.room, s.fixture.h.task).some(work => work.kind === 'check')) await s.fixture.run();
  } catch (error) { if (!s.expectFailure) throw error; s.failure = error; }
});
Then('应重新请求一次并只提交合法检查结果', function (this: SpecWorld) {
  const f = state(this).fixture, c = f.h.context();
  assert.equal(f.requests.length, 2); assert.equal(c.outcome, 'complete');
  assert.equal(c.trace.filter(t => t.event === 'CHECK_RESULT').length, 1);
  assert.equal(c.lateResults.length, 0);
  assert.equal(c.deliveryCycle?.retry?.status, 'used');
  assert(JSON.stringify(f.requests[1]!.messages).includes('criteriaResults'));
});
Then('修正应消耗一次重试和一次检查额度', function (this: SpecWorld) {
  const f = state(this).fixture, c = f.h.context(); assert.equal(c.usage.retries, 1); assert.equal(c.usage.checks, 2);
  assert.equal(c.deliveryCycle?.requests, 2);
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

Given('格式修正的共享重试额度充足且模型持续返回不合规检查', function (this: SpecWorld) {
  setup(this, 'check', { retries: 5 }).fallback = badModelOutput('criteriaResults缺失');
});
Then('实际检查请求应为2次且仅消耗一次技术补试', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.requests.length, 2);
  assert.equal(f.h.context().usage.retries, 1);
  assert.equal(f.h.context().usage.checks, 2);
});
Then('应明确结束并保留原因而不批准交付或安排作者重写', function (this: SpecWorld) {
  const { h } = state(this).fixture;
  assert.equal(h.view().phase, 'ended');
  assert.equal(h.context().outcome, 'partial');
  assert(h.context().candidate?.deliveryIssue?.detail);
  assert.equal(h.context().publishedDelivery, undefined);
  assert.equal(h.engine.pending(h.room, h.task).length, 0);
});

Given('首次返回格式错误时{string}已耗尽', function (this: SpecWorld, limit: string) {
  const f = limit === '普通额度' ? setup(this, 'owner', { ordinary: 1 })
    : limit === '检查额度' ? setup(this, 'check', { checks: 1 }) : setup(this, 'check', { retries: 0 });
  f.fallback = f.kind === 'check' ? badModelOutput('criteriaResults缺失') : badModelOutput('空答案');
});
When('执行受限的模型工作', async function (this: SpecWorld) { await state(this).fixture.run(); });
Then('应只发出首次请求且不应用不合规输出', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 1); assert.equal(f.repairs.length, 0);
  assert.equal(f.h.context().usage.retries, 0);
  assert.equal(f.h.view().phase, f.kind === 'check' ? 'ended' : 'waitingHuman');
  assert.equal(f.h.context().outcome, f.kind === 'check' ? 'partial' : null);
  assert.equal(f.h.context().publishedDelivery, undefined);
  if (f.kind === 'owner') assert.equal(f.h.context().candidate, null);
});

Given('首次不合规检查返回前发生{string}', function (this: SpecWorld, change: string) {
  const f = setup(this); f.fallback = badModelOutput('criteriaResults缺失'); f.beforeResponse = () => {
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
  const f = setup(this);
  state(this).expectedRequests = fault === 'HTTP401' ? 1 : 2;
  f.responseFactory = () => fault === 'HTTP401' ? new Response('private-provider-body', { status: 401 })
    : fault === '输出截断' ? modelResponse(goodModelOutput('check'), 'length') : Response.json({ unrelated: 'not-a-completion' });
});
Then('不应保存格式修正记录且沿用原有故障处理', function (this: SpecWorld) {
  const s = state(this), f = s.fixture;
  assert.equal(f.requests.length, s.expectedRequests);
  assert.equal(f.repairs.length, 0);
  assert.equal(f.h.view().phase, 'ended');
  assert.equal(f.h.context().outcome, 'partial');
  assert.equal(f.h.context().usage.retries, s.expectedRequests! - 1);
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

Given('{string}中已为检查保存一次技术补试', function (this: SpecWorld, store: string) {
  const f = setup(this, 'check', {}, store === 'SQLite');
  const work = f.h.authorizeCheck();
  const event = { type: 'WORK_FAILED' as const, id: 'persisted-check-retry', intentId: work.id,
    attempt: work.attempt, fence: work, reason: '检查协议缺少逐项结果', transient: true };
  state(this).failureEvent = event;
  assert(f.h.event(event).ok);
});
When('重复提交相同失败回执并重新打开执行引擎', async function (this: SpecWorld) {
  const s = state(this), f = s.fixture;
  assert(f.h.event(s.failureEvent!).ok);
  await f.reopen();
  assert(await f.run());
});
Then('补试应只计一次且后续请求仍使用原候选和材料', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.h.context().usage.retries, 1);
  assert.equal(f.h.context().usage.checks, 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.h.context().outcome, 'complete');
  const materials = JSON.parse(f.requests[0]!.messages[1]!.content).context;
  assert.equal(materials.candidate.revision, f.h.context().candidate?.revision);
  assert.deepEqual(materials.requirements.map((item: { id: string }) => item.id),
    f.h.context().candidate?.acceptance?.criteria.map(item => item.id));
});

Given('网页任务的模型检查先不合规再修正通过', function (this: SpecWorld) {
  setup(this); const s = state(this), config = regenerationConfig();
  s.directory = mkdtempSync(join(tmpdir(), 'squad-web-schema-')); let calls = 0;
  const adapter = new OpenAICompatibleAdapter(config, { transport: async (_url, request) =>
    modelResponse(withFixtureAcceptance(++calls === 1 ? goodModelOutput('owner') : calls === 2 ? badModelOutput('criteriaResults缺失') : goodModelOutput('check'), request?.body)) });
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
  assert.equal(snapshot.tasks[0]!.outcome, 'complete');
  assert.equal(snapshot.events.filter(event => event.title === '开始检查交付').length, 2);
  assert(snapshot.events.some(event => event.kind === 'error' && /CHECK_|检查协议/.test(event.detail)));
  assert.equal(s.web!.engine.view(s.room!, 'task:web-schema')!.context.usage.retries, 1);
});

Given('模型返回有效的逐项结果并给出有依据的内容错误', function (this: SpecWorld) {
  const f = setup(this);
  f.fallback = { type: 'check', criteriaResults: candidateJudgments(f.h.context().candidate,
    { index: 0, status: 'failed', reason: '报告正文将计划写成已完成' }) };
});
Then('应应用不通过判断且不消耗格式修正次数', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.requests.length, 1); assert.equal(f.repairs.length, 0);
  assert.equal(f.h.context().usage.retries, 0); assert.equal(f.h.view().phase, 'running');
  assert(f.h.context().trace.some(t => t.event === 'CHECK_RESULT')); assert.equal(f.h.context().outcome, null);
});

Given('{string}在保存模型输出修正时失败', function (this: SpecWorld, store: string) {
  const f = setup(this, 'check', {}, store === 'SQLite'); f.fallback = badModelOutput('criteriaResults缺失');
  state(this).expectFailure = true;
  f.beforeResponse = () => { (f.currentStore as MemoryStore | SqliteStore).failNextCommit = true; };
});
Then('不得发出第二次请求且修正计数不应提交', function (this: SpecWorld) {
  const s = state(this), f = s.fixture; assert(s.failure instanceof Error); assert.equal(f.requests.length, 1);
  assert.equal(f.h.context().usage.retries, 0); assert.equal(f.work.outputRepair, undefined);
});

Given('首检已在一次技术补试后返回内容错误并触发了作者修订', async function (this: SpecWorld) {
  const f = setup(this, 'check', { retries: 5, checks: 5 });
  f.replies = [badModelOutput('criteriaResults缺失'), { type: 'check',
    criteriaResults: candidateJudgments(f.h.context().candidate, { index: 0, status: 'failed', reason: '计划尚未完成' }) }];
  assert(await f.run());
  assert(await f.run());
  const owner = f.h.claim('owner');
  assert(f.h.event({ type: 'DELIVER', text: '明确说明计划尚未完成', artifactIds: [], workId: owner.id, fence: owner }).ok);
});
When('复核请求再次遇到协议错误或瞬态故障', async function (this: SpecWorld) {
  const f = state(this).fixture;
  f.fallback = badModelOutput('criteriaResults为null');
  assert(await f.run());
});
Then('该周期合计只授权三次检查模型请求', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.requests.length, 3);
  assert.equal(f.h.context().usage.checks, 3);
  assert.equal(f.h.context().usage.retries, 1);
});
Then('应以已有成果和未核实范围明确结束', function (this: SpecWorld) {
  const { h } = state(this).fixture;
  assert.equal(h.view().phase, 'ended');
  assert.equal(h.context().outcome, 'partial');
  assert.equal(h.context().candidate?.text, '明确说明计划尚未完成');
  assert(h.context().candidate?.deliveryIssue);
});
