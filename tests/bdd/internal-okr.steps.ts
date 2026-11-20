import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { acceptanceCriteria, type AcceptanceCriterion } from '../../src/delivery-acceptance.js';
import type { InputAnalysis, InputIntentSpec } from '../../src/types.js';
import { InputIntentFixture, intentConfig, parsedIntent } from '../input-intent-fixture.js';
import { websiteIntent, websiteObjective, websiteTask } from '../internal-okr-model-fixture.js';
import type { SpecWorld } from './steps.js';

const fixtures = new WeakMap<SpecWorld, InputIntentFixture>();
function fixture(world: SpecWorld) { const f = fixtures.get(world); assert(f); return f; }
function open(world: SpecWorld, sqlite = false) {
  const f = new InputIntentFixture({ ...intentConfig(), inputAnalysis: { enabled: true } }, sqlite);
  fixtures.set(world, f);
  return f;
}
After(function (this: SpecWorld) { fixtures.get(this)?.close(); });

const websiteRequirements = [websiteObjective, 'Answer the user request'];
const mapTask = '分别核对甲乙两组独立资料；必须保留出处；最后汇总两组发现';
const mapIntent = parsedIntent('request', {
  objective: mapTask, constraints: ['保留出处'], expectedOutputs: ['两组发现汇总'], acceptanceCriteria: [],
  okr: { keyResults: [{ text: '汇总中的发现可追溯到对应资料', status: 'pending' }] },
  decomposition: { kind: 'mapReduce', synthesis: '按出处合并两组发现', partitions: [
    { id: 'alpha', objective: '核对甲组资料', expectedOutput: '甲组发现和出处' },
    { id: 'beta', objective: '核对乙组资料', expectedOutput: '乙组发现和出处' },
  ] },
});

async function interpret(f: InputIntentFixture, spec: unknown) {
  assert.equal(f.view().phase, 'interpreting');
  f.replies.push({ type: 'interpretation', spec });
  assert(await f.run());
}

Given('已开启模型意图识别且用户仅发送个人网站任务', function (this: SpecWorld) {
  assert(open(this).submit(websiteTask).ok);
});
When('意图模型生成任务目标和指导性关键结果', async function (this: SpecWorld) {
  await interpret(fixture(this), websiteIntent);
});
Then('应在一次解析后把目标和关键结果交给原主笔', async function (this: SpecWorld) {
  const f = fixture(this);
  assert.equal(f.requests.length, 1);
  const prompt = f.requests[0]!.messages[0]!.content;
  assert.match(prompt, /generate 1–3 task-specific, observable okr\.keyResults/);
  assert.match(prompt, /For one small deliverable .*omit decomposition/);
  assert.equal(f.context().usage.ordinary, 1);
  assert.deepEqual(f.context().inputAnalyses?.[0]?.spec, websiteIntent);
  const [pending, ...others] = f.engine.pending(f.room, f.task);
  assert.equal(pending?.kind, 'owner'); assert.equal(pending.target, f.context().owner); assert.equal(others.length, 0);
  f.replies.push({ type: 'deliver', text: '个人网站已创建', artifactIds: [] });
  assert(await f.run());
  const request = f.requests.at(-1)!;
  assert.deepEqual((request.context.inputIntents as InputAnalysis[])[0]?.spec, websiteIntent);
  assert.match(request.messages[0]!.content, /as optional planning guidance/);
});
Then('应按原交付判据完成核检', async function (this: SpecWorld) {
  const f = fixture(this);
  assert(await f.run());
  const request = f.requests.at(-1)!;
  assert.equal(request.kind, 'check');
  assert.deepEqual((request.context.requirements as AcceptanceCriterion[]).map(criterion => criterion.text), websiteRequirements);
  assert(!JSON.stringify(request.context).includes(websiteIntent.okr!.keyResults[0]!.text));
  assert.equal(f.context().outcome, 'complete');
});

