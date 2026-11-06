import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { verifyConfigurationContract, verifyInvalidServiceConfiguration, verifySearchFailureContract, verifyWebBoundaryContract, verifyNonAuthorizingReviewText, verifyHistoricalMessageBudget, type ContractObservation } from '../configuration-protocol-fixture.js';
interface ConfigurationState { rule: string; expected?: string; observation?: ContractObservation; history?: Awaited<ReturnType<typeof verifyHistoricalMessageBudget>>; targets?: ReturnType<typeof verifyNonAuthorizingReviewText> }
const states = new WeakMap<SpecWorld, ConfigurationState>();
function state(world: SpecWorld) { const s = states.get(world); assert(s); return s; }
Given('用户提供需要验证{string}的模型环境配置', function (this: SpecWorld, rule: string) { states.set(this, { rule }); });
When('通过公开配置入口加载本次配置并核对{string}', function (this: SpecWorld, expected: string) { const s = state(this); s.observation = verifyConfigurationContract(s.rule, expected); });
Then('配置结果应为{string}', function (this: SpecWorld, expected: string) { const observation = state(this).observation; assert(observation); observation.verify(expected); });
Given('当前服务配置含有{string}', function (this: SpecWorld, rule: string) { states.set(this, { rule }); });
When('校验该配置以准备工作', function (this: SpecWorld) { const s = state(this); s.observation = verifyInvalidServiceConfiguration(s.rule); });
Then('应明确拒绝该配置', function (this: SpecWorld) { const observation = state(this).observation; assert(observation); observation.verify(); });
Given('技能搜索遇到{string}', function (this: SpecWorld, rule: string) { states.set(this, { rule }); });
When('通过公开发现接口搜索技能并核对{string}', async function (this: SpecWorld, expected: string) { const s = state(this); s.observation = await verifySearchFailureContract(s.rule, expected); });
Then('技能发现结果应为{string}', async function (this: SpecWorld, expected: string) { const observation = state(this).observation; assert(observation); observation.verify(expected); });
Given('网页资料接口遇到{string}', function (this: SpecWorld, rule: string) { states.set(this, { rule }); });
When('通过公开网页资料接口执行请求并核对{string}', async function (this: SpecWorld, expected: string) { const s = state(this); s.observation = await verifyWebBoundaryContract(s.rule, expected); });
Then('网页接口结果应为{string}', async function (this: SpecWorld, expected: string) { const observation = state(this).observation; assert(observation); observation.verify(expected); });

Given('过去任务留有150条各2000字的消息', function (this: SpecWorld) { states.set(this, { rule: 'history' }); });
When('为新任务准备群历史', async function (this: SpecWorld) { state(this).history = await verifyHistoricalMessageBudget(); });
Then('应保留最新一条消息且消息总数不超过100并且正文不超过96000字', function (this: SpecWorld) {
  const observation = state(this).history; assert(observation);
  assert(observation.history.messages.length <= 100); assert.equal(observation.history.messages.at(-1)?.id, 'm149');
  assert(observation.history.messages.reduce((sum, message) => sum + message.text.length, 0) <= 96_000);
});
Then('应标记历史已省略并保留原任务消息', function (this: SpecWorld) {
  const observation = state(this).history; assert(observation); assert.equal(observation.history.truncated, true); assert.deepEqual(observation.originalMessages, observation.before);
});

Given('审查相关文本为{string}且表达方式为{string}', function (this: SpecWorld, text: string, expression: string) {
  states.set(this, { rule: text, expected: expression });
});
When('通过公开文本入口判断审查对象', function (this: SpecWorld) {
  const s = state(this); assert(s.expected); s.targets = verifyNonAuthorizingReviewText(s.rule, s.expected);
});
Then('不应产生任何审查对象', function (this: SpecWorld) { const observation = state(this).targets; assert(observation); assert.equal(observation.targets, undefined); });
