import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { MapCapacityFixture, prepareCapacitySnapshot, verifyCapacityDispatchFallback, verifyLegacyCapacityDispatch } from '../map-capacity-fixture.js';

interface CapacityState { fixture?: MapCapacityFixture; variant?: string; verified?: boolean }
const states = new WeakMap<SpecWorld, CapacityState>();
function state(world: SpecWorld) { let current = states.get(world); if (!current) { current = {}; states.set(world, current); } return current; }
function fixture(world: SpecWorld) { const value = state(world).fixture; assert(value); return value; }
After(async function (this: SpecWorld) {
  const value = states.get(this)?.fixture;
  if (value) { value.releaseMaps(); await value.parallel; value.close(); }
  states.delete(this);
});

Given('用户要求汇总八份独立文档且有四名可用非负责人成员', function (this: SpecWorld) { state(this).fixture = new MapCapacityFixture(); });
When('输入理解按已扣本次请求额度的容量规划分片', async function (this: SpecWorld) { await fixture(this).recognize(); });
Then('理解请求应看到最大分片数四且首次计划在二至四片内覆盖八份文档各一次', function (this: SpecWorld) {
  const value = fixture(this); value.assertPlan();
  assert.equal(value.requests.filter(request => request.kind === 'interpretation').length, 1);
});
When('所有分片结算并归并后交回负责人', async function (this: SpecWorld) { await fixture(this).beginParallel(); await fixture(this).finish(); });
Then('应只归并一次并保留八份文档的原始要求与来源', function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.context().outcome, 'complete');
  assert.equal(value.requests.filter(request => request.kind === 'discussionSummary').length, 1);
  assert.equal(value.documentReads.length, 8);
});

Given('分片容量受到{string}约束', function (this: SpecWorld, limit: string) { state(this).fixture = prepareCapacitySnapshot(limit); });
When('为本次输入理解准备已计费的容量快照', async function (this: SpecWorld) { assert.equal(await fixture(this).run(), true); });
Then('最大分片数应为{int}且不改变调度权限', function (this: SpecWorld, expected: number) { fixture(this).assertCapacity(expected); });

Given('本次理解的最大分片数为{int}', function (this: SpecWorld, expected: number) {
  assert(expected === 0 || expected === 1); state(this).fixture = new MapCapacityFixture(expected);
});
When('模型省略并行分解并返回完整目标引用和验收要求', async function (this: SpecWorld) { await fixture(this).recognize(); });
Then('负责人应取得全部八份文档且不派发分片', function (this: SpecWorld) { fixture(this).assertOwnerFallback(); });

Given('本次理解固定最大分片数为四', function (this: SpecWorld) { const value = new MapCapacityFixture(); value.firstOverCapacity = true; state(this).fixture = value; });
When('模型首次返回八个分片并在有界修复后返回四个完整分组', async function (this: SpecWorld) {
  const value = fixture(this); await value.recognize(); value.assertPlan(); await value.beginParallel(); await value.finish();
});
Then('八片计划应未被应用且四片计划完整执行', function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.context().discussion?.mapReduce?.partitions.length, 4);
  assert.equal(value.context().outcome, 'complete');
});
Then('修复仍消耗现有额度且模型不能修改容量字段', async function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.requests.filter(request => request.kind === 'interpretation').length, 2);
  assert.equal(value.context().usage.retries, 1); assert.deepEqual(value.beforeProviderOrdinary, [1, 2]);
  assert.equal(value.work.payload.maxPartitions, 4);
  const attemptedOverride = new MapCapacityFixture();
  try {
    attemptedOverride.firstCapacityOverride = true; await attemptedOverride.recognize(); attemptedOverride.assertPlan();
    assert.equal(attemptedOverride.context().usage.retries, 1);
    assert(!Object.hasOwn(attemptedOverride.context().inputAnalyses![0]!.spec!, 'maxPartitions'));
  } finally { attemptedOverride.close(); }
});

Given('理解时四片计划合法但派发前发生{string}', function (this: SpecWorld, change: string) { state(this).variant = change; });
When('状态机重新核对当前分片容量', function (this: SpecWorld) { verifyCapacityDispatchFallback(state(this).variant!); state(this).verified = true; });
Then('应说明回退原因且将全部分片和归并要求交给原负责人', function (this: SpecWorld) { assert(state(this).verified); });
Then('不应部分派发丢弃文档或重复扣费', function (this: SpecWorld) { assert(state(this).verified); });

Given('旧快照保留合法分片计划但没有容量字段', function (this: SpecWorld) { state(this); });
When('恢复后在当前资源边界派发', async function (this: SpecWorld) { await verifyLegacyCapacityDispatch(); await verifyLegacyCapacityDispatch(true); state(this).verified = true; });
Then('应完整派发或带原因完整回退且不重复安排已完成分片', function (this: SpecWorld) { assert(state(this).verified); });
