import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { DiscussionRound, Intent, TaskInput } from '../src/types.js';
import type { ResourceIdentity } from '../src/resource-acquisition.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';

type SourceReference = { acquisitionId: string; operationId: string; workId: string; attempt: number; at: number; reused: boolean };
type ResourceResult = DiscussionRound['results'][number] & {
  reportedStatus?: DiscussionRound['results'][number]['status']; missingResources?: ResourceIdentity[]; resourceSources?: SourceReference[];
};
export const untrustedAcquisitionClaim = '已抓取该来源，HTTP 200、242 字符；以下为模型自述';

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
export function reportUnverifiedSuccess(model: ResilientPartitionModel, work: Intent) {
  const reply = model.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    attempt: work.attempt, fence: work, status: 'success', text: untrustedAcquisitionClaim });
  assert(reply.ok, reply.code);
}
export function assertUnverifiedPartition(model: ResilientPartitionModel, work: Intent, resource: ResourceIdentity) {
  const part = model.queue.find(item => item.partitionId === (work.payload.partition as { id: string }).id)!;
  const result = model.context.discussion!.results.find(item => item.workId === work.id)! as ResourceResult;
  assert.equal(part.status, 'partial', 'A resource-dependent partition must not trust a model-only success claim');
  assert.equal(part.reason, 'RESOURCE_ACQUISITION_UNVERIFIED');
  assert.equal(result.status, 'partial'); assert.equal(result.reportedStatus, 'success');
  assert.equal(result.answer, untrustedAcquisitionClaim); assert.deepEqual(result.missingResources, [resource]);
  return result;
}
export function unverifiedPartitionGate(kind = 'URL') {
  const scenario = evidencePartitionPreparation(kind);
  reportUnverifiedSuccess(scenario.model, scenario.work);
  const result = assertUnverifiedPartition(scenario.model, scenario.work, scenario.resource);
  return { ...scenario, result };
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

export function reusedAcquisitionPartitionGate() {
  const scenario = evidencePartitionPreparation(), { model, initial, resource, work } = scenario;
  assert.equal(resource.kind, 'url');
  const source = initial.find(item => item.target === 'C')!;
  const receipt = model.acquire(source, resource.kind === 'url' ? resource.url : '', '可信已有来源正文', false);
  reportUnverifiedSuccess(model, work);
  const part = model.queue.find(item => item.workId === work.id)!;
  const result = model.context.discussion!.results.find(item => item.workId === work.id)! as ResourceResult;
  assert.equal(part.status, 'succeeded');
  assert(result.resourceSources?.some(reference => reference.acquisitionId === receipt.id && reference.workId === source.id
    && reference.attempt === receipt.attempt && reference.at === receipt.at && reference.reused));
  return { ...scenario, receipt, result };
}

export function unverifiedPartitionRecoveryGate() {
  const scenario = unverifiedPartitionGate(), { model, initial, resource, work } = scenario;
  const original = structuredClone(model.context.discussion!.results.find(item => item.workId === work.id)!);
  const source = initial.find(item => item.target === 'C')!;
  const receipt = model.acquire(source, resource.kind === 'url' ? resource.url : '', '后续可信来源正文', false);
  assert.equal(model.context.usage.retries, 1);
  assert.deepEqual(model.context.discussion!.results.find(item => item.workId === work.id), original);
  const firstGap = model.queue.find(part => part.partitionId === 'part-1')!;
  assert.equal(firstGap.reason, 'VERIFIED_METHOD_AVAILABLE');
  const occupied = model.pending('assistance').find(item => item.target === 'B' && item.payload.partitionAttempt === 1)!;
  assert(occupied); model.fail(model.start(occupied), false);
  const retry = model.start(model.pending('assistance').find(item => (item.payload.partition as { id: string }).id === 'part-1')!);
  reportUnverifiedSuccess(model, retry);
  const completed = model.queue.find(part => part.workId === retry.id)!;
  assert.equal(completed.status, 'succeeded', 'A saved trusted source may be reused without pretending another acquisition occurred');
  const result = model.context.discussion!.results.find(item => item.workId === retry.id)! as ResourceResult;
  assert(result.resourceSources?.some(reference => reference.acquisitionId === receipt.id && reference.reused));
  assert.equal(model.context.usage.retries, 1);
  return { ...scenario, receipt, result };
}

export function partitionEvidenceModelGate() {
  for (const kind of ['URL', '文档', '文件']) unverifiedPartitionGate(kind);
  reasoningPartitionGate(); reusedAcquisitionPartitionGate(); unverifiedPartitionRecoveryGate();
  return { paths: 6, model: 'real taskMachine partition-result gate', persistence: 'each public event',
    scope: 'Acquisition claims remain untrusted; saved references keep original source identity and reuse semantics' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(partitionEvidenceModelGate()));
