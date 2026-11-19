import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter, WorkRunner } from '../../src/index.js';
import type { ExecutionObservation } from '../../src/measurement.js';
import { LocalFixture } from '../local-tools-fixture.js';
import { candidateJudgments, Harness, saveEvidence } from '../helpers.js';
import { modelResponse, regenerationConfig, type CapturedModelRequest } from '../model-regeneration-fixture.js';
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
