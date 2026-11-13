import assert from 'node:assert/strict';
import type { ResourceIdentity } from '../src/resource-acquisition.js';
import { savedResourceAcquisitions } from '../src/resource-acquisition.js';
import { assertDirectPartition, reportChildSuccess } from './partition-delivery-model-fixture.js';
import { PartitionResilienceEngineFixture } from './partition-resilience-acceptance.js';

export function partitionDeliveryEngineAcceptance(kind = 'URL') {
  const resource: ResourceIdentity = kind === '文档' ? { kind: 'document', service: 'yuque', namespace: 'team/book', id: 'doc-1' }
    : kind === '文件' ? { kind: 'file', workspaceId: 'project', path: 'docs/source.md', revision: 'r1' }
      : { kind: 'url', url: 'https://docs.example.com/doc-1' };
  const fixture = new PartitionResilienceEngineFixture(input => { input.goal.partitionResources = { 'part-1': [resource] }; });
  try {
    const first = fixture.start(fixture.pending('assistance')[0]!); reportChildSuccess(fixture, first);
    const saved = structuredClone(assertDirectPartition(fixture, first, resource));
    fixture.reopen(); fixture.reopen();
    assert.deepEqual(assertDirectPartition(fixture, first, resource), saved);
    return { kind, status: saved.status, persistence: 'SQLite reopened twice' };
  } finally { fixture.close(); }
}
export function partitionSourcePersistenceEngineAcceptance() {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const initial = fixture.pending('assistance').map(w => fixture.start(w)), first = initial[0]!, source = initial[1]!;
    reportChildSuccess(fixture, first);
    const result = structuredClone(fixture.context.discussion!.results.find(r => r.workId === first.id)!);
    const receipt = fixture.acquire(source, fixture.url(first), '其他成员实际读取到的正文', false);
    fixture.reopen(); fixture.reopen();
    assert.deepEqual(fixture.context.discussion!.results.find(r => r.workId === first.id), result);
    assert.equal(fixture.queue.find(p => p.workId === first.id)!.attempt, 1);
    assert.deepEqual(savedResourceAcquisitions(fixture.context).find(r => r.id === receipt.id), receipt);
    return { sourceIdentityPreserved: true, successfulPartitionReruns: 0 };
  } finally { fixture.close(); }
}
export function reasoningPartitionEngineAcceptance() {
  const fixture = new PartitionResilienceEngineFixture(input => {
    input.goal.text = '分别分析上下文已有观点并给出推理结果'; input.message.text = input.goal.text;
  }, spec => {
    spec.decomposition!.partitions = spec.decomposition!.partitions.map(part => ({ ...part, objective: `分析已有观点${part.id}`, expectedOutput: '已有上下文内的完整推理' }));
  });
  try {
    const work = fixture.start(fixture.pending('assistance')[0]!);
    assert(fixture.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
      attempt: work.attempt, fence: work, status: 'success', text: '仅用已有上下文的完整推理' }).ok);
    assert.equal(fixture.queue.find(part => part.workId === work.id)!.status, 'succeeded');
    assert.equal(fixture.context.intents.find(item => item.id === work.id)!.localOperations?.length ?? 0, 0);
    return { reasoningAccepted: true, toolExecutions: 0 };
  } finally { fixture.close(); }
}
