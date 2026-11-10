import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import type { Intent } from '../../src/types.js';
import { checkReviewSources } from '../../src/delivery-acceptance.js';
import { MapCapacityFixture, groupedIntent, updateMapContext } from '../map-capacity-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';

class QueueFixture extends MapCapacityFixture {
  old?: Intent;
  constructor() {
    super(undefined, true);
    this.config.limits.retries = 4;
    this.response = request => request.kind === 'interpretation'
      ? modelResponse({ type: 'interpretation', spec: groupedIntent(8) }) : this.reply(request);
  }
  get queue() { return this.context().discussion!.mapReduce!.queue!; }
  claimMap() { const work = this.engine.claim(this.room, this.task, this.pending('assistance')[0]!.id); assert(work); return work; }
  fail(work: Intent, unknown = false) {
    assert(this.event({ type: 'WORK_FAILED', intentId: work.id, transient: true, resultUncertain: unknown, reason: 'transport failure' }).ok);
  }
  async drainMaps() { while (this.pending('assistance').length) assert(await this.run()); }
}
const states = new WeakMap<SpecWorld, QueueFixture>();
const fixture = (world: SpecWorld) => { const value = states.get(world); assert(value); return value; };
async function prepare(world: SpecWorld) {
  const value = new QueueFixture(); states.set(world, value); await value.recognize();
  assert.equal(value.queue.length, 8); assert.equal(value.pending('assistance').length, 4); return value;
}
After(async function (this: SpecWorld) {
  const value = states.get(this); if (value) { value.releaseMaps(); await value.parallel; value.close(); states.delete(this); }
});

Given('八个独立分片有足够额度且只有四名可用成员', async function (this: SpecWorld) { await prepare(this); });
When('空闲成员依次领取并完成这些分片', async function (this: SpecWorld) {
  const value = fixture(this); await value.beginParallel();
  assert.equal(value.queue.filter(part => part.status === 'queued').length, 4);
  value.releaseMaps(); await value.parallel; value.reopen(); value.reopen();
  assert.equal(value.queue.filter(part => part.status === 'succeeded').length, 4);
  assert.equal(value.pending('assistance').length, 4); assert.equal(value.pending('discussionSummary').length, 0);
  await value.beginParallel(); await value.finish();
});
Then('八片均应保留且同时占用成员不超过四名', function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.queue.length, 8); assert(value.queue.every(part => part.status === 'succeeded' && part.attempt === 1));
  assert.equal(new Set(value.context().discussion!.mapReduce!.assignments.map(item => item.target)).size, 4);
  assert.equal(value.requests[0]!.context.maxConcurrentPartitions, 4);
});
Then('每片结果应按分片身份关联且只归并一次', function (this: SpecWorld) {
  const value = fixture(this), sources = checkReviewSources(value.context());
  assert.equal(sources.length, 8); assert.equal(new Set(sources.map(item => item.id)).size, 8);
  assert.deepEqual(sources.map(item => JSON.parse(item.content).partition.id).sort(), value.queue.map(part => part.partitionId).sort());
  assert.equal(value.requests.filter(request => request.kind === 'discussionSummary').length, 1);
  assert.equal(value.context().outcome, 'complete');
});

Given('独立分片队列中一个分片成功而另一个瞬时失败', async function (this: SpecWorld) {
  const value = await prepare(this); assert(await value.run()); value.old = value.claimMap(); value.fail(value.old);
});
When('现有重试额度允许该失败分片重试一次', function (this: SpecWorld) {
  const value = fixture(this), retry = value.pending('assistance').find(work => work.payload.partitionAttempt === 2); assert(retry);
  const work = value.engine.claim(value.room, value.task, retry.id); assert(work); value.fail(work);
});
Then('成功分片不得重跑且旧尝试的迟到结果应被拒绝', function (this: SpecWorld) {
  const value = fixture(this), work = value.old!;
  assert.equal(value.event({ type: 'DISCUSSION_RESULT', workId: work.id, attempt: work.attempt, fence: work, discussionId: work.discussionId!, status: 'success', text: 'late' }).ok, false);
  assert.equal(value.queue[0]!.attempt, 1); assert.equal(value.queue[0]!.status, 'succeeded');
});
Then('再次失败应立即标记不完整并保留失败结果且结束自动重试', async function (this: SpecWorld) {
  const value = fixture(this); assert(value.context().discussion!.incomplete?.includes('未完整完成')); await value.drainMaps(); value.reopen();
  assert.equal(value.context().usage.retries, 1); assert.equal(value.queue.filter(part => part.status === 'failed').length, 1);
  assert.equal(value.context().discussion!.results.filter(result => result.status === 'failed').length, 2);
  assert(value.context().discussion!.incomplete?.includes('failed'));
});

