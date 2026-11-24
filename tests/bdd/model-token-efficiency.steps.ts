import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter, WorkRunner } from '../../src/index.js';
import type { ExecutionObservation } from '../../src/measurement.js';
import { LocalFixture } from '../local-tools-fixture.js';
import { candidateJudgments, Harness, saveEvidence } from '../helpers.js';
import { modelResponse, regenerationConfig, type CapturedModelRequest } from '../model-regeneration-fixture.js';
import { MapReduceFixture } from '../map-reduce-fixture.js';
import type { SpecWorld } from './steps.js';

const locals = new WeakMap<SpecWorld, LocalFixture>();
const requests = new WeakMap<SpecWorld, CapturedModelRequest[]>();
const observations = new WeakMap<SpecWorld, ExecutionObservation[]>();
const unrelatedEvidence = '这段旁证与当前验收无关'.repeat(800);
const deliveredText = '需要独立检查的完整交付正文';

After(async function (this: SpecWorld) { await locals.get(this)?.close(); });

Given('宿主技能目录包含带版本与本机来源的技能', async function (this: SpecWorld) {
  locals.set(this, await LocalFixture.create());
});
When('成员发现宿主技能并按候选标识加载技能', async function (this: SpecWorld) {
  const local = locals.get(this)!;
  local.replies.push({ type: 'discoverHost' }, { type: 'loadSkill', skillId: local.skillId }, { type: 'answer', text: '已加载' });
  assert(await local.runner().runOne(local.h.room, local.h.task));
});
Then('模型候选只包含标识名称和用途且宿主固定已加载版本', function (this: SpecWorld) {
  const local = locals.get(this)!;
  const skill = local.runtime.catalog().skills[0]!;
  const receipt = local.requests[1]!.messages.map(message => message.content).find(content => content.includes('"code":"discoverHost"'))!;
  assert.deepEqual(JSON.parse(receipt).data.skills.skills, [{ skillId: skill.skillId, name: skill.name, description: skill.description }]);
  const owner = local.h.context().intents.find(work => work.kind === 'owner')!;
  assert.deepEqual(owner.localSkills, [{ skillId: skill.skillId, skillVersion: skill.skillVersion }]);
});

Given('同一次模型工作需要在工具回执后续办且供应商返回缓存用量', function (this: SpecWorld) {
  this.h = new Harness(regenerationConfig());
  requests.set(this, []);
  observations.set(this, []);
});
When('模型读取回执并继续该工作', async function (this: SpecWorld) {
  const captured = requests.get(this)!;
  const adapter = new OpenAICompatibleAdapter(this.h.config, { clock: () => this.h.now, transport: async (_url, init) => {
    captured.push(JSON.parse(String(init?.body)));
    const response = modelResponse(captured.length === 1 ? { type: 'web_search', query: '缓存样本' } : { type: 'answer', text: '已查找依据' });
    const body = await response.json() as object;
    return Response.json({ ...body, usage: captured.length === 1
      ? { prompt_tokens: 1300, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1024 } }
      : { prompt_tokens: 1600, prompt_cache_hit_tokens: 1024, prompt_cache_miss_tokens: 576 } });
  } });
  const runner = new WorkRunner(this.h.engine, adapter, () => this.h.now, undefined, {
    search: async () => ({ output: {} as never, text: '缓存样本工具回执' }), fetch: async () => assert.fail('unexpected web fetch'),
  }, undefined, (_context, observation) => observations.get(this)!.push(observation));
  assert(await runner.runOne(this.h.room, this.h.task));
});
Then('续办请求应保留稳定指令和任务前缀并记录真实缓存读写计数', function (this: SpecWorld) {
  const [first, second] = requests.get(this)!;
  assert.deepEqual(second!.messages.slice(0, 2), first!.messages.slice(0, 2));
  assert(second!.messages.some(message => message.content.includes('缓存样本工具回执')));
  const usage = observations.get(this)!.flatMap(record => record.phase === 'model.usage' ? [record.usage] : []);
  assert.deepEqual(usage, [{ input: 1300, output: null, total: null, cacheRead: 0, cacheWrite: 1024 },
    { input: 1600, output: null, total: null, cacheRead: 1024 }]);
});

Given('模型先完成一个工具动作再返回一个畸形工具动作', async function (this: SpecWorld) {
  const local = await LocalFixture.create();
  locals.set(this, local);
  local.replies.push({ type: 'discoverHost' }, { type: 'runCli', executable: 'node', args: '--version' },
    { type: 'runCli', executable: 'node', args: ['--version'] }, { type: 'answer', text: '已验证' });
});
When('系统处理畸形动作并收到模型修正版', async function (this: SpecWorld) {
  const local = locals.get(this)!;
  assert(await local.runner().runOne(local.h.room, local.h.task));
});
Then('系统只请求一次局部修正并且每个合法动作只执行一次', function (this: SpecWorld) {
  const local = locals.get(this)!;
  assert.equal(local.requests.length, 4);
  const repair = local.requests[2]!.messages;
  assert.equal(repair.length, 2);
  assert.partialDeepStrictEqual(JSON.parse(repair[1]!.content), { type: 'runCli', code: 'invalid_tool_request', field: 'args', currentFields: { executable: 'node' } });
  assert(!JSON.stringify(repair).includes('local_tool_result'));
  const owner = local.h.context().intents.find(work => work.kind === 'owner')!;
  assert.deepEqual(owner.localOperations?.map(item => [item.action.type, item.status]), [['discoverHost', 'succeeded'], ['runCli', 'succeeded']]);
  assert.equal(local.backend.calls.length, 1);
  assert.equal(local.h.context().usage.retries, 1);
});

