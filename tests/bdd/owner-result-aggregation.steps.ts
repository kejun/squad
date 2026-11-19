import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { OwnerAggregationFixture, receiptMessages, type ArtifactRef, type Group } from '../owner-result-aggregation-fixture.js';
import { rawMarker } from '../owner-result-aggregation-model-fixture.js';
import type { SpecWorld } from './steps.js';

const fixtures = new WeakMap<SpecWorld, OwnerAggregationFixture>();
const fixture = (world: SpecWorld) => fixtures.get(world)!;

async function prepare(world: SpecWorld, variant?: string, limit?: string) {
  const current = new OwnerAggregationFixture(variant, limit);
  fixtures.set(world, current);
  await current.prepareResults();
  return current;
}

After(async function (this: SpecWorld) { await fixtures.get(this)?.dispose(); });

Given(/^当前任务已完成具备并行余量的「(.+)」分片$/, async function (this: SpecWorld, variant: string) {
  const current = await prepare(this, variant);
  const groups = current.pending('assistance');
  assert.equal(groups.length, 2);
  assert.equal(new Set(groups.map(work => work.target)).size, 2);
  assert(groups.every(work => work.payload.resultAggregation === 'group'));
});

When('系统归并这些结果并交给主笔', async function (this: SpecWorld) { await fixture(this).resolveGroups(); });

Then('应只派发一次主笔并提供组成果完整判据和原始来源引用', function (this: SpecWorld) {
  const current = fixture(this);
  const context = current.context();
  const owners = context.intents.filter(work => work.kind === 'owner');
  assert.equal(owners.length, 1);
  assert.equal(owners[0]!.target, context.owner);
  assert(!context.intents.some(work => work.kind === 'discussionSummary'));
  const request = current.requests.find(item => item.kind === 'owner')!.context;
  assert.equal(request.resultAggregation, 'owner');
  const criteria = request.acceptanceCriteria as { text: string }[];
  assert(criteria.some(item => JSON.stringify(item).includes('分别说明成本与恢复风险')));
  const groups = request.groups as Group[];
  assert.equal(groups.length, 2);
  assert(groups.every(group => group.status === 'succeeded' && group.content && group.artifactId));
  const originals = groups.flatMap(group => group.sources);
  const results = context.discussion!.results;
  assert.equal(originals.length, 2);
  assert(originals.every(source => results.some(result => result.id === source.resultRef)
    && source.artifactIds.length > 0 && source.artifactIds.every(id => context.artifacts.some(artifact => artifact.id === id))));
  if (current.variant === '保留分歧的方案评审') {
    assert((request.partitions as { id: string; status: string }[]).some(item => item.id === 'beta' && item.status === 'partial'));
  }
  assert.equal((context.intents.find(work => work.kind === 'check')!.payload.reviewRecords as unknown[]).length, 2);
});

Then('组材料及主笔首轮均应有界且原始材料仍可核对', function (this: SpecWorld) {
  const current = fixture(this);
  const groupRequests = current.requests.filter(request => request.context.resultAggregation === 'group');
  const groupRequestsBySource = new Map(groupRequests.map(request => [(request.context.sources as Group['sources'])[0]!.resultRef, request]));
  assert.equal(groupRequestsBySource.size, 2);
  for (const request of groupRequestsBySource.values()) {
    const sourceIds = (request.context.sources as Group['sources']).flatMap(source => source.artifactIds);
    assert.deepEqual((request.context.artifacts as ArtifactRef[]).map(artifact => artifact.id), sourceIds);
    assert(!request.context.discussion);
    assert(Buffer.byteLength(JSON.stringify(request.context)) < 16_000);
  }
  const owner = current.requests.find(request => request.kind === 'owner')!;
  assert(!owner.messages.some(message => message.content.includes(rawMarker)));
  assert(!owner.context.discussion && !owner.context.messages);
  assert(!owner.context.evidenceIndex);
  assert(Buffer.byteLength(JSON.stringify(owner.context)) < 24_000);
  if (current.variant === '含执行凭证的工程交付') {
    assert.equal(current.backend.calls.length, 1);
    const receipts = current.context().intents.flatMap(work => work.localOperations ?? []);
    assert(receipts.some(op => op.action.type === 'runCli' && op.result?.data.stdout === 'ORIGINAL_COMMAND_RECEIPT\n'));
    assert(current.requests.filter(request => request.kind === 'owner').some(request => receiptMessages(request, 'EVIDENCE_PAGE')
      .some(page => page.text === 'ORIGINAL_COMMAND_RECEIPT\n')));
    assert(groupRequests.some(request => receiptMessages(request, 'ARTIFACT_PAGE').some(page => page.text.includes('END_OF_LONG_PARTITION'))));
  }
});

