import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { WebService } from '../../src/web/service.js';
import type { ArtifactDraft, TaskContext, TaskEvent, WorkKind } from '../../src/types.js';
import { messageArtifacts, taskArtifacts } from '../../web/src/ResultLinks.js';
import { candidateJudgments, configuration, type EventBody } from '../helpers.js';
import type { SpecWorld } from './steps.js';

type Check = Omit<Extract<TaskEvent, { type: 'CHECK_RESULT' }>, 'id' | 'at'>;
type Test = {
  service: WebService; room: string; task: string; seq: number;
  first?: string; second?: string; priorCheck?: Check; drafts?: ArtifactDraft[];
  previousArtifacts?: TaskContext['artifacts']; originalFinal?: TaskContext['messages'][number];
  beforeCheck?: TaskContext; replacementCandidate?: TaskContext; failedCheck?: TaskContext; beforeStale?: TaskContext;
  lateCheck?: { result: ReturnType<typeof event>; context: TaskContext; phase: string };
  staleResult?: ReturnType<typeof event>; unboundResult?: ReturnType<typeof event>;
};
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
  assert(event(test, { type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt }).ok);
  const candidate = context(test).candidate!;
  const checked = { type: 'CHECK_RESULT' as const, workId: work.id, fence: work, attempt: work.attempt,
    candidateRevision: candidate.revision!, resultId: `judgment:${work.id}`,
    criteriaResults: candidateJudgments(candidate, passed ? undefined : { index: 0, status: 'failed', reason: 'Revise the report' }) };
  assert(event(test, checked).ok);
  return checked;
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
  test.previousArtifacts = structuredClone(context(test).artifacts);
  test.originalFinal = structuredClone(context(test).messages.find(message => message.kind === 'final')!);
});
When('负责人提交该报告的修订并且新候选通过检查', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(event(test, { type: 'CONTINUE' }).ok);
  assert(delivery(test, { name: 'renamed.md', content: 'Revised report', replacesArtifactId: test.first! }).ok);
  test.second = context(test).artifacts[1]!.id;
  test.beforeCheck = structuredClone(context(test));
  review(test);
});
Then('当前交付应只列出该报告的新修订', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.deepEqual(test.beforeCheck!.publishedDelivery?.artifactIds, [test.first]);
  assert.partialDeepStrictEqual(test.beforeCheck!.artifacts[1], {
    documentId: test.previousArtifacts![0]!.documentId, revision: 2, replacesArtifactId: test.first,
  });
  assert.deepEqual(context(test).publishedDelivery?.artifactIds, [test.second]);
  assert.deepEqual(projected(test).current.map(report => report.id), [test.second]);
  assert.deepEqual(projected(test).history.map(report => report.id), [test.first]);
});
Then('原结果消息应仍可打开原版报告', function (this: SpecWorld) {
  const test = tests.get(this)!, view = snapshot(test);
  const message = view.messages.find(item => item.kind === 'final' && item.artifactIds?.includes(test.first!));
  assert(message);
  assert.deepEqual(message, test.originalFinal);
  assert.deepEqual(message.artifactIds, [test.first]);
  assert.deepEqual(context(test).artifacts[0], test.previousArtifacts![0]);
  assert.deepEqual(messageArtifacts(view, message).map(item => [item.id, item.content]), [[test.first, report.content]]);
});

Given('负责人已准备两份同名且独立的文档草稿', function (this: SpecWorld) {
  const test = create(this);
  test.drafts = [report, { ...report, content: 'Independent report' }];
});
When('负责人将两份文档列入交付并且候选通过检查', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(delivery(test, ...test.drafts!).ok);
  review(test);
});
Then('当前交付应包含两份内容可分别查看的文档', function (this: SpecWorld) {
  const test = tests.get(this)!;
  const c = context(test);
  assert.equal(c.artifacts.length, 2);
  assert.equal(new Set(c.artifacts.map(artifact => artifact.documentId)).size, 2);
  assert.deepEqual(c.publishedDelivery?.artifactIds, c.artifacts.map(artifact => artifact.id));
  assert.deepEqual(projected(test).current.map(item => item.content), ['Original report', 'Independent report']);
});

