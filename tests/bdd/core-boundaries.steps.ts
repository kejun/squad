import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { coreBoundaryCases } from '../core-boundary-cases.js';
import type { SpecWorld } from './steps.js';
interface Run { driver: ReturnType<(typeof coreBoundaryCases)[number]['prepare']>; outcome: string; acted: boolean }
const runs = new WeakMap<SpecWorld, Run>();
Given('核心任务处于{string}并准备处理{string}', function (this: SpecWorld, pre: string, event: string) {
  const selected = coreBoundaryCases.find(row => row.pre === pre && row.event === event);
  assert(selected, `未绑定的核心行为：${pre} / ${event}`);
  runs.set(this, { driver: selected.prepare(), outcome: selected.outcome, acted: false });
});
When('处理这次核心任务事件', function (this: SpecWorld) { const run = runs.get(this)!; run.driver.act(); run.acted = true; });
Then('该次事件应满足{string}', function (this: SpecWorld, outcome: string) {
  const run = runs.get(this)!; assert(run.acted); assert.equal(run.outcome, outcome); run.driver.verify();
});
