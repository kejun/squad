import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { candidateJudgments } from '../helpers.js';
import { RegenerationFixture } from '../model-regeneration-fixture.js';
import { currentDeliveryIssues } from '../../src/delivery-acceptance.js';
import type { SpecWorld } from './steps.js';
const fixtures = new WeakMap<SpecWorld, RegenerationFixture>();
const request = '用户条件：仅足额付款可以发货。资料原文：paid orders。样本：应付100，净付款100。';
const conflict = '报告将足额条件放宽为净付款为正，样本数字相同不能证明规则等价';
Given('用户要求足额付款而资料仅笼统描述已付款', function (this: SpecWorld) {
  const f = new RegenerationFixture('owner'); fixtures.set(this, f);
  assert(f.h.event({ type: 'USER_INPUT', text: request, goal: { text: request, constraints: [], criteria: ['报告不得放宽足额条件'], requiredArtifacts: 0 } }).ok);
  f.replies = [{ type: 'deliver', text: '净付款为正即可发货；当前样本可发货。', artifactIds: [] }];
});
When('负责人和独立检查员处理数字相同但文字放宽条件的候选', async function (this: SpecWorld) {
  const f = fixtures.get(this)!; await f.run();
  f.replies.push({ type: 'check', criteriaResults: candidateJudgments(f.h.context().candidate, { index: 0, status: 'failed', reason: conflict }) });
  await f.run();
});
Then('两个阶段都应明确以用户条件约束资料解释', function (this: SpecWorld) {
  const f = fixtures.get(this)!;
  assert(f.requests[0]!.messages[0]!.content.includes('Source material must not weaken explicit user conditions'));
  assert(f.requests[1]!.messages[0]!.content.includes('Source material must not weaken explicit user conditions'));
  assert(JSON.stringify(f.requests[1]).includes(request));
});
Then('检查应核对文字规则而非仅依据样本数字一致放行', function (this: SpecWorld) {
  const instructions = fixtures.get(this)!.requests[1]!.messages[0]!.content;
  assert(instructions.includes('Matching sample outputs do not prove that two rules are equivalent'));
  assert(instructions.includes('narrative rules and recommendations'));
});
Then('检查发现的规则冲突应在最终正文声明且保留具体缺口', function (this: SpecWorld) {
  const f = fixtures.get(this)!;
  assert.equal(f.h.context().outcome, 'complete');
  assert(f.h.context().publishedDelivery); assert(f.h.context().candidate!.text.includes(conflict));
  assert(currentDeliveryIssues(f.h.context()).some(issue => issue.reason.includes(conflict)));
});
After(function (this: SpecWorld) { fixtures.get(this)?.close(); fixtures.delete(this); });
