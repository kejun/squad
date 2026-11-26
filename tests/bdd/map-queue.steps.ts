import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import type { Intent } from '../../src/types.js';
import { checkReviewSources } from '../../src/delivery-acceptance.js';
import { MapCapacityFixture, groupedIntent, updateMapContext } from '../map-capacity-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';

class QueueFixture extends MapCapacityFixture {
  old?: Intent;
  constructor(workTimeoutMs?: number) {
    super(undefined, true);
    if (workTimeoutMs !== undefined) this.config.limits.workTimeoutMs = workTimeoutMs;
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
async function prepare(world: SpecWorld, workTimeoutMs?: number) {
  const value = new QueueFixture(workTimeoutMs); states.set(world, value); await value.recognize();
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

Given('分片队列已满且首批分片已领取', async function (this: SpecWorld) {
  const value = await prepare(this, 1000);
  const first = value.pending('assistance').map(work => value.engine.claim(value.room, value.task, work.id));
  assert(first.every(work => work));
  value.old = first[0]!;
});
When('首批分片到达单次执行期限后报告超时且任务窗口仍有效', function (this: SpecWorld) {
  const value = fixture(this), first = value.old!;
  value.now = first.deadline!;
  assert(value.now < value.context().resilience!.window.hardDeadline);
  assert(value.event({ type: 'WORK_FAILED', intentId: first.id, attempt: first.attempt, transient: true, reason: 'transport deadline' }).ok);
});
Then('未领取分片仍可领取并从各自领取时计算单次执行期限', function (this: SpecWorld) {
  const value = fixture(this), work = value.claimMap();
  assert.equal(value.queue.find(part => part.workId === work.id)!.partitionId, 'group-5');
  assert.equal(work.deadline, value.now + 1000);
});
Then('原尝试的迟到结果应被拒绝且不消耗自动重试额度', function (this: SpecWorld) {
  const value = fixture(this), work = value.old!;
  assert.equal(value.event({ type: 'DISCUSSION_RESULT', workId: work.id, discussionId: work.discussionId!, attempt: work.attempt,
    fence: work, status: 'success', text: '迟到结果' }).ok, false);
  assert.equal(value.context().usage.retries, 0);
});

Given('已分配分片等待领取的时间超过单次执行时限而任务窗口仍有效', async function (this: SpecWorld) {
  const value = await prepare(this, 1000);
  value.old = value.pending('assistance')[0]!;
  value.now += 1050;
  assert(value.now < value.context().resilience!.window.hardDeadline);
});
When('服务恢复后首次领取并执行该分片', async function (this: SpecWorld) {
  const value = fixture(this); value.reopen();
  assert.equal(value.pending('assistance')[0]?.id, value.old!.id);
  assert.equal(await value.run(), true);
});
Then('执行器应取得从本次领取开始的完整执行时间', function (this: SpecWorld) {
  const value = fixture(this), work = value.context().intents.find(item => item.id === value.old!.id)!;
  assert.equal(work.deadline, value.now + 1000);
  assert.equal(work.attempt, 1);
  assert(value.requests.some(request => request.kind === 'assistance'));
  assert.equal(value.queue.find(part => part.workId === work.id)?.status, 'succeeded');
});

Given('分片队列有已分配和未分配的分片等待领取', async function (this: SpecWorld) {
  const value = await prepare(this, 1000); value.old = value.pending('assistance')[0]!;
  assert.equal(value.queue.filter(part => part.status === 'queued').length, 4);
});
When('{string}到期后尝试领取并核对调度', async function (this: SpecWorld, label: string) {
  const value = fixture(this); value.now += 500;
  const hard = label === '任务总窗口';
  updateMapContext(value, c => { c.resilience!.window[hard ? 'hardDeadline' : 'repairDeadline'] = value.now; });
  assert.equal(value.event({ type: 'CLAIM', intentId: value.old!.id }).code, hard ? 'WINDOW_EXPIRED' : 'WORK_EXPIRED');
  assert(value.event({ type: 'SUPERVISE' }).ok);
  assert.equal(await value.run(), false);
});
Then('已分配和未分配分片应保留未完成记录且不得启动或增加自动重试', function (this: SpecWorld) {
  const value = fixture(this), context = value.context();
  assert.equal(value.queue.length, 8);
  assert(value.queue.every(part => ['timeout', 'cancelled'].includes(part.status) && part.reason));
  assert.equal(context.intents.filter(work => work.kind === 'assistance' && work.attempt > 0).length, 0);
  assert.equal(value.requests.filter(request => request.kind === 'assistance').length, 0);
  assert.equal(context.usage.retries, 0);
  assert.notEqual(context.outcome, 'complete');
});

Given('历史分片保存了自己的绝对期限且有已领取的执行', async function (this: SpecWorld) {
  const value = await prepare(this, 1000); value.old = value.claimMap();
  const other = value.pending('assistance')[0]!;
  value.now += 100;
  updateMapContext(value, c => {
    const cap = value.now - 1;
    c.discussion!.mapReduce!.queue!.find(part => part.workId === other.id)!.deadline = cap;
    c.intents.find(work => work.id === other.id)!.deadline = cap;
  });
});
When('服务恢复历史分片并重领仍可执行的原尝试', function (this: SpecWorld) {
  const value = fixture(this); value.reopen();
  const resumed = value.engine.claim(value.room, value.task, value.old!.id);
  assert(resumed);
  assert.equal(resumed.attempt, value.old!.attempt + 1);
});
Then('已领取工作的原期限应保持且过期的历史待办不能启动', function (this: SpecWorld) {
  const value = fixture(this), context = value.context();
  assert.equal(context.intents.find(work => work.id === value.old!.id)!.deadline, value.old!.deadline);
  const expired = value.queue.find(part => part.reason === 'WORK_EXPIRED');
  assert(expired && expired.workId);
  assert.equal(expired.status, 'cancelled');
  assert.equal(value.engine.claim(value.room, value.task, expired.workId), null);
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
