import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { ExecutionMemoryFixture, memoryAB, protectedPrefix, type MemoryFixtureMode } from '../long-term-experience-acceptance.js';
import { missingResourceAcquisitions, savedAcquisitions, sameResourceIdentity } from '../../src/resource-acquisition.js';
import { readingMatchReport } from '../../src/task/execution-memory.js';
import type { SpecWorld } from './steps.js';

interface MemoryRun {
  fixture?: ExecutionMemoryFixture;
  boundary?: string;
  trainedTask?: string;
  before?: number;
  released?: number;
  comparison?: Awaited<ReturnType<typeof memoryAB>>;
  observed?: string;
  failedResource?: string;
  beforeRecommendations?: { url: string; recommended: boolean }[];
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
  assert(fixture.memory!.observations?.some(item => item.kind === 'web_login'
    && receipts.some(receipt => receipt.id === item.id && receipt.status === 'authentication_required')));
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
When('路线先验证成功随后另一次采用收到可信账号范围反证并继续新任务', async function (this: SpecWorld) {
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

When('首个分片取得可信账号范围反证后用户停止任务', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.mode = 'contrary';
  assert(await fixture.run(fixture.pending[0]));
  assert(savedAcquisitions(fixture.context).some(receipt => receipt.source === 'runCli' && receipt.status === 'authentication_required'));
  const stopped = fixture.engine.submit(fixture.room, { id: 'stop-contrary-route', text: '停止', replyToTaskId: fixture.task });
  assert(stopped.ok, stopped.code);
  fixture.engine.recover(fixture.room);
});
Then('经验应登记反证并停用旧路线', function (this: SpecWorld) {
  const route = run(this).fixture!.memory!.routes[0]!;
  assert.equal(route.disabled, true);
  assert.equal(route.failures, 1);
});
Then('停止的任务不能产生新的分片复用记录', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.equal(fixture.context.publishedDelivery, undefined);
  assert(fixture.memory!.partitions.every(item => item.sourceTaskId !== fixture.task));
});

Given('历史读取经验在当前任务的{string}发生变化', async function (this: SpecWorld, boundary: string) {
  const fixture = await seed(this);
  fixture.engine.tick(fixture.room);
  assert.equal(fixture.memory!.routes.length, 1);
  if (boundary === '会话') fixture.room = 'different-room';
  if (boundary === 'CLI 目录') await fixture.changeCatalog();
  if (boundary === '工具协议') fixture.config.toolVersion += '-changed';
  if (boundary === '成员权限') fixture.config.localTools = { enabled: false };
  if (boundary === '来源') fixture.urls = fixture.urls.map(url => url.replace('www.yuque.com', 'other.example.com'));
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

async function fresh(world: SpecWorld) {
  return run(world).fixture = await ExecutionMemoryFixture.create();
}

const partUrl = (work: { payload: Record<string, unknown> }) => (work.payload.partition as { objective: string }).objective.slice('提取 '.length);

Given('分片有已结算的{string}证据并通过普通备选路径完成交付', async function (this: SpecWorld, failure: string) {
  const fixture = await fresh(this);
  fixture.mode = failure === '网页登录页' ? 'web-failure' : 'sandbox-failure';
  run(this).observed = failure === '网页登录页' ? 'web_login' : 'sandbox_ps';
  await fixture.submit();
  await fixture.finish();
});

When('发布处理重复恢复', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.open();
  fixture.engine.recover(fixture.room);
  fixture.engine.recover(fixture.room);
});

Then('同会话可查到该失败观察及原回执', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.equal(fixture.memory?.observations?.length, 1);
  const observation = fixture.memory!.observations![0]!;
  assert.equal(observation.kind, run(this).observed);
  assert(savedAcquisitions(fixture.context).some(receipt => receipt.id === observation.id && receipt.operationId === observation.operationId));
});

Then('失败观察不构成读取路线的成功证据', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.deepEqual(fixture.memory!.routes, []);
  assert.equal(fixture.memory?.collections?.[fixture.task]?.observations, 1);
  assert.equal(fixture.memory?.collections?.[fixture.task]?.partitions, 2);
});

