import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { fixedCandidate, retryThenRevise, revisedDelivery, legacyCheck } from '../delivery-cycle-fixture.js';
import type { SpecWorld } from './steps.js';
const cases = new WeakMap<SpecWorld, ReturnType<typeof fixedCandidate>>();
Given('一个候选已经进入固定材料检查', function (this: SpecWorld) { cases.set(this, fixedCandidate()); });
When('检查技术失败后重试并由检查员准备自行补救', function (this: SpecWorld) { retryThenRevise(cases.get(this)!); });
Then('技术补试保留原材料且不派发上游修订', function (this: SpecWorld) {
  assert.equal(cases.get(this)!.m.c.deliveryCycle?.stage.kind, 'checking');
});
When('检查员直接交回修正稿和最终结论', function (this: SpecWorld) { revisedDelivery(cases.get(this)!); });
Then('只发布新候选且全部检查和修订收费保持有界', function (this: SpecWorld) {
  const m = cases.get(this)!.m; assert.equal(m.c.publishedDelivery?.revision, m.c.candidate?.revision); assert.equal(m.c.usage.checks, 2);
});
Given('旧快照保存了候选和未完成检查但没有交付阶段', function (this: SpecWorld) { cases.set(this, fixedCandidate()); });
When('恢复交付并收到旧候选版本的检查结果', function (this: SpecWorld) { legacyCheck(cases.get(this)!); });
Then('应保留原检查材料并拒绝错误版本而不发布', function (this: SpecWorld) { assert.equal(cases.get(this)!.m.c.publishedDelivery, undefined); });
