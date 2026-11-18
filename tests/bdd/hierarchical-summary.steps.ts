import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import {
  compareArticleCounts, fixedCheckKeepsSummary, readIndexedArticle, refuseWhenAssistsRunOut,
  stopWhenTopExceedsPage, summarizeArticles, summaryRequestOmitsProviderTruncation, type SummaryRun,
} from '../hierarchical-summary-model-fixture.js';
import type { SpecWorld } from './steps.js';

type Case = 'compare' | 'read' | 'oversize' | 'fixed-check' | 'quota';
interface State {
  selected?: Case;
  smaller?: SummaryRun; larger?: SummaryRun;
  read?: ReturnType<typeof readIndexedArticle>;
  stopped?: ReturnType<typeof stopWhenTopExceedsPage>;
  check?: { unchanged: boolean; fullText: string };
  refused?: ReturnType<typeof refuseWhenAssistsRunOut>;
}
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => {
  let current = states.get(world);
  if (!current) { current = {}; states.set(world, current); }
  return current;
};
const select = (world: SpecWorld, selected: Case) => { states.set(world, { selected }); };
const selected = (world: SpecWorld, expected: Case) => {
  assert.equal(state(world).selected, expected, 'Given 必须选择对应的真实场景夹具');
};

Given('当前任务可以分别保存一百篇和一千篇待汇总文章', function (this: SpecWorld) { select(this, 'compare'); });
When('两次汇总都沿容量允许的轮次完成', function (this: SpecWorld) {
  selected(this, 'compare');
  const compared = compareArticleCounts();
  state(this).smaller = compared.smaller;
  state(this).larger = compared.larger;
});
Then('两次方案师请求都只含一条不超过一页的顶层摘要及其直接来源编号', function (this: SpecWorld) {
  const current = state(this);
  assert(current.smaller!.summary.length > 0 && current.smaller!.sourceIds.length > 0);
  assert(current.larger!.summary.length > 0 && current.larger!.sourceIds.length > 0);
  assert(current.larger!.sourceIds.length < 1000);
  assert(current.smaller!.sourceIds.length < 100);
});
Then('一千篇的层数多于一百篇且两次请求都没有文章正文', function (this: SpecWorld) {
  const current = state(this);
  assert(current.larger!.layer > current.smaller!.layer);
  assert(!current.smaller!.material.includes('正文专有'));
  assert(!current.larger!.material.includes('正文专有'));
  assert(current.larger!.material.length < current.smaller!.material.length * 10);
});
Then('理解分片和归并请求都不内联文章正文或成员原始答复', function (this: SpecWorld) {
  const current = state(this);
  assert.equal(current.smaller!.inlined, false);
  assert.equal(current.larger!.inlined, false);
});

Given('顶层摘要的直接来源索引含有一篇文章的产物编号', function (this: SpecWorld) { select(this, 'read'); });
When('方案师读取该编号', function (this: SpecWorld) {
  selected(this, 'read');
  state(this).read = readIndexedArticle();
});
Then('读取使用现有产物分页并返回该篇保存的正文', function (this: SpecWorld) {
  const read = state(this).read!;
  assert.equal(read.pageText, read.body);
});
Then('短产物第一次读取停在保存边界且新页消耗一次普通额度', function (this: SpecWorld) {
  const read = state(this).read!;
  assert.equal(read.shortBoundary, true);
  assert.equal(read.charged, 1);
});

Given('分层之后只剩一条摘要且其正文超过一页', function (this: SpecWorld) { select(this, 'oversize'); });
When('系统验收这条顶层摘要', function (this: SpecWorld) {
  selected(this, 'oversize');
  state(this).stopped = stopWhenTopExceedsPage();
});
Then('汇总停止', function (this: SpecWorld) { assert.match(state(this).stopped!.reason, /超过一页/); });
Then('方案师请求不会改带文章全文', function (this: SpecWorld) {
  assert.equal(state(this).stopped!.owners, 0);
  assert.equal(state(this).stopped!.keptDraft, false);
});

Given('汇总已经交出固定大小的顶层摘要', function (this: SpecWorld) { select(this, 'fixed-check'); });
Given('随后的固定检查材料全文超过检查请求容量', function (this: SpecWorld) { selected(this, 'fixed-check'); });
When('系统组装这次固定检查请求', async function (this: SpecWorld) {
  selected(this, 'fixed-check');
  const run = summarizeArticles(2);
  state(this).check = await fixedCheckKeepsSummary(run.summary);
  await summaryRequestOmitsProviderTruncation();
});
Then('检查按现有全文边界失败', function (this: SpecWorld) {
  assert.equal(state(this).check!.fullText, '固定证据'.repeat(1024));
});
Then('该失败不改写汇总结果', function (this: SpecWorld) {
  assert.equal(state(this).check!.unchanged, true);
});

Given('当前任务已保存多篇待汇总文章但协助额度不足', function (this: SpecWorld) { select(this, 'quota'); });
When('汇总准备按容量派发', function (this: SpecWorld) {
  selected(this, 'quota');
  state(this).refused = refuseWhenAssistsRunOut();
});
Then('系统保留协助额度不足且不发出带文章正文的方案师请求', function (this: SpecWorld) {
  assert.match(state(this).refused!.notice, /协助额度不足/);
  assert.equal(state(this).refused!.owners, 0);
});