Given('用户发送可并行核对两组资料的任务', function (this: SpecWorld) {
  const f = open(this);
  f.config.bots.push({ id: 'C', name: '资料员', instructions: '', tools: [] });
  assert(f.submit(mapTask).ok);
});
When('意图模型生成指导性关键结果和独立分片计划', async function (this: SpecWorld) {
  await interpret(fixture(this), mapIntent);
});
Then('应沿用分片队列把对应工作和关键结果交给现有成员', function (this: SpecWorld) {
  const f = fixture(this);
  assert.equal(f.requests.length, 1);
  const pending = f.engine.pending(f.room, f.task);
  assert.deepEqual(pending.map(work => work.kind), ['assistance', 'assistance']);
  assert.deepEqual(pending.map(work => work.payload.partition), mapIntent.decomposition!.partitions);
  assert.equal(new Set(pending.map(work => work.target)).size, 2);
  for (const work of pending) {
    assert.notEqual(work.target, f.context().owner);
    assert.deepEqual((work.payload.inputIntents as InputAnalysis[])[0]?.spec?.okr, mapIntent.okr);
  }
});

Given('已解析个人网站任务并记录关键结果', async function (this: SpecWorld) {
  const f = open(this, true);
  assert(f.submit(websiteTask).ok);
  await interpret(f, websiteIntent);
  f.reopen();
});
When('用户发送「KR1 已达成」且意图模型解释这条补充', async function (this: SpecWorld) {
  const f = fixture(this);
  assert(f.submit('KR1 已达成', { id: 'okr-supplement' }).ok);
  await interpret(f, { ...websiteIntent, action: 'supplement',
    okr: { keyResults: [{ ...websiteIntent.okr!.keyResults[0]!, status: 'achieved' }] } } satisfies InputIntentSpec);
});
Then('后续主笔应收到当前目标的已达成标记', function (this: SpecWorld) {
  const f = fixture(this);
  const prior = f.requests.at(-1)!;
  assert.deepEqual((prior.context.inputIntents as InputAnalysis[])[0]?.spec, websiteIntent);
  assert.match(prior.messages[0]!.content, /KR1 refers to the first key result/);
  const [owner] = f.engine.pending(f.room, f.task);
  assert.equal(owner?.kind, 'owner');
  const current = (owner.payload.inputIntents as InputAnalysis[]).at(-1)!;
  assert.equal(current.goalVersion, f.context().goalVersion);
  assert.deepEqual(current.spec?.okr?.keyResults, [{ ...websiteIntent.okr!.keyResults[0]!, status: 'achieved' }]);
});
Then('交付判据应保留原有内容', function (this: SpecWorld) {
  assert.deepEqual(acceptanceCriteria(fixture(this).context()).map(item => item.text), websiteRequirements);
});

When('意图模型返回合法目标和格式无效的关键结果', async function (this: SpecWorld) {
  await interpret(fixture(this), { ...websiteIntent, okr: { keyResults: [{ text: '访客能打开作品详情', status: 'done' }] } });
});
Then('应丢弃无效的关键结果并在一次解析后安排主笔', function (this: SpecWorld) {
  const f = fixture(this);
  assert.equal(f.requests.length, 1);
  assert.equal(f.context().usage.retries, 0);
  assert.equal(f.context().inputAnalyses?.[0]?.spec?.objective, websiteObjective);
  assert.equal(f.context().inputAnalyses?.[0]?.spec?.okr, undefined);
  assert.deepEqual(f.engine.pending(f.room, f.task).map(work => work.kind), ['owner']);
});

Given('用户要求沿用当前任务材料且没有提供其他产物', function (this: SpecWorld) {
  const config = intentConfig({ retries: 0 });
  const f = new InputIntentFixture(config);
  fixtures.set(this, f);
  assert(f.submit('请沿用当前材料，交付个人网站草稿').ok);
});
When('意图模型返回有效关键结果并引用不存在的产物', async function (this: SpecWorld) {
  const f = fixture(this);
  await interpret(f, { ...websiteIntent, references: [{ kind: 'artifact', id: 'invented-reference', taskId: f.task }] });
});
Then('应拒绝错误解析并按原流程请求人工处理', function (this: SpecWorld) {
  const f = fixture(this);
  assert.equal(f.requests.length, 1);
  assert.equal(f.view().phase, 'waitingHuman');
  assert.equal(f.context().inputAnalyses?.[0]?.status, 'failed');
  assert.equal(f.context().inputAnalyses?.[0]?.spec, undefined);
  assert(!f.engine.pending(f.room, f.task).some(work => work.kind === 'owner' || work.kind === 'assistance'));
});
