import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { WebService } from '../../src/web/service.js';
import type { ArtifactDraft, TaskContext, TaskEvent, WorkKind } from '../../src/types.js';
import { messageArtifacts, taskArtifacts } from '../../web/src/ResultLinks.js';
import { configuration, type EventBody } from '../helpers.js';
import type { SpecWorld } from './steps.js';

type Check = Omit<Extract<TaskEvent, { type: 'CHECK_RESULT' }>, 'id' | 'at'>;
type Test = { service: WebService; room: string; task: string; seq: number; first?: string; second?: string; priorCheck?: Check };
const tests = new WeakMap<SpecWorld, Test>();
const report: ArtifactDraft = { name: 'plan.md', content: 'Original report' };

function create(world: SpecWorld): Test {
  const service = new WebService({ ...configuration(), inputAnalysis: { enabled: false } }, ':memory:');
  const room = service.createRoom().id;
  const created = service.engine.submit(room, { id: 'document-test', text: 'Deliver a report',
    goal: { text: 'Deliver a report', criteria: [], constraints: [], requiredArtifacts: 1 } });
  assert(created.ok && created.taskId);
  const test = { service, room, task: created.taskId, seq: 0 };
  tests.set(world, test);
  return test;
}
function context(test: Test) { return test.service.engine.view(test.room, test.task)!.context; }
function event(test: Test, body: EventBody) {
  return test.service.engine.send(test.room, test.task, { id: `version-test:${++test.seq}`, at: Date.now(), ...body } as TaskEvent);
}
function claim(test: Test, kind: WorkKind) {
  const pending = test.service.engine.pending(test.room, test.task).find(work => work.kind === kind);
  assert(pending, kind);
  const work = test.service.engine.claim(test.room, test.task, pending.id);
  assert(work);
  return work;
}
function delivery(test: Test, ...artifacts: ArtifactDraft[]) {
  return event(test, { type: 'DELIVER', workId: claim(test, 'owner').id, text: 'Prepared the report', artifactIds: [], artifacts });
}
function review(test: Test, passed = true) {
  const work = claim(test, 'check');
  const checked = { type: 'CHECK_RESULT' as const, workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion },
    candidateRevision: context(test).candidate!.revision!, resultId: `judgment:${work.id}`, passed, gaps: passed ? [] : ['Revise the report'] };
  assert(event(test, checked).ok);
  return checked;
}
function continueRevision(test: Test) {
  assert(event(test, { type: 'COORDINATE', workId: claim(test, 'facilitator').id, decision: { action: 'continue', reason: 'Revise' } }).ok);
}
function snapshot(test: Test) { return test.service.snapshot(test.room); }
function projected(test: Test) { return taskArtifacts(snapshot(test).tasks.find(task => task.id === test.task)); }

After(async function (this: SpecWorld) {
  const test = tests.get(this);
  if (test) await test.service.close();
});

Given('用户已有一份经检查发布的报告', function (this: SpecWorld) {
  const test = create(this);
  assert(delivery(test, report).ok);
  review(test);
  test.first = context(test).artifacts[0]!.id;
});
When('负责人提交该报告的修订并且新候选通过检查', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(event(test, { type: 'CONTINUE' }).ok);
  assert(delivery(test, { ...report, content: 'Revised report', replacesArtifactId: test.first! }).ok);
  test.second = context(test).artifacts[1]!.id;
  assert.deepEqual(projected(test).current.map(report => report.id), [test.first]);
  review(test);
});
Then('当前交付应只列出该报告的新修订', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.deepEqual(projected(test).current.map(report => report.id), [test.second]);
  assert.deepEqual(projected(test).history.map(report => report.id), [test.first]);
});
Then('原结果消息应仍可打开原版报告', function (this: SpecWorld) {
  const test = tests.get(this)!, view = snapshot(test);
  const message = view.messages.find(item => item.kind === 'final' && item.artifactIds?.includes(test.first!));
  assert(message);
  assert.deepEqual(messageArtifacts(view, message).map(item => [item.id, item.content]), [[test.first, report.content]]);
});

