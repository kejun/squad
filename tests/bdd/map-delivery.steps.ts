import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { completedMapModel, mapDeliveryModelGate, oldMapDeliveryModelGate } from '../map-delivery-model-fixture.js';
import { MapReduceFixture } from '../map-reduce-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';
import type { CheckMaterials } from '../../src/delivery-acceptance.js';
import type { SpecWorld } from './steps.js';

const runs = new WeakMap<SpecWorld, { fixture?: MapReduceFixture; materials?: CheckMaterials; instructions?: string; old?: boolean }>();
Given('当前目标的独立分片已由不同成员完成并归并交接', function (this: SpecWorld) {
  assert.equal(completedMapModel().context.discussion?.status, 'delivered');
  runs.set(this, {});
});
When('负责人提交交付并恢复已保存的检查工作', async function (this: SpecWorld) {
  mapDeliveryModelGate();
  const run = runs.get(this)!, f = new MapReduceFixture(undefined, true); run.fixture = f;
  await f.recognize(); await f.beginParallel(); f.assertParallel(); await f.finishMaps();
  await f.run();
  const frozen = structuredClone(f.pending('check')[0]!.payload.reviewRecords);
  f.reopen();
  assert.deepEqual(f.pending('check')[0]!.payload.reviewRecords, frozen);
  f.response = request => {
    assert.equal(request.kind, 'check');
    run.materials = request.context as unknown as CheckMaterials; run.instructions = request.messages[0]!.content;
    const source = run.materials.reviewRecords![0]!;
    return modelResponse({ type: 'check', criteriaResults: run.materials.requirements.map(item => ({ criterionId: item.id,
      status: 'passed', source: { id: source.id, quote: 'alpha 原始证据' } })) });
  };
  await f.run();
});
Then('检查应收到冻结的分片身份成员任务答复和附件且可逐字引用', function (this: SpecWorld) {
  const run = runs.get(this)!, records = run.materials!.reviewRecords!;
  assert.equal(records.length, 2);
  assert.partialDeepStrictEqual(JSON.parse(records[0]!.content), { member: 'B', partition: { id: 'alpha' },
    question: '研究甲来源', expected: '甲证据与出处', answer: 'alpha 原始证据，来源 https://example.com/alpha' });
  assert.equal(run.fixture!.context().outcome, 'complete');
});
Then('分片记录仅证明执行过程而不免除内容核验', function (this: SpecWorld) {
  assert(runs.get(this)!.instructions!.includes('Review records prove what was requested and answered, not that the answer is correct'));
});
When('用户切换目标后负责人提交新目标的交付', function (this: SpecWorld) {
  oldMapDeliveryModelGate(); runs.get(this)!.old = true;
});
Then('检查中不得包含旧目标的分片记录', function (this: SpecWorld) { assert.equal(runs.get(this)!.old, true); });
After(function (this: SpecWorld) { runs.get(this)?.fixture?.close(); runs.delete(this); });
