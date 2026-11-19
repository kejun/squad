import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { publicationIds } from '../../src/task/delivery.js';
import { InputIntentFixture, intentConfig } from '../input-intent-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

const prompt = '请按给定判据交付结果。';
const delivered = '本轮交付正文与已保存的文件。';
const content = '当前交付文件正文。';
const sessions = new WeakMap<SpecWorld, ReturnType<typeof setup>>();
const session = (world: SpecWorld) => sessions.get(world)!;

function setup(world: SpecWorld, criteria: string[]) {
  const fixture = new InputIntentFixture(intentConfig({ checks: 4, retries: 1 }), true);
  assert(fixture.submit(prompt, { goal: { text: prompt, criteria, constraints: [], requiredArtifacts: 1 } }).ok);
  assert(fixture.event({ type: 'DELIVER', text: delivered, artifactIds: [], artifacts: [{ name: 'delivery.md', content }] }).ok);
  const candidate = structuredClone(fixture.context().candidate!);
  const state = { fixture, candidate, omitted: candidate.acceptance!.criteria.at(-1)! };
  sessions.set(world, state);
  return state;
}

async function rejectBoth(fixture: InputIntentFixture) {
  let request = 0;
  fixture.response = work => {
    assert.equal(work.kind, 'check');
    const requirements = work.context.requirements as { id: string }[];
    return modelResponse(request++ === 0 ? { type: 'answer', text: '不应保存的被拒回复' }
      : { type: 'check', criteriaResults: requirements.slice(0, -1).map(({ id }) => ({ criterionId: id, status: 'passed' })) });
  };
  assert(await fixture.run());
  assert.equal(fixture.view().phase, 'checking');
  assert(await fixture.run());
  assert.equal(request, 2);
}

const notice = (fixture: InputIntentFixture) => fixture.context().messages.filter(item => item.kind === 'notice' && item.text.includes('是否重试')).at(-1);

After(function (this: SpecWorld) { sessions.get(this)?.fixture.close(); });

Given('主笔交回了包含十七条判据的固定交付', function (this: SpecWorld) {
  const { candidate } = setup(this, Array.from({ length: 16 }, (_, index) => `核对第 ${index + 1} 项`));
  assert.equal(candidate.acceptance!.criteria.length, 17);
});

Given('主笔交回了可发布的固定交付', function (this: SpecWorld) { setup(this, ['保存实际退出码']); });

When('核检首轮返回错误类型且技术补试漏掉一条判据', async function (this: SpecWorld) { await rejectBoth(session(this).fixture); });

When('核检员指出一条判据未通过', async function (this: SpecWorld) {
  const { fixture } = session(this);
  fixture.response = work => modelResponse({ type: 'check', criteriaResults: (work.context.requirements as { id: string }[]).map(({ id }, index) => index === 0
    ? { criterionId: id, status: 'failed', reason: '没有取得命令退出码' } : { criterionId: id, status: 'passed' }) });
  assert(await fixture.run());
});

Then('应发布原交付并将任务标记为完成', function (this: SpecWorld) {
  const { fixture, candidate } = session(this);
  assert.equal(fixture.view().phase, 'ended');
  assert.equal(fixture.context().outcome, 'complete');
  assert.equal(fixture.context().publishedDelivery?.revision, candidate.revision);
  assert.deepEqual(publicationIds(fixture.context()), candidate.artifactIds);
  assert(fixture.context().messages.some(item => item.kind === 'final' && (item.detailText ?? item.text).includes(delivered)));
});

Then('核检员应报告两次失败及漏掉的判据并询问是否重试', function (this: SpecWorld) {
  const { fixture, omitted } = session(this);
  fixture.reopen();
  const message = notice(fixture);
  assert(message && message.author === 'facilitator');
  assert.match(message.detailText ?? message.text, /第 1 次.*类型错误/s);
  assert((message.detailText ?? message.text).includes(`第 2 次：漏核判据：${omitted.text}`));
  assert(fixture.context().intents.filter(item => item.kind === 'check').some(item => item.checkDiagnostics?.some(record =>
    record.diagnostic.missingCriterionIds?.includes(omitted.id))));
  assert(!JSON.stringify(fixture.context()).includes('不应保存的被拒回复'));
});

Then('核检员应说明该问题并询问是否重试', function (this: SpecWorld) {
  const message = notice(session(this).fixture);
  assert(message && (message.detailText ?? message.text).includes('没有取得命令退出码'));
});

Given('检查未完成的交付已经发布且还有检查额度', async function (this: SpecWorld) {
  const { fixture } = setup(this, ['保存实际退出码']);
  await rejectBoth(fixture);
  assert.equal(fixture.context().outcome, 'complete');
});

When('用户回复「重试检查」且同一命令被重复提交', async function (this: SpecWorld) {
  const { fixture, candidate } = session(this);
  fixture.now += 4 * 60 * 60 * 1000;
  const input = { id: 'retry-advisory-check', text: '重试检查' };
  assert(fixture.engine.submit(fixture.room, input).ok);
  assert(fixture.engine.submit(fixture.room, input).duplicate);
  assert.equal(fixture.view().phase, 'checking');
  assert.deepEqual(publicationIds(fixture.context()), candidate.artifactIds);
  fixture.response = work => {
    assert.equal(work.kind, 'check');
    assert.deepEqual(work.context.requirements, candidate.acceptance!.criteria);
    assert.deepEqual(work.context.candidate, { revision: candidate.revision, text: delivered });
    return modelResponse({ type: 'check', criteriaResults: candidate.acceptance!.criteria.map(({ id }) => ({ criterionId: id, status: 'passed' })) });
  };
  assert(await fixture.run());
});

Then('只应核检原交付和判据一次并保存新结论', function (this: SpecWorld) {
  const { fixture } = session(this);
  const context = fixture.context();
  assert.equal(context.outcome, 'complete');
  assert.equal(context.usage.checks, 3);
  assert.equal(fixture.requests.length, 3);
  assert.equal(context.intents.filter(item => item.kind === 'owner').length, 1);
  assert(context.messages.some(item => item.text.includes('重试检查已通过')));
  assert.equal(context.candidate?.deliveryIssue, undefined);
});

Then('已发布的正文和文件始终可以访问', function (this: SpecWorld) {
  const { fixture, candidate } = session(this);
  assert.deepEqual(publicationIds(fixture.context()), candidate.artifactIds);
  assert.equal(fixture.context().artifacts.find(item => item.id === candidate.artifactIds[0])?.content, content);
  assert.equal(fixture.context().messages.filter(item => item.kind === 'final').length, 1);
});