Given('已登记的读取器凭可信正文完成分片且没有先前网页失败', async function (this: SpecWorld) {
  const fixture = await fresh(this);
  fixture.mode = 'success';
  fixture.inventoryAvailable = false;
  await fixture.submit();
  await fixture.finish();
  assert.equal(fixture.context.executionMemory?.patterns?.length, 0);
  assert.equal(savedAcquisitions(fixture.context).filter(item => item.status === 'authentication_required').length, 0);
});

When('处理该任务发布且目录暂不可用', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.inventoryAvailable = false;
  fixture.engine.tick(fixture.room);
});

Then('仍可按原调用的绑定保存成功路线和分片来源', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.equal(fixture.memory?.routes.length, 1);
  const route = fixture.memory!.routes[0]!;
  assert(savedAcquisitions(fixture.context).some(receipt => receipt.id === route.successReceiptId
    && receipt.readingPattern?.binding === route.pattern?.binding));
  assert.equal(fixture.memory?.partitions.length, 2);
  assert.equal(fixture.memory?.collections?.[fixture.task]?.routes, 1);
});

Given('同会话已经验证一条覆盖受保护书库的读取路线', async function (this: SpecWorld) {
  const fixture = await fresh(this);
  fixture.execution = 'host';
  await fixture.seed();
  fixture.engine.tick(fixture.room);
  assert.equal(fixture.approvalCount, 1);
  assert.equal(fixture.memory?.routes[0]?.execution, 'host');
});

When('新任务读取该书库两篇未见文档和一篇同源公开文档', async function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  fixture.urls = [protectedPrefix + 'new-one', protectedPrefix + 'new-two', 'https://www.yuque.com/team/public/new-three'];
  await fixture.submit();
  value.beforeRecommendations = fixture.pending.map(work => ({ url: partUrl(work), recommended: !!work.learnedReadRoute }));
  await fixture.finish();
});

Then('首次只向一个适用分片推荐且普通分片可以派发', function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  assert.deepEqual(value.beforeRecommendations, [
    { url: fixture.urls[0], recommended: true }, { url: fixture.urls[2], recommended: false },
  ]);
});

Then('首个分片取得可信正文后才向其他适用分片推荐', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  const byUrl = new Map(fixture.attempts.slice(-3).map(attempt => [attempt.url, attempt.learned]));
  assert.deepEqual(fixture.urls.map(url => byUrl.get(url)), [true, true, false]);
  const receipts = savedAcquisitions(fixture.context);
  assert.equal(receipts.filter(item => item.source === 'runCli' && item.status === 'acquired').length, 2);
  assert.equal(fixture.approvalCount, 3);
  const operations = fixture.context.intents.flatMap(work => work.localOperations ?? []).filter(op => op.approval);
  assert(operations.every(op => op.approval?.status === 'approved' && op.status === 'succeeded'));
  assert.deepEqual(readingMatchReport(fixture.context)?.map(({ candidates, offered, adopted, acquired }) =>
    [candidates, offered, adopted, acquired]), [[1, 1, 1, 1], [1, 1, 1, 1], [1, 0, 0, 0]]);
});

Given('同会话的已验证路线遇到{string}', async function (this: SpecWorld, change: string) {
  const fixture = await seed(this);
  fixture.engine.tick(fixture.room);
  if (change === '无关目录条目') await fixture.changeCatalog(true);
  if (change === '读取器版本') fixture.changeReader();
  if (change === '账号') fixture.changeAccount();
  if (change === '访问范围未知') fixture.urls = fixture.urls.map((_, index) => 'https://www.yuque.com/team/other/doc-' + index);
  if (change === '旧记录缺少可核对绑定') fixture.legacyRoute();
});

When('分片安排本轮读取', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  await fixture.submit();
  assert(await fixture.run(fixture.pending[0]));
});

Then('路线判定为{string}', function (this: SpecWorld, decision: string) {
  assert.equal(run(this).fixture!.attempts.at(-1)?.learned, decision === '继续试用已验证路线');
});

async function refuteDocument(world: SpecWorld) {
  const value = run(world), fixture = await seed(world);
  fixture.mode = 'document-denied';
  await fixture.submit();
  value.failedResource = fixture.urls[0]!;
  assert(fixture.pending[0]!.learnedReadRoute);
  assert(await fixture.run(fixture.pending[0]));
  const receipt = savedAcquisitions(fixture.context).find(item => item.source === 'runCli' && item.status === 'authentication_required');
  assert(receipt && !receipt.authenticationScope);
  value.observed = receipt.id;
  return fixture;
}

