import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { ExecutionMemoryFixture, memoryAB } from '../long-term-experience-acceptance.js';
import { missingResourceAcquisitions, savedAcquisitions, sameResourceIdentity } from '../../src/resource-acquisition.js';
import type { SpecWorld } from './steps.js';

interface MemoryRun {
  fixture?: ExecutionMemoryFixture;
  boundary?: string;
  trainedTask?: string;
  before?: number;
  released?: number;
  comparison?: Awaited<ReturnType<typeof memoryAB>>;
}
const runs = new WeakMap<SpecWorld, MemoryRun>();
function run(world: SpecWorld): MemoryRun {
  let value = runs.get(world);
  if (!value) { value = {}; runs.set(world, value); }
  return value;
}

async function seed(world: SpecWorld, count = 2) {
  const fixture = run(world).fixture = await ExecutionMemoryFixture.create();
  const publication = await fixture.seed(count);
  run(world).trainedTask = publication.taskId;
  return fixture;
}

After({ tags: '@long_term_experience' }, async function (this: SpecWorld) { await run(this).fixture?.close(); });

Given('一个已发布的分片任务先遇到可信的网页登录阻塞再取得同一来源的完整正文', async function (this: SpecWorld) {
  const fixture = await seed(this);
  assert.deepEqual(Object.values(fixture.memory!.pending), [fixture.context.publishedDelivery?.revision]);
  assert.equal(fixture.memory!.routes.length, 0);
  const receipts = savedAcquisitions(fixture.context);
  const failed = receipts.find(receipt => receipt.status === 'authentication_required')!;
  const acquired = receipts.find(receipt => receipt.source === 'runCli' && receipt.status === 'acquired')!;
  assert(failed && acquired && sameResourceIdentity(failed.requestedResource, acquired.resource));
});
When('服务在经验处理前意外关闭并重复恢复', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.open();
  fixture.engine.recover(fixture.room);
  fixture.engine.recover(fixture.room);
});
Then('已发布的交付和执行摘要仍可读取', function (this: SpecWorld) {
  const { context } = run(this).fixture!;
  assert.equal(context.outcome, 'complete');
  assert(context.publishedDelivery?.artifactIds.length);
  assert.equal(context.messages.filter(message => message.text.startsWith('执行摘要')).length, 1);
});
Then('同会话只沉淀一次有回执来源的读取经验', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  const routes = fixture.memory!.routes, receipts = savedAcquisitions(fixture.context);
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.successes, 1);
  assert(receipts.some(receipt => receipt.id === routes[0]!.successReceiptId && receipt.status === 'acquired'));
  assert(receipts.some(receipt => receipt.id === routes[0]!.failedReceiptId && receipt.status === 'authentication_required'));
  assert.deepEqual(fixture.memory!.pending, {});
});

When('已提交发布的经验写入事务首次失败', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.store.failNextCommit = true;
  fixture.engine.tick(fixture.room);
  assert(fixture.engine.healthy);
  assert.equal(fixture.memory!.routes.length, 0);
  assert.equal(fixture.memory!.pending[fixture.task], fixture.context.publishedDelivery?.revision);
});
Then('原发布可补记且一次恢复只生成一条经验', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.engine.recover(fixture.room);
  fixture.engine.tick(fixture.room);
  assert.equal(fixture.memory!.routes.length, 1);
  assert.equal(fixture.memory!.routes[0]?.successes, 1);
  assert.deepEqual(fixture.memory!.pending, {});
});

Given('同会话有一条已验证的读取经验和两个匹配的新分片', async function (this: SpecWorld) {
  const fixture = await seed(this);
  await fixture.submit();
});
When('任务按原权限取得首个分片的可信正文回执', async function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  value.before = fixture.pending.length;
  fixture.afterRead = () => { value.released = fixture.pending.length; };
  assert(await fixture.run(fixture.pending[0]));
  delete fixture.afterRead;
  assert(await fixture.run(fixture.pending[0]));
});
Then('取得回执前只有首个分片收到路线建议', function (this: SpecWorld) {
  const { before, fixture } = run(this);
  assert.equal(before, 1);
  assert.equal(fixture!.attempts.at(-2)?.learned, true);
});
Then('其他匹配分片在验证后可收到同一路线建议', function (this: SpecWorld) {
  const { released, fixture } = run(this);
  assert.equal(released, 1);
  assert.equal(fixture!.attempts.at(-1)?.learned, true);
  assert.equal(fixture!.context.discussion!.results.filter(result => result.status === 'success').length, 2);
});

Given('新任务使用了同会话的历史读取路线', async function (this: SpecWorld) {
  const fixture = await seed(this);
  await fixture.submit();
  assert(fixture.pending[0]!.learnedReadRoute);
});
When('路线先验证成功随后另一次采用收到可信登录反证并继续新任务', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  await fixture.finish();
  fixture.mode = 'contrary';
  await fixture.submit();
  await fixture.finish();
  fixture.engine.tick(fixture.room);
  fixture.mode = 'read';
  await fixture.submit();
});
Then('成功和反证分别计到实际采用的经验上', function (this: SpecWorld) {
  const route = run(this).fixture!.memory!.routes[0]!;
  assert.deepEqual([route.matched, route.applied, route.successes, route.failures, route.disabled], [3, 3, 3, 1, true]);
});
Then('反证后的分片按普通路径继续并且下一任务不再使用旧建议', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.deepEqual(fixture.attempts.slice(-2).map(item => item.learned), [true, false]);
  assert(fixture.pending.every(work => !work.learnedReadRoute));
});

