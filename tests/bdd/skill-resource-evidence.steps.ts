import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { skillResourceModel } from '../skill-resource-evidence-fixture.js';
import { checkModelInput, readCheckSource } from '../../src/check-model-input.js';
import { deliveryCheckMaterials } from '../../src/delivery-check-delta.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, ReturnType<typeof skillResourceModel>>();
Given('成员已实际读取当前目标的完整技能资料并保存回执', function (this: SpecWorld) {
  runs.set(this, skillResourceModel());
});
When('负责人提交基于该资料的交付', function (this: SpecWorld) {
  assert.equal(runs.get(this)!.model.snapshot.value, 'checking');
});
Then('独立检查首轮应获得来源引用并可按需读取原始资料', function (this: SpecWorld) {
  const { model, evidence } = runs.get(this)!;
  const sources = evidence.sources;
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.stdout, '{"total":62500}');
  assert.equal(sources[0]!.metadata.resourceId, 'local:source:references/orders.json');
  assert.equal(sources[0]!.metadata.completeness, 'complete');
  const work = model.c.intents.find(item => item.kind === 'check')!;
  const materials = deliveryCheckMaterials(model.c, work)!;
  assert.equal(checkModelInput(materials).sourceIndex[0]?.id, sources[0]!.id);
  assert(!JSON.stringify(checkModelInput(materials)).includes('62500'));
  assert.equal(readCheckSource(materials, { sourceId: sources[0]!.id }).data.text, '{"total":62500}');
});
Then('不完整或失效的读取不得冒充完整资料', function () {
  assert.equal(skillResourceModel('paged').evidence.sources[0]!.stdout, undefined);
  assert.equal(skillResourceModel('failed').evidence.sources[0]!.stdout, undefined);
});
