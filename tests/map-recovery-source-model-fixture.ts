import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Intent, PartitionRecovery, TaskInput } from '../src/types.js';
import type { ResourceIdentity } from '../src/resource-acquisition.js';
import { resourceAcquisitionProblem, savedResourceAcquisitions } from '../src/resource-acquisition.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';

export function recoverySourceResource(kind = 'URL'): ResourceIdentity {
  return kind === '文档' ? { kind: 'document', service: 'yuque', namespace: 'team/book', id: 'doc-1' }
    : kind === '文件' ? { kind: 'file', workspaceId: 'project', path: 'docs/source.md', revision: 'r1' }
      : { kind: 'url', url: 'https://docs.example.com/doc-1' };
}

function successfulSource(model: ResilientPartitionModel, work: Intent, body: string) {
  return model.settleOperation(work, { type: 'runCli', executable: 'node', args: ['source.mjs', body] },
    { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: body, truncated: false,
      capturedEvidence: { stdout: { capturedContentHash: createHash('sha256').update(body).digest('hex'),
        chars: [...body].length, bytes: Buffer.byteLength(body) } } } });
}

export function recoverySourceInput(kind: string, current = false, multiple = false) {
  return (input: TaskInput) => {
    const resources = [recoverySourceResource(kind), ...(multiple ? [{ kind: 'url' as const, url: 'https://docs.example.com/second' }] : [])];
    input.goal.text = '按照宿主目录读取原文并汇总'; input.message.text = input.goal.text;
    input.goal.resourceRequirements = resources.map(resource => ({ resource, freshness: current ? 'current' : 'saved' }));
    input.goal.partitionResources = { 'part-1': resources };
  };
}

/** Real public taskMachine events; resource acquisition and echo are distinct settled operations. */
export function recoverySourcePreparation(kind = 'URL', current = false, multiple = false,
  model = new ResilientPartitionModel(recoverySourceInput(kind, current, multiple))) {
  const first = model.start(model.pending('assistance').find(work => (work.payload.partition as { id: string }).id === 'part-1')!);
  const resources = model.context.goal.partitionResources!['part-1']!;
  const actualSources = resources.map((resource, index) => {
    const body = `真实目标正文${index + 1}`, operation = successfulSource(model, first, body);
    return { operation, receipt: model.recordReceipt(first, operation, resource, body, true), body };
  });
  model.fail(first, false);
  while (model.pending('assistance').length) {
    const work = model.start(), success = (work.payload.partition as { id: string }).id === 'part-2';
    assert(model.send({ type: 'DISCUSSION_RESULT', workId: work.id, fence: work, attempt: work.attempt,
      discussionId: work.discussionId!, status: success ? 'success' : 'failed', text: success ? '已有上下文推理' : '未形成所需报告' }).ok);
  }
  const summary = model.start(model.pending('discussionSummary')[0]!);
  assert(model.send({ type: 'DISCUSSION_RESULT', workId: summary.id, fence: summary, attempt: summary.attempt,
    discussionId: summary.discussionId!, status: 'partial', text: '保留原失败，交负责人补齐报告' }).ok);
  const owner = model.start(model.pending('owner')[0]!);
  const unrelated = successfulSource(model, owner, 'foo');
  assert.equal(resourceAcquisitionProblem(model.context), null, 'The whole-task resource gate is already satisfied by other operations');
  assert(!savedResourceAcquisitions(model.context).some(receipt => receipt.operationId === unrelated.id));
  const claims = model.queue.filter(part => part.status === 'failed').map(part => ({ discussionId: model.context.discussion!.id,
    partitionId: part.partitionId, sourceOperationIds: [unrelated.id] }));
  return { model, owner, actualSources, unrelated, claims,
    failures: structuredClone(model.context.discussion!.results.filter(result => result.status === 'failed')) };
}
export type RecoverySourceScenario = ReturnType<typeof recoverySourcePreparation>;

export function submitRecoverySource(scenario: RecoverySourceScenario, claims: PartitionRecovery[] = scenario.claims) {
  const { model, owner } = scenario;
  assert(model.send({ type: 'DELIVER', workId: owner.id, attempt: owner.attempt, fence: owner,
    text: '声称补齐全部分片', artifactIds: [], artifacts: [{ name: 'recovery.md', content: '完整报告与所需正文' }], partitionRecoveries: claims }).ok);
}

