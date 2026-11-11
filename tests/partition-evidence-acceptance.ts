import assert from 'node:assert/strict';
import type { ResourceIdentity } from '../src/resource-acquisition.js';
import { assertUnverifiedPartition, reportUnverifiedSuccess } from './partition-evidence-model-fixture.js';
import { PartitionResilienceEngineFixture } from './partition-resilience-acceptance.js';

export function partitionEvidenceEngineAcceptance(kind = 'URL') {
  const resource: ResourceIdentity = kind === '文档'
    ? { kind: 'document', service: 'yuque', namespace: 'team/book', id: 'doc-1' }
    : kind === '文件' ? { kind: 'file', workspaceId: 'project', path: 'docs/source.md', revision: 'r1' }
      : { kind: 'url', url: 'https://docs.example.com/doc-1' };
  const fixture = new PartitionResilienceEngineFixture(input => {
    if (kind !== 'URL') {
      input.goal.text = '按照宿主映射分别读取文档并保留出处'; input.message.text = input.goal.text;
      input.goal.partitionResources = { 'part-1': [resource] };
    }
  });
  try {
    const initial = fixture.pending('assistance').map(work => fixture.start(work)), first = initial[0]!;
    reportUnverifiedSuccess(fixture, first);
    const result = assertUnverifiedPartition(fixture, first, resource), saved = structuredClone(result);
    fixture.reopen(); fixture.reopen();
    assert.deepEqual(assertUnverifiedPartition(fixture, first, resource), saved);
    return { kind, status: fixture.queue.find(part => part.partitionId === 'part-1')!.status,
      reportedStatus: result.reportedStatus, sourceClaimsPreserved: true, persistence: 'SQLite reopened twice' };
  } finally { fixture.close(); }
}

export function partitionSavedSourceEngineAcceptance() {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const initial = fixture.pending('assistance').map(work => fixture.start(work)), first = initial[0]!, source = initial[1]!;
    const receipt = fixture.acquire(source, fixture.url(first), '可信源被其他成员实际读取的正文', false);
    reportUnverifiedSuccess(fixture, first);
    assert.equal(fixture.queue.find(part => part.workId === first.id)!.status, 'succeeded');
    const result = fixture.context.discussion!.results.find(item => item.workId === first.id)!;
    const references = result.resourceSources;
    assert(references?.some(reference => reference.acquisitionId === receipt.id && reference.reused
      && reference.workId === source.id && reference.attempt === receipt.attempt && reference.at === receipt.at));
    fixture.reopen(); fixture.reopen();
    assert.deepEqual(fixture.context.discussion!.results.find(item => item.workId === first.id)!.resourceSources, references);
    return { savedSourceAccepted: true, originalSourceRetained: true, markedReused: true };
  } finally { fixture.close(); }
}

export function partitionGapRecoveryEngineAcceptance() {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const initial = fixture.pending('assistance').map(work => fixture.start(work)), first = initial[0]!, source = initial[1]!;
    reportUnverifiedSuccess(fixture, first);
    const original = structuredClone(assertUnverifiedPartition(fixture, first, { kind: 'url', url: fixture.url(first) }));
    fixture.acquire(source, fixture.url(first), '后续可补齐缺口的真实正文', false);
    assert.equal(fixture.context.usage.retries, 1);
    assert.equal(fixture.queue.find(part => part.partitionId === 'part-1')!.reason, 'VERIFIED_METHOD_AVAILABLE');
    assert.deepEqual(fixture.context.discussion!.results.find(item => item.workId === first.id), original);
    fixture.reopen(); fixture.reopen();
    assert.equal(fixture.context.usage.retries, 1);
    assert.deepEqual(fixture.context.discussion!.results.find(item => item.workId === first.id), original);
    return { resourceGapReevaluated: true, boundedRetry: 1, originalClaimRetainedAcrossReopen: true };
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
