import assert from 'node:assert/strict';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { LocalModel } from './local-model-fixture.js';
import type { Intent } from '../src/types.js';

export function revisionModel(gaps = 1, boundary = '') {
  const m = new LocalModel(input => {
    input.goal.criteria = ['校验一', '校验二', '校验三'];
    if (boundary === '检查总额度仅剩本次') input.config.limits.checks = 1;
  });
  return { m, gaps, boundary };
}
export type RevisionRun = ReturnType<typeof revisionModel>;
function claim(m: LocalModel, kind: Intent['kind']) {
  const pending = m.c.intents.find(work => work.kind === kind && work.status === 'pending');
  assert(pending, `Expected pending ${kind}`);
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const work = m.c.intents.find(work => work.id === pending.id)!;
  if (kind === 'check') assert(m.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok);
  return m.c.intents.find(work => work.id === pending.id)!;
}
function submit(run: RevisionRun, work = run.m.work) {
  assert(run.m.send({ type: 'DELIVER', workId: work.id, fence: work, attempt: work.attempt,
    text: `候选${run.m.seq}`, artifactIds: [] }).ok);
  return claim(run.m, 'check');
}
function result(run: RevisionRun, work: Intent, passed = false) {
  return { type: 'CHECK_RESULT', workId: work.id, fence: work, attempt: work.attempt,
    resultId: `${work.id}:result`, candidateRevision: run.m.c.candidate!.revision,
    criteriaResults: run.m.c.candidate!.acceptance!.criteria.map((criterion, index) => ({ criterionId: criterion.id,
      status: !passed && index < run.gaps ? run.boundary === '来源无法核实' ? 'unverified' : 'failed' : 'passed',
      ...(!passed && index < run.gaps ? { reason: `缺口${index + 1}` } : {}) })) };
}
function fail(run: RevisionRun) {
  const work = submit(run, run.m.c.candidate ? claim(run.m, 'owner') : run.m.work);
  const receipt = result(run, work);
  assert(run.m.send(receipt).ok);
  return receipt;
}
export function twoRevisionsComplete(run: RevisionRun) {
  fail(run); fail(run);
  assert.deepEqual(run.m.c.deliveryCycle?.revisions, { used: 2, limit: 2 });
  const check = submit(run, claim(run.m, 'owner'));
  assert(run.m.send(result(run, check, true)).ok);
  assert.equal(run.m.c.outcome, 'complete');
  assert.equal(run.m.c.publishedDelivery?.revision, run.m.c.candidate!.revision);
  assert.equal(run.m.c.usage.checks, 3);
  assert.equal(run.m.c.intents.filter(work => work.payload.deliveryRevision).length, 2);
}
export function threeRevisionsExhaust(run: RevisionRun) {
  fail(run); fail(run); fail(run); fail(run);
  assert.deepEqual(run.m.c.deliveryCycle?.revisions, { used: 3, limit: 3 });
  assert.equal(run.m.c.outcome, 'partial');
  assert.equal(run.m.c.usage.checks, 4);
  assert.equal(run.m.c.publishedDelivery, undefined);
  assert(!run.m.c.intents.some(work => work.kind === 'owner' && work.status === 'pending'));
  assert.equal(run.m.c.intents.filter(work => work.criteriaResults).at(-1)?.criteriaResults?.filter(item => item.status === 'failed').length, 3);
}
export function revisionBoundary(run: RevisionRun) {
  const work = submit(run);
  if (run.boundary === '普通请求额度耗尽') run.m.c.config.limits.ordinary = run.m.c.usage.ordinary;
  assert(run.m.send(result(run, work)).ok);
  assert.equal(run.m.c.outcome, 'partial');
  assert(!run.m.c.intents.some(work => work.payload.deliveryRevision));
  assert.equal(run.m.c.intents.find(item => item.id === work.id)?.criteriaResults?.[0]?.reason, '缺口1');
}
export function secondRevisionPrepared() {
  const run = revisionModel(); fail(run);
  const receipt = fail(run);
  return { ...run, receipt };
}
export function repeatAfterRestart(run: ReturnType<typeof secondRevisionPrepared>) {
  run.m.snapshot = restoreTask(JSON.parse(JSON.stringify(persistTask(run.m.snapshot))));
  assert.equal(run.m.send(run.receipt).ok, false);
  assert.deepEqual(run.m.c.deliveryCycle?.revisions, { used: 2, limit: 2 });
  assert.equal(run.m.c.intents.filter(work => work.payload.deliveryRevision && work.status === 'pending').length, 1);
}
export function legacyRevision() {
  const run = revisionModel(); fail(run);
  const check = submit(run, claim(run.m, 'owner'));
  const saved = JSON.parse(JSON.stringify(persistTask(run.m.snapshot)));
  delete saved.context.deliveryCycle.revisions;
  run.m.snapshot = restoreTask(saved);
  assert(run.m.send(result(run, check)).ok);
  assert.equal(run.m.c.outcome, 'partial');
  assert.equal(run.m.c.intents.filter(work => work.payload.deliveryRevision).length, 1);
  return run;
}
if (process.argv[1]?.endsWith('adaptive-revision-fixture.ts')) {
  twoRevisionsComplete(revisionModel());
  threeRevisionsExhaust(revisionModel(3));
  for (const boundary of ['检查总额度仅剩本次', '普通请求额度耗尽', '来源无法核实']) revisionBoundary(revisionModel(1, boundary));
  repeatAfterRestart(secondRevisionPrepared()); legacyRevision();
  console.log('KEJ-110 adaptive revisions: 7 model paths passed (snapshot round trip each event)');
}