export function assertRecoverySourceRejected(scenario: RecoverySourceScenario) {
  const { model } = scenario;
  assert.equal(model.context.candidate?.deliveryIssue?.code, 'MAP_RECOVERY_RESOURCE_UNVERIFIED',
    'A successful echo must not borrow resource acquisition from an unclaimed operation');
  assert.equal(model.pending('check').length, 0);
  assert.equal(model.context.publishedDelivery, undefined);
  assert.equal(model.queue.filter(part => part.resolution).length, 0);
  assert.deepEqual(model.context.discussion!.results.filter(result => result.status === 'failed'), scenario.failures);
}

export function incorrectRecoverySourceGate(kind = 'URL', current = false) {
  const scenario = recoverySourcePreparation(kind, current); submitRecoverySource(scenario); assertRecoverySourceRejected(scenario); return scenario;
}

export function correctRecoverySourceGate(kind = 'URL', current = false, multiple = false) {
  const scenario = recoverySourcePreparation(kind, current, multiple), { model } = scenario;
  const claims = structuredClone(scenario.claims);
  claims.find(claim => claim.partitionId === 'part-1')!.sourceOperationIds = scenario.actualSources.map(source => source.operation.id);
  submitRecoverySource(scenario, claims);
  const check = model.start(model.pending('check')[0]!);
  assert(model.send({ type: 'CHECK_RESULT', workId: check.id, attempt: check.attempt, fence: check, resultId: 'bound-recovery-source',
    candidateRevision: model.context.candidate!.revision!,
    criteriaResults: model.context.candidate!.acceptance!.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed',
      ...(criterion.requiredSourceIds?.length ? { source: criterion.id.endsWith(':part-1')
        ? { id: scenario.actualSources[0]!.operation.id, quote: scenario.actualSources[0]!.body }
        : { id: scenario.unrelated.id, quote: 'foo' } } : {}) })) }).ok);
  assert.equal(model.context.outcome, 'complete');
  assert.deepEqual(model.queue.find(part => part.partitionId === 'part-1')!.resolution!.sourceOperationIds,
    scenario.actualSources.map(source => source.operation.id));
  assert.deepEqual(model.context.discussion!.results.filter(result => result.status === 'failed'), scenario.failures);
  return scenario;
}

export function incompleteRecoverySourceSetGate() {
  const scenario = recoverySourcePreparation('URL', false, true), claims = structuredClone(scenario.claims);
  claims[0]!.sourceOperationIds = [scenario.actualSources[0]!.operation.id];
  submitRecoverySource(scenario, claims); assertRecoverySourceRejected(scenario); return scenario;
}

export function ambiguousRecoverySourceIdGate() {
  const scenario = recoverySourcePreparation(), claims = structuredClone(scenario.claims);
  // Legacy/public snapshots can contain equal local IDs on separate source works.
  // The frozen source owner, rather than the bare ID, determines whose receipt is valid.
  scenario.model.operation = 0;
  const echo = successfulSource(scenario.model, scenario.owner, 'another echo');
  assert.equal(echo.id, scenario.actualSources[0]!.operation.id);
  claims[0]!.sourceOperationIds = [echo.id];
  submitRecoverySource(scenario, claims); assertRecoverySourceRejected(scenario); return scenario;
}

export function mapRecoverySourceModelGate() {
  for (const kind of ['URL', '文档', '文件']) { incorrectRecoverySourceGate(kind); correctRecoverySourceGate(kind); }
  incorrectRecoverySourceGate('文档', true); correctRecoverySourceGate('文档', true);
  incompleteRecoverySourceSetGate(); correctRecoverySourceGate('URL', false, true);
  ambiguousRecoverySourceIdGate();
  return { paths: 11, model: 'real taskMachine', persistence: 'every public event',
    scope: 'Declared source set must cover typed resources; original source work, attempt and capture time remain unchanged' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(mapRecoverySourceModelGate()));
