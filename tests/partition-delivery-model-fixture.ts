import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { Intent, TaskInput } from '../src/types.js';
import type { ResourceIdentity } from '../src/resource-acquisition.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';
export const childAcquisitionStatement = '已抓取该来源，以下为子Agent交付正文';

export function evidencePartitionPreparation(kind = 'URL') {
  const resource: ResourceIdentity = kind === '文档'
    ? { kind: 'document', service: 'yuque', namespace: 'team/book', id: 'doc-1' }
    : kind === '文件' ? { kind: 'file', workspaceId: 'project', path: 'docs/source.md', revision: 'r1' }
      : { kind: 'url', url: 'https://docs.example.com/doc-1' };
  const model = new ResilientPartitionModel((input: TaskInput) => {
    if (kind !== 'URL') {
      input.goal.text = '按照宿主映射分别读取资源并保留出处'; input.message.text = input.goal.text;
      input.goal.partitionResources = { 'part-1': [resource] };
    }
  });
  const initial = model.pending('assistance').map(work => model.start(work));
  return { model, initial, resource, work: initial.find(work => (work.payload.partition as { id: string }).id === 'part-1')! };
}
export function reportChildSuccess(model: ResilientPartitionModel, work: Intent) {
  const reply = model.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    attempt: work.attempt, fence: work, status: 'success', text: childAcquisitionStatement });
  assert(reply.ok, reply.code);
}
export function assertDirectPartition(model: ResilientPartitionModel, work: Intent, _resource: ResourceIdentity) {
  const part = model.queue.find(item => item.partitionId === (work.payload.partition as { id: string }).id)!;
  const result = model.context.discussion!.results.find(item => item.workId === work.id)!;
  assert.equal(part.status, 'succeeded'); assert.equal(result.status, 'success');
  assert.equal(result.answer, childAcquisitionStatement);
  assert(!Reflect.has(result, 'missingResources')); assert(!Reflect.has(result, 'resourceSources'));
  return result;
}
export function directPartitionGate(kind = 'URL') {
  const scenario = evidencePartitionPreparation(kind);
  reportChildSuccess(scenario.model, scenario.work);
  return { ...scenario, result: assertDirectPartition(scenario.model, scenario.work, scenario.resource) };
}

export function reasoningPartitionPreparation() {
  const model = new CapacityModel(input => {
    input.message.text = '分别推理并比较上下文已有的四个方案'; input.goal.text = input.message.text;
  });
  model.claim(); model.consume();
  const spec = capacityModelIntent(); spec.decomposition!.partitions = Array.from({ length: 4 }, (_, index) => ({
    id: `reason-${index + 1}`, objective: `推理已有方案${index + 1}的取舍`, expectedOutput: '已有上下文中的推理结果' }));
  assert(model.interpret(spec).ok);
  const pending = model.pending('assistance')[0]!; assert(model.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const work = model.context.intents.find(item => item.id === pending.id)!;
  return { model, work };
}

export function reasoningPartitionGate() {
  const { model, work } = reasoningPartitionPreparation();
  assert(model.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    attempt: work.attempt, fence: work, status: 'success', text: '基于已有上下文推导的完整结果' }).ok);
  assert.equal(model.context.discussion!.mapReduce!.queue![0]!.status, 'succeeded');
  assert.equal(work.localOperations?.length ?? 0, 0);
  return model;
}

export function partitionDeliveryModelGate() {
  for (const kind of ['URL', '文档', '文件']) directPartitionGate(kind);
  reasoningPartitionGate(); return { paths: 4, model: 'real taskMachine', scope: 'Child delivery is accepted without acquisition checks' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(partitionDeliveryModelGate()));