Given('历史读取经验在当前任务的{string}发生变化', async function (this: SpecWorld, boundary: string) {
  const fixture = await seed(this);
  fixture.engine.tick(fixture.room);
  assert.equal(fixture.memory!.routes.length, 1);
  if (boundary === '会话') fixture.room = 'different-room';
  if (boundary === 'CLI 目录') await fixture.changeCatalog();
  if (boundary === '工具协议') fixture.config.toolVersion += '-changed';
  if (boundary === '成员权限') fixture.config.localTools = { enabled: false };
  if (boundary === '来源') fixture.urls = fixture.urls.map(url => url.replace('docs.example.com', 'other.example.com'));
});
When('当前任务进入分片调度', async function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  await fixture.submit();
  value.before = fixture.pending.length;
  assert(await fixture.run(fixture.pending[0]));
});
Then('首个分片按普通路径派发且未收到历史路线', function (this: SpecWorld) {
  const value = run(this);
  assert(value.before! >= 2);
  assert.equal(value.fixture!.attempts.at(-1)?.learned, false);
});

Given('同会话已发布七个成功分片并且第八个分片缺失', async function (this: SpecWorld) {
  const { context } = await seed(this, 8);
  assert.equal(context.discussion!.results.filter(result => result.status === 'success').length, 7);
  assert(context.messages.some(message => message.text.includes('doc-8') && message.text.includes('执行摘要')));
});
When('用户提交同样的提取任务并固定相同的正文版本', async function (this: SpecWorld) {
  await run(this).fixture!.submit('same');
});
Then('原七个分片带原有来源引用进入归并且不消耗协助额度', function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!, context = fixture.context;
  const original = fixture.engine.view(fixture.room, value.trainedTask)!.context;
  const priorEvidence = new Set(savedAcquisitions(original).map(receipt => receipt.id));
  const reused = context.discussion!.mapReduce!.queue!.flatMap(part => part.reusedSource ?? []);
  assert.equal(reused.length, 7);
  assert(reused.every(part => part.sourceTaskId === original.taskId && priorEvidence.has(part.evidenceId)));
  const artifacts = context.artifacts.filter(artifact => artifact.reusedFrom);
  assert.equal(artifacts.length, 7);
  for (const artifact of artifacts) {
    const prior = original.artifacts.find(item => item.id === artifact.reusedFrom!.artifactId);
    assert.deepEqual(artifact.sourceItems, prior?.sourceItems);
  }
  assert.equal(context.usage.assists, 1);
});
Then('只有第八个分片需要派发', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.deepEqual(fixture.pending.map(work => (work.payload.partition as { id: string }).id), ['doc-8']);
});

Given('当前请求和已发布分片的{string}不同', async function (this: SpecWorld, condition: string) {
  const fixture = await seed(this);
  run(this).boundary = condition;
  if (condition === '来源身份') fixture.urls[0] = 'https://docs.example.com/new-doc';
  if (condition === '提取要求') fixture.output = '提取不同的字段';
});
When('当前任务安排提取分片', async function (this: SpecWorld) { await run(this).fixture!.submit(run(this).boundary); });
Then('受影响的分片应重新派发', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  const queue = fixture.context.discussion!.mapReduce!.queue!;
  assert.equal(queue[0]!.status, 'running');
  assert.equal(queue[0]!.reusedSource, undefined);
  if (['来源身份', '正文版本', '未提供正文版本'].includes(run(this).boundary!)) assert.equal(queue[1]!.status, 'succeeded');
});

Given('同批固定版本的文档在两次运行前有相同的已发布结果', async function (this: SpecWorld) { await seed(this, 8); });
When('分别启用和关闭长期经验执行同一请求', async function (this: SpecWorld) { run(this).comparison = await memoryAB(run(this).fixture!); });
Then('两次交付的文档覆盖与来源一致', function (this: SpecWorld) {
  const { off, on } = run(this).comparison!;
  const results = (context: typeof off) => context.discussion!.results.map(item => [item.status, item.answer]).sort();
  const sources = (context: typeof off) => context.artifacts.flatMap(item => item.sourceItems?.map(source => source.sourceDocId) ?? []).sort();
  assert.equal(results(off).length, 8);
  assert.deepEqual(results(off), results(on));
  assert.deepEqual(sources(off), sources(on));
  assert.deepEqual(missingResourceAcquisitions(on), []);
  assert.equal(off.publishedDelivery?.artifactIds.length, 1);
  assert.equal(on.publishedDelivery?.artifactIds.length, 1);
  assert.equal(off.messages.find(message => message.kind === 'final')?.detailText, on.messages.find(message => message.kind === 'final')?.detailText);
});
Then('启用时实际派发和模型请求更少', function (this: SpecWorld) {
  const { off, on, without, withMemory } = run(this).comparison!;
  assert.deepEqual([off.usage.assists, on.usage.assists, without, withMemory], [8, 1, 19, 5]);
});
