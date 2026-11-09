import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { SpecWorld } from './steps.js';
import { toolKnowledgeModelGate } from '../shared-tool-knowledge-model-fixture.js';
import { sharedToolKnowledgeAcceptance } from '../shared-tool-knowledge-acceptance.js';

const boundaries = new WeakMap<SpecWorld, string>();
const observations = new WeakMap<SpecWorld, Awaited<ReturnType<typeof sharedToolKnowledgeAcceptance>>>();
const results = new WeakMap<SpecWorld, ReturnType<typeof toolKnowledgeModelGate>>();
Given('同任务成员已通过真实命令取得一份来源资料', function () { toolKnowledgeModelGate(); });
When('另一成员开始处理同来源的独立资料', async function (this: SpecWorld) { observations.set(this, await sharedToolKnowledgeAcceptance()); });
Then('应收到原调用参数和成功回执标识并仅执行自己的读取', function (this: SpecWorld) {
  const observation = observations.get(this)!;
  assert.equal(observation.methods[0]!.sourceOperationId, observation.original.id);
  assert.equal(observation.executions, 2);
});
Then('经验不得包含原资料正文或替代自己的执行回执', function (this: SpecWorld) {
  const observation = observations.get(this)!;
  assert(!observation.knowledge.includes('stdout'));
  assert.notEqual(observation.operation.id, observation.original.id);
});
Given('已保存调用受到{string}约束', function (this: SpecWorld, boundary: string) { boundaries.set(this, boundary); });
When('为当前成员投影可复用调用经验', function (this: SpecWorld) { results.set(this, toolKnowledgeModelGate(boundaries.get(this)!)); });
Then('该调用不得作为可复用成功经验提供', function (this: SpecWorld) { assert.deepEqual(results.get(this), []); });
