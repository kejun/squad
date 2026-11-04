import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { skillSearchCase } from '../skill-search-fixture.js';
import type { SpecWorld } from './steps.js';

const cases = new WeakMap<SpecWorld, ReturnType<typeof skillSearchCase>>();
const state = (world: SpecWorld) => { const test = cases.get(world); assert(test); return test; };
Given('技能搜索接口返回仓库来源和域名来源的合法结果', function (this: SpecWorld) {
  cases.set(this, skillSearchCase());
});
Given('技能搜索接口的结果包含{string}', function (this: SpecWorld, problem: string) {
  cases.set(this, skillSearchCase(problem));
});
When('已领取的负责人通过模型适配器搜索技能并继续回答', async function (this: SpecWorld) {
  assert(await state(this).run());
});
Then('两类技能应按安装量排序并保留名称来源和 skills.sh 链接', function (this: SpecWorld) {
  const test = state(this);
  const message = test.requests[1]!.messages.at(-1)!;
  assert.equal(message.role, 'user');
  const result = JSON.parse(message.content);
  assert.equal(result.type, 'skillSearchResults');
  assert.deepEqual(result.results.map((skill: { installs: number }) => skill.installs), [71, 14]);
  assert.equal(result.results[0].name, 'alibabacloud-nas-mount-diagnosis');
  assert.equal(result.results[0].source, 'aliyun/alibabacloud-aiops-skills');
  assert.equal(result.results[0].url, 'https://skills.sh/aliyun/alibabacloud-aiops-skills/alibabacloud-nas-mount-diagnosis');
  assert.equal(result.results[1].name, 'gemini-assistant');
  assert.equal(result.results[1].source, 'skills.volces.com');
  assert.equal(result.results[1].url, 'https://skills.sh/skills.volces.com/gemini-assistant');
});
Then('技能结果应作为资料交给后续模型请求且不安装技能', function (this: SpecWorld) {
  const test = state(this);
  assert.equal(test.requests.length, 2); assert.equal(test.searches, 1);
  assert.equal(test.h.view().phase, 'checking');
  assert(!test.h.context().intents.some(work => work.kind === 'tool'));
});
Then('本次搜索和后续模型请求仍分别消耗一次普通额度', function (this: SpecWorld) {
  assert.equal(state(this).h.context().usage.ordinary, 3);
});
Then('应记录技能搜索格式错误并等待用户且不产生候选结果', function (this: SpecWorld) {
  const test = state(this);
  assert.equal(test.h.view().phase, 'waitingHuman'); assert.equal(test.h.context().candidate, null);
  assert(test.h.context().reason.includes('Invalid skill search result'));
});
Then('失败搜索应消耗一次普通额度且不发起后续模型请求', function (this: SpecWorld) {
  const test = state(this);
  assert.equal(test.searches, 1); assert.equal(test.h.context().usage.ordinary, 2); assert.equal(test.requests.length, 1);
});
