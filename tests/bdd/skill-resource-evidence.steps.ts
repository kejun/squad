import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { skillResourceModel } from '../skill-resource-evidence-fixture.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, ReturnType<typeof skillResourceModel>>();
Given('成员已实际读取当前目标的完整技能资料并保存回执', function (this: SpecWorld) {
  runs.set(this, skillResourceModel());
});
When('负责人提交基于该资料的交付', function (this: SpecWorld) {
  assert.equal(runs.get(this)!.model.snapshot.value, 'checking');
});
Then('独立检查应收到原始资料及可核验的读取来源', function (this: SpecWorld) {
  const sources = runs.get(this)!.evidence.sources;
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.stdout, '{"total":62500}');
  assert.equal(sources[0]!.metadata.resourceId, 'local:source:references/orders.json');
  assert.equal(sources[0]!.metadata.completeness, 'complete');
});
Then('不完整或失效的读取不得冒充完整资料', function () {
  assert.equal(skillResourceModel('paged').evidence.sources[0]!.stdout, undefined);
  assert.equal(skillResourceModel('failed').evidence.sources[0]!.stdout, undefined);
});
