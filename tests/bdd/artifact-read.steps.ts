import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { LocalFixture } from '../local-tools-fixture.js';
import { candidateJudgments } from '../helpers.js';
import type { SpecWorld } from './steps.js';

type ReadFixture = { local: LocalFixture; original: string; revision: string; ordinary: number };
const fixtures = new WeakMap<SpecWorld, ReadFixture>();
const originalBody = 'Original saved report';
const foreignBody = 'Unrelated artifact from another task';

After(async function (this: SpecWorld) { await fixtures.get(this)?.local.close(); });

Given('当前候选修订了同目标的报告且原报告仍保留在任务历史中', async function (this: SpecWorld) {
  const local = await LocalFixture.create();
  const h = local.h;
  const owner = h.claim('owner');
  assert(h.event({ type: 'DELIVER', workId: owner.id, text: 'Original', artifactIds: [],
    artifacts: [{ name: 'report.md', content: originalBody }] }).ok);
  const original = h.context().candidate!.artifactIds[0]!;
  const check = h.authorizeCheck();
  assert(h.checkResult(check, candidateJudgments(h.context().candidate, { index: 0, status: 'failed', reason: 'Revise the report' })).ok);
  const revisionWork = h.claim('owner');
  assert(h.event({ type: 'DELIVER', workId: revisionWork.id, text: 'Revised', artifactIds: [],
    artifacts: [{ name: 'report.md', content: 'Revised saved report', replacesArtifactId: original }] }).ok);

  const foreign = h.engine.submit('foreign-room', { id: 'foreign-request', text: 'another request' });
  assert(foreign.ok && foreign.taskId);
  assert(h.engine.send('foreign-room', foreign.taskId, { type: 'ARTIFACT', id: 'foreign-artifact', at: h.now,
    artifact: { id: 'foreign:report', name: 'unrelated.md', content: foreignBody } }).ok);
  fixtures.set(this, { local, original, revision: h.context().candidate!.revision!, ordinary: h.context().usage.ordinary });
});
When('系统为独立检查准备修订和原报告的对照材料', async function (this: SpecWorld) {
  const { local } = fixtures.get(this)!;
  local.replies.push({ type: 'check', criteriaResults: candidateJudgments(local.h.context().candidate) });
  assert(await local.runner().runOne(local.h.room, local.h.task));
});
Then('应提供一次原报告正文并保留当前候选版本', function (this: SpecWorld) {
  const { local, original, revision } = fixtures.get(this)!;
  const c = local.h.context();
  const context = JSON.parse(local.requests[0]!.messages[1]!.content).context;
  const originalReport = context.artifacts.filter((item: { id: string; content: string }) => item.id === original && item.content === originalBody);
  assert.equal(originalReport.length, 1);
  assert.equal(c.publishedDelivery?.revision, revision);
});
Then('材料不应包含其他任务的产物，且不产生模型发起的读取或读取额度消耗', function (this: SpecWorld) {
  const { local, ordinary } = fixtures.get(this)!;
  const c = local.h.context();
  assert(!JSON.stringify(local.requests).includes(foreignBody));
  assert.equal(c.usage.ordinary, ordinary);
  assert(!c.intents.some(work => work.localOperations?.some(operation => operation.action.type === 'readArtifact')));
  assert.equal(local.backend.calls.length, 0);
});
