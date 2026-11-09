import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { authorityCompositionSequence, type AuthorityCompositionCase } from '../authority-composition-fixture.js';
import type { SpecWorld } from './steps.js';
const states = new WeakMap<SpecWorld, { scenario: AuthorityCompositionCase; report?: ReturnType<typeof authorityCompositionSequence> }>();
Given('宿主授权组合经历{string}', function (this: SpecWorld, scenario: AuthorityCompositionCase) { states.set(this, { scenario }); });
When('旧审批决定和旧成功命令回执交错到达', function (this: SpecWorld) { const state = states.get(this)!; state.report = authorityCompositionSequence(state.scenario); });
Then('旧成功命令可以返回原成功但不得改变当前授权或启动效果', function (this: SpecWorld) {
  const report = states.get(this)!.report!; assert.equal(report.length, 2); assert(report.every(item => item.status === 'passed' && item.actions.includes('ReplayDecision')));
});
Then('旧父轮次领取和旧执行许可不得影响当前工作', function (this: SpecWorld) {
  const report = states.get(this)!.report!; assert.equal(report.length, 2); assert(report.every(item => item.actions.includes('LateClaim') && item.actions.includes('OldPermit')));
});
Then('当前新批准的命令仍可正常开始一次', function (this: SpecWorld) {
  const report = states.get(this)!.report!; assert(report.every(item => item.final.starts === 1 && item.final.stage === 3));
});