function stopAndRecover(fixture: ExecutionMemoryFixture) {
  const stopped = fixture.engine.submit(fixture.room, { id: 'stop-scoped-route', text: '停止', replyToTaskId: fixture.task });
  assert(stopped.ok, stopped.code);
  fixture.open();
  fixture.engine.recover(fixture.room);
}

Given('已采用的读取路线在首个文档上取得可信的登录反证', async function (this: SpecWorld) {
  await refuteDocument(this);
});

When('用户停止任务后重新核对同书库来源', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  stopAndRecover(fixture);
  fixture.mode = 'read';
  await fixture.submit();
});

Then('失败文档走普通路径且可追溯原反证', function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  assert.equal(fixture.memory?.routes[0]?.exceptions?.[0]?.receiptId, value.observed);
  const failed = fixture.pending.find(work => partUrl(work) === value.failedResource);
  assert(failed && !failed.learnedReadRoute);
});

Then('同书库其他适用文档仍可试用路线', function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  assert(fixture.pending.some(work => partUrl(work) !== value.failedResource && work.learnedReadRoute));
});

Given('某文档的历史读取路线已有文档级反证', async function (this: SpecWorld) {
  const fixture = await refuteDocument(this);
  stopAndRecover(fixture);
  assert.equal(fixture.memory?.routes[0]?.version, 1);
});

When('该文档通过普通路径获得较新的可信正文并发布', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.mode = 'success';
  await fixture.submit();
  assert(!fixture.pending.find(work => partUrl(work) === fixture.urls[0])?.learnedReadRoute);
  await fixture.finish();
  fixture.engine.tick(fixture.room);
});

Then('对应版本更新且可重新试用', async function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  assert.equal(fixture.memory?.routes[0]?.version, 2);
  assert.equal(fixture.memory?.routes[0]?.restoredFrom?.receiptId, value.observed);
  fixture.mode = 'read';
  await fixture.submit();
  assert(fixture.pending.find(work => partUrl(work) === fixture.urls[0])?.learnedReadRoute);
});

Given('普通多文档请求提供了可核对的文档链接', async function (this: SpecWorld) {
  await fresh(this);
});

When('分片计划选用本轮来源编号并改写目标描述', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.mode = 'read';
  fixture.structuredSources = true;
  await fixture.submit();
  await fixture.finish();
  fixture.engine.tick(fixture.room);
});

Then('每个成功分片的产物和正文回执可按来源索引', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  const resultSources = fixture.memory!.partitions.map(item => item.resource);
  assert.deepEqual(resultSources, fixture.urls.map(url => ({ kind: 'url', url })));
  assert(fixture.memory!.partitions.every(item => savedAcquisitions(fixture.context).some(receipt => receipt.id === item.evidenceId)));
});

Given('历史发布保存了{string}的可信失败观察', async function (this: SpecWorld, entry: string) {
  const fixture = await fresh(this);
  fixture.mode = entry === '网页匿名读取' ? 'web-failure' : 'sandbox-failure';
  await fixture.submit();
  await fixture.finish();
  fixture.engine.tick(fixture.room);
  assert.equal(fixture.memory?.observations?.length, 1);
});

When('当前分片的相应条件{string}', async function (this: SpecWorld, condition: string) {
  const fixture = run(this).fixture!;
  fixture.mode = 'read';
  fixture.urls = fixture.urls.map((_, index) => (condition === '未知' ? 'https://www.yuque.com/team/public/' : protectedPrefix) + 'new-doc-' + index);
  if (condition === '变化') fixture.changeSandbox();
  await fixture.submit();
  assert(await fixture.run(fixture.pending[0]));
});

Then('经验提示为{string}', function (this: SpecWorld, expected: string) {
  const observation = run(this).fixture!.attempts.at(-1);
  assert(observation);
  assert.equal(observation.observations, expected === '可见避免重复探测的提示');
  assert.equal(observation.learned, false);
});

Given('当前采集按已登记的语雀来源及读取器契约执行', async function (this: SpecWorld) { await fresh(this); });

