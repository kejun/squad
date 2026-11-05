import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { LocalFixture } from '../local-tools-fixture.js';
import type { SpecWorld } from './steps.js';

type ReadFixture = { local: LocalFixture; original: string; revision: string; ordinary: number };
const fixtures = new WeakMap<SpecWorld, ReadFixture>();

After(async function (this: SpecWorld) { await fixtures.get(this)?.local.close(); });

Given('当前检查候选包含修订后的报告并且原报告仍保留在任务历史中', async function (this: SpecWorld) {
  const local = await LocalFixture.create();
  const h = local.h;
  const originalWork = h.claim('owner');
  assert(h.event({ type: 'DELIVER', workId: originalWork.id, text: 'Original', artifactIds: [],
    artifacts: [{ name: 'report.md', content: 'Original saved report' }] }).ok);
  const original = h.context().candidate!.artifactIds[0]!;
  const check = h.claim('check');
  assert(h.event({ type: 'CHECK_RESULT', workId: check.id, passed: false, gaps: ['Revise'], resultId: 'original-check' }).ok);
  const coordinator = h.claim('facilitator');
  assert(h.event({ type: 'COORDINATE', workId: coordinator.id, decision: { action: 'continue', reason: 'Revise' } }).ok);
  const revisionWork = h.claim('owner');
  assert(h.event({ type: 'DELIVER', workId: revisionWork.id, text: 'Revised', artifactIds: [],
    artifacts: [{ name: 'report.md', content: 'Revised saved report', replacesArtifactId: original }] }).ok);
  fixtures.set(this, { local, original, revision: h.context().candidate!.revision!, ordinary: h.context().usage.ordinary });
});
When('检查员按原报告的产物引用查读正文', async function (this: SpecWorld) {
  const { local, original } = fixtures.get(this)!;
  local.replies.push({ type: 'readArtifact', artifactId: original }, { type: 'readArtifact', artifactId: 'other-task:artifact' },
    { type: 'check', passed: true, gaps: [] });
  assert(await local.runner().runOne(local.h.room, local.h.task));
});
Then('应返回保存的原报告并保留当前候选版本', function (this: SpecWorld) {
  const { local, revision } = fixtures.get(this)!;
  const c = local.h.context();
  const read = c.intents.flatMap(work => work.localOperations ?? []).find(operation => operation.action.type === 'readArtifact');
  assert.equal(read?.result?.data.text, 'Original saved report');
  assert.equal(c.publishedDelivery?.revision, revision);
  const contextMessage = JSON.parse(local.requests[0]!.messages[1]!.content);
  assert(!contextMessage.context.artifacts.some((item: { content: string }) => item.content === 'Original saved report'));
});
Then('读取应使用本地读取额度并拒绝其他任务的产物引用', function (this: SpecWorld) {
  const { local, ordinary } = fixtures.get(this)!;
  const c = local.h.context();
  assert.equal(c.usage.ordinary, ordinary + 1);
  assert.equal(c.intents.flatMap(work => work.localOperations ?? []).at(-1)?.result?.code, 'ARTIFACT_UNAVAILABLE');
  assert.equal(local.backend.calls.length, 0);
});
