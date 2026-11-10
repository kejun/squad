import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { revisionModel, twoRevisionsComplete, threeRevisionsExhaust, revisionBoundary, secondRevisionPrepared, repeatAfterRestart, legacyRevision, type RevisionRun } from '../adaptive-revision-fixture.js';
import { verifyAdaptiveRevisionRunner } from '../adaptive-revision-integration.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, RevisionRun>();
const restarts = new WeakMap<SpecWorld, ReturnType<typeof secondRevisionPrepared>>();
Given('当前候选有一项有依据的内容缺口且任务预算充足', function (this: SpecWorld) { runs.set(this, revisionModel()); });
When('两次独立检查仍发现该缺口而第三个候选修复通过', function (this: SpecWorld) { twoRevisionsComplete(runs.get(this)!); });
Then('应自动完成两次修订并只发布第三个候选', async function (this: SpecWorld) {
  assert.equal(runs.get(this)!.m.c.outcome, 'complete');
  await verifyAdaptiveRevisionRunner();
});
Given('当前候选有三项内容缺口且任务预算充足', function (this: SpecWorld) { runs.set(this, revisionModel(3)); });
When('三次修订后的候选仍不能通过独立检查', function (this: SpecWorld) { threeRevisionsExhaust(runs.get(this)!); });
Then('应保留全部成果和最新缺口并结束且不再安排修订', function (this: SpecWorld) {
  assert.equal(runs.get(this)!.m.c.outcome, 'partial');
  assert.equal(runs.get(this)!.m.c.deliveryCycle?.revisions?.used, 3);
});
Given('自动修订遇到{string}', function (this: SpecWorld, boundary: string) { runs.set(this, revisionModel(1, boundary)); });
When('当前候选的检查未通过', function (this: SpecWorld) { revisionBoundary(runs.get(this)!); });
Then('应保留检查发现并结束且不发出新的修订请求', function (this: SpecWorld) { assert.equal(runs.get(this)!.m.c.outcome, 'partial'); });
Given('已经自动安排第二次修订并保存检查回执', function (this: SpecWorld) { restarts.set(this, secondRevisionPrepared()); });
When('重启后再次提交同一检查回执', function (this: SpecWorld) { repeatAfterRestart(restarts.get(this)!); });
Then('应保留两次已用修订且只存在一个待执行修订', function (this: SpecWorld) { assert.equal(restarts.get(this)!.m.c.deliveryCycle?.revisions?.used, 2); });
Given('旧交付快照只记录已消耗唯一修订', function (this: SpecWorld) { runs.set(this, revisionModel()); });
When('恢复后复查仍有内容缺口', function (this: SpecWorld) { runs.set(this, legacyRevision()); });
Then('应沿用旧周期上限结束且不新增修订额度', function (this: SpecWorld) {
  assert.equal(runs.get(this)!.m.c.outcome, 'partial');
  assert.equal(runs.get(this)!.m.c.intents.filter(work => work.payload.deliveryRevision).length, 1);
});