Given('分片队列已有已完成在途和未派发的分片', async function (this: SpecWorld) {
  const value = await prepare(this); assert(await value.run()); value.old = value.claimMap();
});
When('服务重启恢复队列后用户停止任务', function (this: SpecWorld) {
  const value = fixture(this); value.reopen(); assert(value.event({ type: 'STOP' }).ok); value.reopen();
});
Then('已完成分片不得重跑且未派发分片不再启动', function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.queue[0]!.status, 'succeeded'); assert.equal(value.queue[0]!.attempt, 1);
  assert(value.queue.slice(5).every(part => part.status === 'cancelled' && part.attempt === 0));
  assert.equal(value.pending('assistance').length, 0); assert.equal(value.pending('discussionSummary').length, 0);
});

Given('分片队列的一个执行结果仍需可信核对', async function (this: SpecWorld) {
  const value = await prepare(this); value.old = value.claimMap(); value.fail(value.old, true);
});
When('其他分片全部完成并重复恢复任务', async function (this: SpecWorld) {
  const value = fixture(this); await value.drainMaps(); value.reopen(); value.reopen();
});
Then('不得重复启动未知分片或提前归并', function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.queue[0]!.status, 'uncertain'); assert.equal(value.queue[0]!.attempt, 1);
  assert.equal(value.queue.filter(part => part.status === 'succeeded').length, 7);
  assert.equal(value.pending('assistance').length, 0); assert.equal(value.pending('discussionSummary').length, 0); assert.equal(value.context().usage.retries, 0);
});

Given('分片队列开始后剩余额度不足以派发全部待办', async function (this: SpecWorld) {
  const value = await prepare(this); updateMapContext(value, c => { c.usage.ordinary = c.config.limits.ordinary - 5; });
});
When('状态机核对下一批分片的额度', function (this: SpecWorld) { fixture(this).reopen(); });
Then('应保留明确未执行状态且不得把部分结果发布为完整交付', function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.queue.filter(part => part.status === 'cancelled' && part.reason === 'MAP_BUDGET_EXHAUSTED').length, 4);
  assert.notEqual(value.context().outcome, 'complete'); assert.equal(value.pending('discussionSummary').length, 0);
});

Given('分片队列仍有未派发分片且已到截止时间', async function (this: SpecWorld) {
  const value = await prepare(this); value.old = value.claimMap(); value.now = value.queue[0]!.deadline;
});
When('服务恢复并核对队列期限', function (this: SpecWorld) { const value = fixture(this); value.fail(value.old!); value.reopen(); });
Then('截止时的失败不得再消耗重试额度', function (this: SpecWorld) { assert.equal(fixture(this).context().usage.retries, 0); });
Then('过期待办应明确取消且不得增加成员执行或宣告完成', function (this: SpecWorld) {
  const value = fixture(this); assert.equal(value.queue.filter(part => part.status === 'cancelled' && part.reason === 'WORK_EXPIRED').length, 4);
  assert.equal(value.context().discussion!.mapReduce!.assignments.length, 4); assert.notEqual(value.context().outcome, 'complete');
});

interface LegacyQueueState { fixture: MapCapacityFixture; ordinary: number; assists: number; reads: string[] }
const legacy = new WeakMap<SpecWorld, LegacyQueueState>();
After(function (this: SpecWorld) { legacy.get(this)?.fixture.close(); legacy.delete(this); });
Given('历史四片快照已有一片完成但尚无队列字段', async function (this: SpecWorld) {
  const value = new MapCapacityFixture(undefined, true);
  legacy.set(this, { fixture: value, ordinary: 0, assists: 0, reads: [] });
  await value.recognize(); assert(await value.run());
  const state = legacy.get(this)!; state.ordinary = value.context().usage.ordinary; state.assists = value.context().usage.assists; state.reads = [...value.documentReads];
  updateMapContext(value, c => {
    const round = c.discussion!; delete round.mapReduce!.queue; delete round.mapReduce!.concurrency;
    round.mapReduce!.assignments = round.mapReduce!.assignments.map(({ partitionId, target }) => ({ partitionId, target }));
    round.results = round.results.map(({ target, status, answer, artifactIds }) => ({ target, status, answer, artifactIds }));
  });
});
When('服务重复恢复后执行剩余分片并归并', async function (this: SpecWorld) {
  const state = legacy.get(this)!, value = state.fixture; value.reopen(); value.reopen();
  assert.equal(value.context().usage.ordinary, state.ordinary); assert.equal(value.context().usage.assists, state.assists);
  assert.equal(value.pending('assistance').length, 3);
  while (value.pending('assistance').length) assert(await value.run());
  assert.equal(value.pending('discussionSummary').length, 1); assert(await value.run());
});
Then('已完成片不得重跑且原始结果和计费应保留', function (this: SpecWorld) {
  const state = legacy.get(this)!, value = state.fixture;
  for (const url of state.reads) assert.equal(value.documentReads.filter(item => item === url).length, 1);
  assert.equal(value.context().discussion!.results.length, 4); assert.equal(value.pending('owner').length, 1);
  assert(value.context().usage.ordinary > state.ordinary); assert.equal(value.context().usage.assists, state.assists);
});