Given('第一份候选检查失败后负责人提交了同一报告的新修订', function (this: SpecWorld) {
  const test = create(this);
  assert(delivery(test, report).ok);
  test.first = context(test).artifacts[0]!.id;
  test.priorCheck = review(test, false);
  assert(delivery(test, { ...report, content: 'Revised report', replacesArtifactId: test.first }).ok);
  test.second = context(test).artifacts[1]!.id;
  test.replacementCandidate = structuredClone(context(test));
});
When('基于原报告的另一份修订和第一份候选的检查结论分别到达', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(test.priorCheck?.criteriaResults);
  const result = event(test, { ...test.priorCheck!, resultId: 'delayed-check',
    criteriaResults: test.priorCheck.criteriaResults.map(item => ({ criterionId: item.criterionId, status: 'passed' })) });
  test.lateCheck = { result, context: structuredClone(context(test)), phase: test.service.engine.view(test.room, test.task)!.phase };
  review(test, false);
});
When('当前周期剩余的自动修订仍不能通过检查', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(event(test, { type: 'DELIVER', workId: claim(test, 'owner').id, text: 'Retain the revision', artifactIds: [test.second!] }).ok);
  test.replacementCandidate = structuredClone(context(test));
  review(test, false);
  test.failedCheck = structuredClone(context(test));
  assert(event(test, { type: 'CONTINUE' }).ok);
  test.beforeStale = structuredClone(context(test));
  test.staleResult = delivery(test, { ...report, content: 'Stale update', replacesArtifactId: test.first! });
});
Then('陈旧修订应被拒绝并保留已有候选', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.equal(test.staleResult!.ok, false);
  assert.equal(test.failedCheck!.outcome, 'partial');
  assert.equal(context(test).candidate?.revision, test.replacementCandidate!.candidate?.revision);
  assert.deepEqual(context(test).candidate, test.beforeStale!.candidate);
  assert.deepEqual(context(test).candidate?.artifactIds, [test.second]);
  assert.deepEqual(context(test).artifacts, test.replacementCandidate!.artifacts);
});
Then('第一份检查结论不应发布任何新修订', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.equal(test.lateCheck!.result.ok, false);
  assert.equal(test.lateCheck!.phase, 'checking');
  assert.equal(test.lateCheck!.context.publishedDelivery, undefined);
  assert.equal(context(test).publishedDelivery, undefined);
});
When('负责人保留新修订并通过本轮独立检查', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert(event(test, { type: 'DELIVER', workId: claim(test, 'owner').id, text: 'Retain the revision', artifactIds: [test.second!] }).ok);
  review(test);
});
Then('新修订应有自己通过的检查才可发布', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.deepEqual(context(test).publishedDelivery?.artifactIds, [test.second]);
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
  test.previousArtifacts = structuredClone(context(test).artifacts);
});
When('用户查看该任务的旧结果并继续修订其中一份', function (this: SpecWorld) {
  const test = tests.get(this)!;
  assert.deepEqual(projected(test).current.map(item => item.id), [test.first, test.second]);
  assert(event(test, { type: 'CONTINUE' }).ok);
  assert(delivery(test, { ...report, content: 'Legacy revised', replacesArtifactId: test.first! }).ok);
  test.beforeCheck = structuredClone(context(test));
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
  assert.deepEqual(test.beforeCheck!.publishedDelivery?.artifactIds, [test.first, test.second]);
  assert.deepEqual(test.beforeCheck!.artifacts.slice(0, 2), test.previousArtifacts);
  assert.deepEqual(context(test).artifacts.slice(0, 2), test.previousArtifacts);
  assert.equal(first?.documentId, undefined);
  assert.equal(sibling?.documentId, undefined);
  assert.equal(revision?.documentId, test.first);
  assert.equal(revision?.revision, 2);
  assert.equal(revision?.replacesArtifactId, test.first);
  assert.deepEqual(context(test).publishedDelivery?.artifactIds, [revision!.id]);
});

Given('第一份候选检查失败且第二份候选尚在检查中', function (this: SpecWorld) {
  const test = create(this); assert(delivery(test, report).ok); review(test, false);
  assert(delivery(test, { ...report, content: 'New independent draft' }).ok);
});
When('没有绑定检查工作的旧判断到达', function (this: SpecWorld) {
  const test = tests.get(this)!;
  test.unboundResult = event(test, { type: 'CHECK_RESULT', resultId: 'unbound-late', criteriaResults: [] });
});
Then('应拒绝该判断且第二份候选继续检查并保持未发布', function (this: SpecWorld) {
  const test = tests.get(this)!, c = context(test);
  assert.equal(test.unboundResult!.code, 'CHECK_WORK_REQUIRED');
  assert.equal(c.reply.ok, false);
  assert.equal(c.publishedDelivery, undefined);
  assert.equal(c.candidate!.text, 'Prepared the report');
  assert.equal(test.service.engine.view(test.room, test.task)!.phase, 'checking');
});