Given('同一任务有两份同名且独立的文档', function (this: SpecWorld) {
  const test = create(this);
  assert(event(test, { type: 'ARTIFACT', artifact: { id: 'document-one', ...report } }).ok);
  assert(event(test, { type: 'ARTIFACT', artifact: { id: 'document-two', ...report, content: 'Independent report' } }).ok);
});
When('负责人将两份文档列入交付并且候选通过检查', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(event(test, { type: 'DELIVER', workId: claim(test, 'owner').id, text: 'Two reports', artifactIds: ['document-one', 'document-two'] }).ok);
  review(test);
});
Then('当前交付应包含两份内容可分别查看的文档', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.deepEqual(projected(test).current.map(item => item.content), ['Original report', 'Independent report']);
});

Given('第一份候选已安排检查且负责人后来提交了同一报告的新修订', function (this: SpecWorld) {
  const test = create(this);
  assert(delivery(test, report).ok);
  test.first = context(test).artifacts[0]!.id;
  test.priorCheck = review(test, false);
  continueRevision(test);
  assert(delivery(test, { ...report, content: 'Revised report', replacesArtifactId: test.first }).ok);
  test.second = context(test).artifacts[1]!.id;
});
When('基于原报告的另一份修订和第一份候选的检查结论分别到达', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.equal(event(test, { ...test.priorCheck!, resultId: 'delayed-check', passed: true }).ok, false);
  review(test, false);
  continueRevision(test);
  const rejected = delivery(test, { ...report, content: 'Stale update', replacesArtifactId: test.first! });
  assert.equal(rejected.ok, false);
});
Then('陈旧修订应被拒绝并保留已有候选', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.deepEqual(context(test).candidate?.artifactIds, [test.second]);
  assert.equal(context(test).artifacts.length, 2);
});
Then('第一份检查结论不应发布任何新修订', function (this: SpecWorld) {
  assert.equal(context(tests.get(this)!).publishedDelivery, undefined);
});
Then('新修订应有自己通过的检查才可发布', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(event(test, { type: 'DELIVER', workId: claim(test, 'owner').id, text: 'Retain the revision', artifactIds: [test.second!] }).ok);
  review(test);
  assert.deepEqual(projected(test).current.map(item => item.id), [test.second]);
});

Given('一个已结束任务留有两份没有修订关系的同名旧报告', function (this: SpecWorld) {
  const test = create(this);
  assert(delivery(test, report, { ...report, content: 'Legacy sibling' }).ok);
  review(test);
  test.service.engine.store.transact(test.room, tx => {
    const saved = tx.room.tasks[test.task] as { snapshot: { context: TaskContext } };
    delete saved.snapshot.context.publishedDelivery;
    for (const item of saved.snapshot.context.artifacts) { delete item.documentId; delete item.revision; }
  });
  test.first = context(test).artifacts[0]!.id;
  test.second = context(test).artifacts[1]!.id;
});
When('用户查看该任务的旧结果并继续修订其中一份', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.deepEqual(projected(test).current.map(item => item.id), [test.first, test.second]);
  assert(event(test, { type: 'CONTINUE' }).ok);
  assert(delivery(test, { ...report, content: 'Legacy revised', replacesArtifactId: test.first! }).ok);
  review(test);
});
Then('两份旧报告仍可分别查看', function (this: SpecWorld) {
  const test = tests.get(this)!, view = snapshot(test);
  const original = view.messages.find(item => item.kind === 'final' && item.artifactIds?.includes(test.second!));
  assert(original);
  assert.deepEqual(messageArtifacts(view, original).map(item => item.content), ['Original report', 'Legacy sibling']);
});
Then('修订只与用户此次修订所指的报告建立关系', function (this: SpecWorld) {
  const test = tests.get(this)!;
  const [first, sibling, revision] = context(test).artifacts;
  assert.equal(first?.documentId, undefined);
  assert.equal(sibling?.documentId, undefined);
  assert.equal(revision?.documentId, test.first);
  assert.equal(revision?.replacesArtifactId, test.first);
});