Given('负责人两次返回参数列表无效的命令请求', async function (this: SpecWorld) {
  const local = await LocalFixture.create();
  locals.set(this, local);
  local.replies.push({ type: 'runCli', executable: 'node', args: 'private-first-value' },
    { type: 'runCli', executable: 'node', args: 'private-second-value' });
});
When('系统执行这轮模型工作', async function (this: SpecWorld) {
  const local = locals.get(this)!;
  const observed: ExecutionObservation[] = [];
  observations.set(this, observed);
  assert(await local.runner(undefined, (_context, record) => observed.push(record)).runOne(local.h.room, local.h.task));
});
Then('执行记录应标识两次协议错误的字段并保留未执行结果', function (this: SpecWorld) {
  const local = locals.get(this)!;
  const invalid = observations.get(this)!.filter(event => event.phase === 'model.protocol' && !event.valid);
  assert.equal(invalid.length, 2);
  assert.partialDeepStrictEqual(invalid[0], { code: 'invalid_tool_request', invalidFields: ['runCli.args'] });
  assert.partialDeepStrictEqual(invalid[1], { code: 'invalid_tool_request', invalidFields: ['runCli.args'] });
  assert(!JSON.stringify(invalid).includes('private-'));
  const settlement = observations.get(this)!.find(event => event.phase === 'work.result' && event.eventType === 'WORK_FAILED');
  assert.partialDeepStrictEqual(settlement, { code: 'INVALID_TOOL_REQUEST', accepted: false });
  assert.equal(local.backend.calls.length, 0);
  assert.equal(local.requests.length, 2);
  assert.equal(local.h.context().usage.retries, 1);
});

Given('已冻结证据整体超过检查容量而交付正文和判据可容纳', function (this: SpecWorld) {
  const config = regenerationConfig();
  config.models!.services.test!.contextWindowTokens = 16_384;
  config.models!.services.test!.maxTokens = 512;
  this.h = new Harness(config);
  const owner = this.h.claim('owner');
  saveEvidence(this.h, owner, unrelatedEvidence);
  assert(this.h.event({ type: 'DELIVER', workId: owner.id, text: deliveredText, artifactIds: [] }).ok);
  requests.set(this, []);
});
When('独立检查完成只需正文的判定', async function (this: SpecWorld) {
  const adapter = new OpenAICompatibleAdapter(this.h.config, { clock: () => this.h.now, transport: async (_url, init) => {
    requests.get(this)!.push(JSON.parse(String(init?.body)));
    return modelResponse({ type: 'check', criteriaResults: candidateJudgments(this.h.context().candidate) });
  } });
  assert(await new WorkRunner(this.h.engine, adapter, () => this.h.now).runOne(this.h.room, this.h.task));
});
Then('首轮检查应包含完整正文和判据且没有证据正文', function (this: SpecWorld) {
  const request = requests.get(this)![0];
  assert(request, this.h.context().reason);
  const { context } = JSON.parse(request.messages[1]!.content);
  assert.equal(context.candidate.text, deliveredText);
  assert.deepEqual(context.requirements, this.h.context().candidate!.acceptance!.criteria);
  assert.equal(context.sourceIndex.length, 1);
  assert(!JSON.stringify(request).includes(unrelatedEvidence.slice(0, 32)));
});
Then('系统应在一次模型请求中接受该检查', function (this: SpecWorld) {
  assert.equal(requests.get(this)!.length, 1);
  assert.equal(this.h.context().outcome, 'complete');
});

const savedMaterial = '第一次读取已找到的可信资料';
const partialAnswer = '已保存第一次读取的资料，后续查询的结果仍待确认';
const mapRecoveries = new WeakMap<SpecWorld, {
  fixture: MapReduceFixture; requests: CapturedModelRequest[]; searches: string[];
}>();
After(function (this: SpecWorld) { mapRecoveries.get(this)?.fixture.close(); });

async function prepareMapRecovery(world: SpecWorld, ordinary?: number) {
  const fixture = new MapReduceFixture();
  fixture.config.limits.retries = 1;
  if (ordinary !== undefined) fixture.config.limits.ordinary = ordinary;
  mapRecoveries.set(world, { fixture, requests: [], searches: [] });
  await fixture.recognize();
  assert.equal(fixture.pending('assistance').length, 2);
}