Given(/^当前已结算的分片具备「(.+)」$/, async function (this: SpecWorld, limit: string) { await prepare(this, undefined, limit); });

When('宿主为主笔选择归并路径', async function (this: SpecWorld) {
  const current = fixture(this);
  const summary = current.pending('discussionSummary');
  assert.equal(summary.length, 1);
  assert(await current.run(summary[0]!.id));
});

Then('应通过原交接保留全部结果且不派发树形归并组', function (this: SpecWorld) {
  const current = fixture(this);
  assert(!current.context().intents.some(work => work.payload.resultAggregation));
  const owner = current.pending('owner');
  assert.equal(owner.length, 1);
  const results = (owner[0]!.payload.discussion as { results: { answer: string }[] }).results;
  assert.equal(results.length, 2);
  assert(results.every(result => result.answer.includes(current.limit === '短答复' ? '短结果' : rawMarker)));
});

Given('并行归并中已经保存一个组的成果', async function (this: SpecWorld) {
  const current = await prepare(this);
  await current.prepareInterruptedGroup();
  assert.equal(current.context().artifacts.filter(artifact => artifact.name === 'group-result.md').length, 1);
});

When('服务重启且剩余组失败并收到重复结果', async function (this: SpecWorld) { await fixture(this).reopenAfterInterruption(); });

Then('主笔应只收到一次交接并可查阅失败组的原始资料和缺口', function (this: SpecWorld) {
  const current = fixture(this);
  const context = current.context();
  assert.equal(context.intents.filter(work => work.kind === 'owner').length, 1);
  assert.equal(context.artifacts.filter(artifact => artifact.name === 'group-result.md').length, 1);
  const requests = current.requests.filter(request => request.kind === 'owner');
  const failed = (requests[0]!.context.groups as Group[]).find(group => group.status === 'failed');
  assert(failed?.reason?.includes('AGGREGATION_READ_ONLY') && !failed.content);
  assert.equal(current.backend.calls.length, 0);
  const id = failed.sources[0]!.artifactIds[0];
  assert(requests.some(request => receiptMessages(request, 'ARTIFACT_PAGE').some(page => page.artifact.artifactId === id && page.text.includes(rawMarker))));
});

Given('当前有一个进行中的结果聚合组', async function (this: SpecWorld) {
  const current = await prepare(this);
  current.interrupted = current.engine.claim(current.room, current.task, current.pending('assistance')[0]!.id)!;
  assert.equal(current.interrupted.payload.resultAggregation, 'group');
});

When(/^用户「(.+)」后旧组迟到返回$/, function (this: SpecWorld, change: string) {
  const current = fixture(this);
  assert(current.event(change === '停止' ? { type: 'STOP' }
    : { type: 'USER_INPUT', text: '新目标', goal: { ...current.context().goal, text: '新目标' } }).ok);
  assert(!current.staleResult(current.interrupted!).ok);
});

Then('旧组不得保存新产物或再次派发主笔', function (this: SpecWorld) {
  const context = fixture(this).context();
  assert(!context.intents.some(work => work.kind === 'owner' && work.payload.resultAggregation));
  assert(!context.artifacts.some(artifact => artifact.name === 'group-result.md'));
});