When('本轮取得{string}', async function (this: SpecWorld, response: string) {
  const fixture = run(this).fixture!;
  const responses: Record<string, MemoryFixtureMode> = {
    'HTTP 200 重定向登录页': 'login-redirect', '普通重定向': 'ordinary-redirect', '同名文档但书库不同': 'wrong-book',
    '正文输出截断': 'truncated', '正文页未全部返回': 'page-incomplete', '来源匹配的完整正文': 'success',
  };
  fixture.mode = responses[response]!;
  run(this).observed = fixture.mode;
  await fixture.submit();
  assert(await fixture.run(fixture.pending[0]));
});

Then('回执分类为{string}', function (this: SpecWorld, classification: string) {
  const value = run(this), fixture = value.fixture!;
  const source = value.observed!.endsWith('redirect') ? 'webFetch' : 'runCli';
  const observation = savedAcquisitions(fixture.context).find(item => item.source === source);
  assert.equal(observation?.status, classification);
});

Given('首个适用分片正在试用历史路线', async function (this: SpecWorld) {
  const fixture = await seed(this);
  await fixture.submit();
  assert.equal(fixture.pending.length, 1);
  assert(fixture.pending[0]!.learnedReadRoute);
});

When('试用以{string}结算', async function (this: SpecWorld, anomaly: string) {
  const fixture = run(this).fixture!;
  fixture.mode = anomaly === '超时' ? 'timeout' : 'no-receipt';
  await fixture.finish();
  fixture.engine.tick(fixture.room);
});

Then('剩余分片按普通路径执行且路线未停用', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.deepEqual(fixture.attempts.slice(-2).map(attempt => attempt.learned), [true, false]);
  assert.equal(fixture.memory?.routes[0]?.disabled, false);
  assert.equal(fixture.memory?.routes[0]?.failures, 0);
});

Given('已采用的读取路线在本轮取得可信的账号范围反证', async function (this: SpecWorld) {
  const fixture = await seed(this);
  fixture.mode = 'contrary';
  await fixture.submit();
  assert(await fixture.run(fixture.pending[0]));
  const receipt = savedAcquisitions(fixture.context).find(item => item.authenticationScope === 'pattern');
  assert(receipt);
  run(this).observed = receipt.id;
});

When('尚未处理的同范围分片继续执行且任务结算', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  await fixture.finish();
  fixture.engine.tick(fixture.room);
  fixture.mode = 'read';
  await fixture.submit();
});

Then('当前剩余分片和后续同范围任务走普通路径', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.equal(fixture.attempts.at(-1)?.learned, false);
  assert(fixture.pending.every(work => !work.learnedReadRoute));
  assert.equal(fixture.memory?.routes[0]?.disabled, true);
});

Then('原路线版本保留反证引用', function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  assert.equal(fixture.memory?.routes[0]?.invalidatedBy?.receiptId, value.observed);
  assert.equal(fixture.memory?.routes[0]?.invalidatedBy?.version, 1);
});

Given('同范围历史路线已经因可信账号范围反证停止', async function (this: SpecWorld) {
  const fixture = await seed(this);
  fixture.mode = 'contrary';
  await fixture.submit();
  await fixture.finish();
  fixture.engine.tick(fixture.room);
  assert.equal(fixture.memory?.routes[0]?.disabled, true);
  run(this).observed = fixture.memory!.routes[0]!.invalidatedBy!.receiptId;
});

When('普通路径只复验成功一篇文档并发布', async function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  fixture.mode = 'success';
  await fixture.submit();
  assert(fixture.pending.every(work => !work.learnedReadRoute));
  await fixture.finish();
  fixture.engine.tick(fixture.room);
  fixture.mode = 'read';
  await fixture.submit();
});

Then('只有该文档的新版路线重新试用', function (this: SpecWorld) {
  const fixture = run(this).fixture!;
  assert.deepEqual(fixture.pending.map(work => [partUrl(work), work.learnedReadRoute?.version ?? null]),
    [[fixture.urls[0], 2], [fixture.urls[1], null]]);
});

Then('原范围仍保留旧版本的反证', function (this: SpecWorld) {
  const value = run(this), fixture = value.fixture!;
  assert(fixture.memory?.routes.some(route => route.disabled && route.version === 1 && route.invalidatedBy?.receiptId === value.observed));
});