async function recoverMap(world: SpecWorld, badRepair: string, final: unknown) {
  const { fixture, requests, searches } = mapRecoveries.get(world)!;
  const first = fixture.pending('assistance')[0]!;
  const repairs = {
    无法修正: { type: 'unrepairable' },
    参数仍无效: { type: 'web_search', query: '补充资料', limit: '依然无效' },
    改变原目标: { type: 'web_search', query: '未经批准的新查询', limit: 2 },
  };
  const repair = repairs[badRepair as keyof typeof repairs];
  assert(repair);
  const replies = [
    { type: 'web_search', query: '初次资料' },
    { type: 'web_search', query: '补充资料', limit: '无效' },
    repair,
    final,
  ];
  const adapter = new OpenAICompatibleAdapter(fixture.config, { clock: () => fixture.now, transport: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    assert(replies.length, '一次局部修正和一次最终答复后应结算');
    return modelResponse(replies.shift());
  } });
  const runner = new WorkRunner(fixture.engine, adapter, () => fixture.now, undefined, {
    search: async ({ query }) => { searches.push(query); return { output: {} as never, text: savedMaterial }; },
    fetch: async () => assert.fail('分片续办无需额外读取'),
  });
  assert(await runner.runOne(fixture.room, fixture.task, first.id));
}

Given('独立分片已取得一份工具资料并发出了畸形工具动作', async function (this: SpecWorld) {
  await prepareMapRecovery(this);
});
When('局部修正返回{string}且原分片提交已有成果', async function (this: SpecWorld, badRepair: string) {
  await recoverMap(this, badRepair, { type: 'answer', text: partialAnswer, status: 'partial',
    artifacts: [{ name: '分片资料.md', content: savedMaterial }] });
});

Then('坏动作应保持未执行并只请求一次最终答复', function (this: SpecWorld) {
  const { fixture, requests, searches } = mapRecoveries.get(this)!;
  const result = fixture.context().discussion?.results.find(item => item.partitionId === 'alpha');
  assert.deepEqual(searches, ['初次资料']);
  assert.equal(requests.length, 4, result?.reason);
  assert.equal(requests[2]!.messages.length, 2);
  assert(!JSON.stringify(requests[2]!).includes(savedMaterial));
  assert(JSON.stringify(requests[3]!).includes(savedMaterial));
  assert(JSON.stringify(requests[3]!).includes('INVALID_TOOL_REQUEST'));
  assert.equal(fixture.context().usage.retries, 1);
});

Then('分片的部分成果和缺口应保存并交回主笔', async function (this: SpecWorld) {
  const { fixture } = mapRecoveries.get(this)!;
  const result = fixture.context().discussion?.results.find(item => item.partitionId === 'alpha');
  assert.equal(result?.status, 'partial');
  assert.equal(result.answer, partialAnswer);
  assert.equal(result.artifactIds.length, 1);
  assert.equal(fixture.context().artifacts.find(item => item.id === result.artifactIds[0])?.content, savedMaterial);
  assert(await fixture.run());
  assert(await fixture.run());
  const owner = fixture.pending('owner')[0]!;
  assert(owner);
  assert(JSON.stringify(owner.payload.discussion).includes(partialAnswer));
  assert(JSON.stringify(owner.payload.discussion).includes(result.artifactIds[0]!));
});

When('分片的最终答复仍然要求调用工具', async function (this: SpecWorld) {
  await recoverMap(this, '无法修正', { type: 'web_search', query: '不得再次执行' });
});
Then('系统应结算该分片并保留明确缺口且不调用工具', function (this: SpecWorld) {
  const { fixture, requests, searches } = mapRecoveries.get(this)!;
  const result = fixture.context().discussion?.results.find(item => item.partitionId === 'alpha');
  assert.equal(requests.length, 4);
  assert.deepEqual(searches, ['初次资料']);
  assert.equal(result?.status, 'failed');
  assert.match(result.reason!, /INVALID_TOOL_REQUEST.*未能提交有效答复/);
  assert.deepEqual(result.artifactIds, []);
});

Given('分片在仅余已预留普通额度时工具修正失败', async function (this: SpecWorld) {
  await prepareMapRecovery(this, 8);
});
When('分片尝试请求最终答复', async function (this: SpecWorld) {
  await recoverMap(this, '无法修正', { type: 'answer', text: '额外调用不应发生' });
});
Then('应保留已预留额度，不向供应商发出最终请求', function (this: SpecWorld) {
  const { fixture, requests, searches } = mapRecoveries.get(this)!;
  const result = fixture.context().discussion?.results.find(item => item.partitionId === 'alpha');
  assert.equal(requests.length, 3);
  assert.deepEqual(searches, ['初次资料']);
  assert.equal(result?.status, 'failed');
  assert.match(result.reason!, /DISCUSSION_BUDGET_RESERVED/);
  assert.equal(fixture.pending('assistance').length, 1);
});
