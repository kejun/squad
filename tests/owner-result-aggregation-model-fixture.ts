import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { persistTask, restoreTask } from '../src/task.machine.js';
import type { ArtifactDraft, Intent } from '../src/types.js';
import { MapModel, modelMapIntent } from './map-model-gate-fixture.js';

export const rawMarker = 'SOURCE_BODY_ONLY';
export function finishPartition(model: MapModel, work: Intent, text: string, status: 'success' | 'partial' | 'failed' = 'success', artifacts?: ArtifactDraft[]) {
  return model.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, attempt: work.attempt, fence: work,
    text, status, ...(artifacts ? { artifacts } : {}) });
}

export function settledMap(variant = '多来源调研', limit?: string) {
  const model = new MapModel(input => {
    input.config.limits.assists = 20;
    if (limit === '只有一名空闲成员') input.config.bots = input.config.bots.slice(0, 2);
    if (limit === '普通额度仅够原交接') input.config.limits.ordinary = 5;
  });
  const plan = modelMapIntent();
  plan.decomposition!.partitions[0]!.objective = `${variant}一`;
  plan.decomposition!.partitions[1]!.objective = `${variant}二`;
  model.interpret(plan);
  for (let index = 0; index < 2; index++) {
    const work = model.claim(model.pending('assistance')[0]!);
    const body = limit === '短答复' ? '短结果' : rawMarker + 'x'.repeat(index ? 6800 : 9200);
    const documents = variant === '含执行凭证的工程交付' ? [{ name: 'receipt.json', content: body }, { name: 'notes.txt', content: '实际 stdout 与来源' }] : undefined;
    assert(finishPartition(model, work, documents ? '依据见凭证' : body, variant === '保留分歧的方案评审' && index === 1 ? 'partial' : 'success', documents).ok);
  }
  return model;
}

function assertOwner(model: MapModel) {
  assert.equal(model.pending('discussionSummary').length, 0);
  assert.equal(model.pending('owner').length, 1);
  const work = model.pending('owner')[0]!;
  assert.equal(work.target, model.context.owner);
  assert.equal(work.payload.resultAggregation, 'owner');
  assert(!JSON.stringify(work.payload).includes(rawMarker));
  return work;
}

export function ownerAggregationModelGate() {
  for (const variant of ['多来源调研', '保留分歧的方案评审', '含执行凭证的工程交付']) {
    const model = settledMap(variant);
    const groups = model.pending('assistance');
    assert.equal(groups.length, 2);
    const originals = model.context.discussion!.results.map(result => result.id);
    for (const group of groups.map(group => model.claim(group))) {
      assert.equal(group.payload.resultAggregation, 'group');
      assert.equal((group.payload.sources as unknown[]).length, 1);
      assert(!group.payload.discussion);
      assert(finishPartition(model, group, '组事实和冲突说明').ok);
    }
    const owner = assertOwner(model);
    const parts = owner.payload.partitions as { resultRef: string }[];
    assert.deepEqual(parts.map(item => item.resultRef), originals);
    if (variant === '保留分歧的方案评审') assert((owner.payload.partitions as { status: string }[]).some(part => part.status === 'partial'));
    const assigned = model.claim(owner);
    assert(model.send({ type: 'DELIVER', workId: assigned.id, fence: assigned, attempt: assigned.attempt, text: '核对后交付', artifactIds: [] }).ok);
    assert.equal((model.pending('check')[0]!.payload.reviewRecords as unknown[]).length, 2);
  }
  for (const limit of ['短答复', '只有一名空闲成员', '普通额度仅够原交接']) {
    const model = settledMap('多来源调研', limit);
    assert.equal(model.pending('discussionSummary').length, 1);
    assert.equal(model.context.discussion!.mapReduce!.resultAggregation, undefined);
    assert.equal(model.context.discussion!.results.length, 2);
  }
  const restored = settledMap();
  const first = restored.claim(restored.pending('assistance')[0]!);
  const interrupted = restored.claim(restored.pending('assistance')[0]!);
  assert.equal(restored.send({ type: 'LOCAL_REQUEST', intentId: interrupted.id, parentAttempt: interrupted.attempt, fence: interrupted,
    operationId: 'unexpected-command', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), messages: [],
    action: { type: 'runCli', executable: 'node', args: ['--version'] } }).code, 'AGGREGATION_READ_ONLY');
  assert(finishPartition(restored, first, '重启前已保存').ok);
  restored.snapshot = restoreTask(persistTask(restored.snapshot));
  assert(restored.send({ type: 'RECOVER', config: restored.context.config }).ok);
  assert.equal(restored.pending('assistance').length, 1);
  const next = restored.claim(restored.pending('assistance')[0]!);
  assert.equal(next.id, interrupted.id);
  assert(!finishPartition(restored, interrupted, '迟到结果').ok);
  assert(finishPartition(restored, next, '组失败', 'failed').ok);
  assert(!finishPartition(restored, next, '重复结果').ok);
  const owner = assertOwner(restored);
  assert((owner.payload.groups as { status: string; sources: unknown[]; content?: string }[])
    .some(group => group.status === 'failed' && group.sources.length && !group.content));
  assert.equal(restored.context.artifacts.filter(item => item.name === 'group-result.md').length, 1);

  for (const change of ['停止', '变更目标']) {
    const model = settledMap();
    const group = model.claim(model.pending('assistance')[0]!);
    assert(model.send(change === '停止' ? { type: 'STOP' } : { type: 'USER_INPUT', text: '新目标', goal: { ...model.context.goal, text: '新目标' } }).ok);
    assert(!finishPartition(model, group, '不得保存的旧结果').ok);
    assert(!model.context.artifacts.some(item => item.name === 'group-result.md'));
    assert(!model.pending('owner').some(item => item.payload.resultAggregation));
  }
  return { sources: 3, fallbacks: 3, recovery: 1, stale: 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(ownerAggregationModelGate()));
