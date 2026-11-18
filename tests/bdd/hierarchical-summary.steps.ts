import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  executeSummaryModel, fixedCheckKeepsSummary, makeArticlesLarge, prepareSummaryModel,
  readIndexedArticleFrom, summaryRequestOmitsProviderTruncation, oversizedSummaryDraft,
  type SummaryModel, type SummaryRun,
} from '../hierarchical-summary-model-fixture.js';
import type { SpecWorld } from './steps.js';

interface State {
  smallModel?: SummaryModel; largeModel?: SummaryModel; model?: SummaryModel;
  smaller?: SummaryRun; larger?: SummaryRun; run?: SummaryRun;
  read?: ReturnType<typeof readIndexedArticleFrom>;
  stopped?: { reason: string; owners: number; keptDraft: boolean };
  check?: { unchanged: boolean; fullText: string };
}
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => {
  let current = states.get(world);
  if (!current) { current = {}; states.set(world, current); }
  return current;
};
const requireModel = (world: SpecWorld) => {
  const model = state(world).model;
  assert(model, 'Given 必须先建立真实任务与文章数据');
  return model;
};

Given('当前任务可以分别保存一百篇和一千篇待汇总文章', { timeout: 60_000 }, function (this: SpecWorld) {
  const current = state(this);
  current.smallModel = prepareSummaryModel(100);
  current.largeModel = prepareSummaryModel(1000);
  assert.equal(current.smallModel.context.artifacts.length, 100);
  assert.equal(current.largeModel.context.artifacts.length, 1000);
});
When('两次汇总都沿容量允许的轮次完成', { timeout: 120_000 }, function (this: SpecWorld) {
  const current = state(this);
  assert(current.smallModel && current.largeModel, 'Given 必须先保存两组文章');
  current.smaller = executeSummaryModel(current.smallModel);
  current.larger = executeSummaryModel(current.largeModel);
});
Then('两次方案师请求都只含一条不超过一页的顶层摘要及其直接来源编号', function (this: SpecWorld) {
  const current = state(this);
  assert(current.smaller && current.larger);
  assert(current.smaller.summary.length > 0 && current.smaller.sourceIds.length > 0);
  assert(current.larger.summary.length > 0 && current.larger.sourceIds.length > 0);
  assert(current.larger.sourceIds.length < 1000);
  assert(current.smaller.sourceIds.length < 100);
});
Then('一千篇的层数多于一百篇且两次请求都没有文章正文', function (this: SpecWorld) {
  const current = state(this);
  assert(current.smaller && current.larger);
  assert(current.larger.layer > current.smaller.layer);
  assert(!current.smaller.material.includes('正文专有'));
  assert(!current.larger.material.includes('正文专有'));
  assert(current.larger.material.length < current.smaller.material.length * 10);
});
Then('理解分片和归并请求都不内联文章正文或成员原始答复', function (this: SpecWorld) {
  const current = state(this);
  assert(current.smaller && current.larger);
  assert.equal(current.smaller.inlined, false);
  assert.equal(current.larger.inlined, false);
});

Given('当前任务已经保存两篇可分页读取的文章', { timeout: 30_000 }, function (this: SpecWorld) {
  const model = prepareSummaryModel(2);
  makeArticlesLarge(model);
  state(this).model = model;
});
When('系统完成分层归并并按顶层来源索引读取其中一篇', { timeout: 60_000 }, function (this: SpecWorld) {
  const model = requireModel(this);
  const run = executeSummaryModel(model);
  state(this).run = run;
  state(this).read = readIndexedArticleFrom(model, run);
});
Then('读取使用现有产物分页并返回该篇保存的正文', function (this: SpecWorld) {
  const read = state(this).read;
  assert(read);
  assert.equal(read.pageText, read.body);
});
Then('短产物第一次读取停在保存边界且新页消耗一次普通额度', function (this: SpecWorld) {
  const read = state(this).read;
  assert(read);
  assert.equal(read.shortBoundary, true);
  assert.equal(read.charged, 1);
});

Given('当前任务已经保存可产生超页顶层摘要的文章', { timeout: 30_000 }, function (this: SpecWorld) {
  const model = prepareSummaryModel(2);
  makeArticlesLarge(model);
  state(this).model = model;
});
When('系统执行分层归并并验收顶层摘要', { timeout: 60_000 }, function (this: SpecWorld) {
  const model = requireModel(this);
  model.requestSummary();
  model.settle(oversizedSummaryDraft);
  state(this).stopped = {
    reason: model.context.reason,
    owners: model.pending('owner').length,
    keptDraft: model.context.artifacts.some(artifact => artifact.content.includes('超'.repeat(100))),
  };
});
Then('汇总停止', function (this: SpecWorld) {
  const stopped = state(this).stopped;
  assert(stopped);
  assert.match(stopped.reason, /超过一页/);
});
Then('方案师请求不会改带文章全文', function (this: SpecWorld) {
  const stopped = state(this).stopped;
  assert(stopped);
  assert.equal(stopped.owners, 0);
  assert.equal(stopped.keptDraft, false);
});

Given('当前任务已经保存可生成固定大小摘要的文章和超容量检查证据', { timeout: 30_000 }, function (this: SpecWorld) {
  const model = prepareSummaryModel(2);
  makeArticlesLarge(model);
  state(this).model = model;
});
When('系统完成汇总并组装固定检查请求', { timeout: 60_000 }, async function (this: SpecWorld) {
  const model = requireModel(this);
  const run = executeSummaryModel(model);
  state(this).run = run;
  state(this).check = await fixedCheckKeepsSummary(run.summary);
  await summaryRequestOmitsProviderTruncation();
});
Then('检查按现有全文边界失败', function (this: SpecWorld) {
  const check = state(this).check;
  assert(check);
  assert.equal(check.fullText, '固定证据'.repeat(1024));
});
Then('该失败不改写汇总结果', function (this: SpecWorld) {
  const check = state(this).check;
  const run = state(this).run;
  assert(check && run);
  assert.equal(check.unchanged, true);
  assert.equal(run.summary.length > 0, true);
});

Given('当前任务已保存多篇待汇总文章但协助额度不足', { timeout: 30_000 }, function (this: SpecWorld) {
  const model = prepareSummaryModel(2, 0);
  makeArticlesLarge(model);
  assert.equal(model.context.config.limits.assists, 0);
  assert.equal(model.context.artifacts.length, 2);
  state(this).model = model;
});
When('汇总准备按容量派发', { timeout: 30_000 }, function (this: SpecWorld) {
  const model = requireModel(this);
  model.requestSummary();
  state(this).stopped = { reason: model.context.reason, owners: model.pending('owner').length,
    keptDraft: JSON.stringify(model.context.intents).includes('正文专有') };
});
Then('系统保留协助额度不足且不发出带文章正文的方案师请求', function (this: SpecWorld) {
  const model = requireModel(this);
  const stopped = state(this).stopped;
  assert(stopped);
  const notice = model.context.messages.map(message => message.text).join('\\n');
  assert.match(notice, /协助额度不足/);
  assert.equal(stopped.owners, 0);
  assert.equal(stopped.keptDraft, false);
});
