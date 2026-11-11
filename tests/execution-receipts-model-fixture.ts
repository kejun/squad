import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LocalModel } from './local-model-fixture.js';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { acquisitionForOperation, observeResourceAcquisition, operationAcquisitionSnapshot, hostEvidenceReference,
  resourceAcquisitionProblem, savedResourceAcquisitions, verifiedResourceAcquisition,
  type AcquisitionObservationInput, type HostAcquisition, type ResourceIdentity } from '../src/resource-acquisition.js';
import { requiredResources, missingResourceAcquisitions, resourceAcquisitionSources } from '../src/resource-acquisition.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';
import { deliveryEvidence } from '../src/task/evidence.js';
import { publicationIds } from '../src/task/delivery.js';
import type { Intent } from '../src/types.js';

export const documentFive = { kind: 'document', service: 'documents.example', namespace: 'team', id: 'five' } as const satisfies ResourceIdentity;
export const documentUrl = { kind: 'url', url: 'https://documents.example/team/five' } as const satisfies ResourceIdentity;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export function receiptModel(resource: ResourceIdentity | null = documentFive, freshness: 'current' | 'saved' = 'saved', options: { checks?: number } = {}) {
  return new LocalModel(input => {
    input.config.version = 'team-v3'; input.config.toolVersion = 'tools-v3';
    input.config.resilience = { automaticTimeoutMs: 10000, repairLimit: 2 };
    if (options.checks !== undefined) input.config.limits.checks = options.checks;
    input.goal = { text: resource ? '读取文档五正文并报告' : '比较用户直接提供的两段文字', constraints: [],
      criteria: ['保留依据和未核实内容'], requiredArtifacts: 0,
      ...(resource ? { resourceRequirements: [{ resource, freshness }] } : {}) };
  });
}

export function currentReceiptWork(m: LocalModel): Intent { return m.c.intents.find(work => work.id === m.work.id)!; }
export function recordCliObservation(m: LocalModel, options: Partial<AcquisitionObservationInput> = {}) {
  const receipt = captureCliObservation(m, options);
  const work = currentReceiptWork(m);
  const reply = m.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt, fence: work, attempt: work.attempt });
  return { receipt, reply };
}

export function captureCliObservation(m: LocalModel, options: Partial<AcquisitionObservationInput> = {}) {
  const content = options.content ?? '文档五真实捕获正文';
  assert(m.request({ type: 'runCli', executable: 'document-reader', args: ['five'] }).ok);
  assert(m.claim().ok); assert(m.started().ok);
  assert(m.result({ result: { ok: true, code: 'succeeded', data: { stdout: content, exitCode: 0, truncated: options.complete === false,
    capturedEvidence: { stdout: { capturedContentHash: sha(content), bytes: Buffer.byteLength(content), chars: [...content].length } } } } }).ok);
  const work = currentReceiptWork(m), op = work.localOperations![0]!;
  const receipt = observeResourceAcquisition({ id: `${op.id}:host-reading`, operationId: op.id, taskId: m.c.taskId,
    workId: work.id, attempt: work.attempt, epoch: work.epoch, goalVersion: work.goalVersion,
    source: 'runCli', requestHash: op.requestHash, requestedResource: documentFive, resource: documentFive,
    content, contentHash: sha(content), complete: true, verifier: { id: 'registered-document-reader', version: '1' },
    executionSucceeded: true, at: m.at, sourceSnapshot: operationAcquisitionSnapshot(op),
    configuration: { id: 'task-protocol', version: JSON.stringify([m.c.config.version, m.c.config.toolVersion]), authentication: 'satisfied' }, ...options });
  return receipt;
}

export function recordWebObservation(m: LocalModel, options: Partial<AcquisitionObservationInput> = {}) {
  const work = currentReceiptWork(m), operationId = `request:${work.id}:${work.attempt}:web_fetch:1`;
  const content = options.content ?? '文档五真实捕获正文';
  assert(m.send({ type: 'CONSUME', id: operationId, intentId: work.id, capability: 'web_fetch', fence: work, attempt: work.attempt }).ok);
  const receipt = observeResourceAcquisition({ id: `${operationId}:host-reading`, operationId, taskId: m.c.taskId,
    workId: work.id, attempt: work.attempt, epoch: work.epoch, goalVersion: work.goalVersion,
    source: 'webFetch', requestHash: sha(operationId), requestedResource: documentUrl, resource: documentUrl,
    content, contentHash: sha(content), complete: true, verifier: { id: 'host-web-reader', version: '1' }, executionSucceeded: true,
    at: m.at, sourceSnapshot: JSON.stringify({ url: documentUrl, content }), ...options });
  const reply = m.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt, fence: work, attempt: work.attempt });
  return { receipt, reply };
}

export function submitReceiptCandidate(m: LocalModel, content = '文档五的报告') {
  return m.send({ type: 'DELIVER', workId: m.work.id, attempt: m.work.attempt, fence: m.work,
    text: content, artifactIds: [], artifacts: [{ name: 'report.md', content }] });
}
export function finishReceiptCheck(m: LocalModel, status: 'passed' | 'unverified' = 'passed') {
  const pending = m.c.intents.find(work => work.kind === 'check' && work.status === 'pending');
  assert(pending, 'A valid candidate must reach its independent check');
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const check = m.c.intents.find(work => work.id === pending.id)!;
  assert(m.send({ type: 'CONSUME', intentId: check.id, fence: check, attempt: check.attempt }).ok);
  assert(m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, resultId: `check:${check.id}`,
    candidateRevision: m.c.candidate!.revision, criteriaResults: m.c.candidate!.acceptance!.criteria.map(criterion => ({
      criterionId: criterion.id, status, ...(status === 'unverified' ? { reason: '尚未核实' } : {}) })) }).ok);
  return check;
}

export function assertReceiptBlocked(m: LocalModel) {
  assert(submitReceiptCandidate(m, '已收到HTTP200和242字符，全部完成').ok);
  assert.equal(m.c.candidate?.deliveryIssue?.code, 'RESOURCE_ACQUISITION_UNVERIFIED');
  assert.equal(m.c.intents.filter(work => work.kind === 'check').length, 0);
  assert.notEqual(m.c.outcome, 'complete');
}

export const receiptSemantics = {
  需要登录: { content: '<html><title>Login</title><input type="password"></html>', status: 'authentication_required' },
  正文为空: { content: '', status: 'empty' },
  资源不匹配: { resource: { ...documentFive, id: 'four' } as ResourceIdentity, status: 'resource_mismatch' },
  尚未核实: { verifier: null, status: 'unknown' },
  不完整: { complete: false, status: 'incomplete' },
  正文: { status: 'acquired' },
} as const;

export function receiptSemanticModel(label: keyof typeof receiptSemantics) {
  const m = receiptModel(), { status, ...options } = receiptSemantics[label];
  const observed = recordCliObservation(m, options);
  assert(observed.reply.ok); assert.equal(observed.receipt.status, status);
  assert.equal(acquisitionForOperation(m.c, currentReceiptWork(m), m.op!)?.status, status);
  assert.equal(verifiedResourceAcquisition(observed.receipt), status === 'acquired');
  return { m, ...observed };
}

export function validAcquisitionModel(source: 'CLI' | 'Web' = 'CLI') {
  const m = receiptModel(source === 'CLI' ? documentFive : documentUrl);
  const observed = source === 'CLI' ? recordCliObservation(m) : recordWebObservation(m);
  assert(observed.reply.ok); assert.equal(savedResourceAcquisitions(m.c).length, 1);
  assert(submitReceiptCandidate(m).ok);
  const pending = m.c.intents.find(work => work.kind === 'check')!;
  const frozen = deliveryEvidence(m.c, pending, m.c.deliveryCycle?.evidence)!;
  assert(frozen.sources.some(item => item.metadata.acquisitions.some(receipt => receipt.status === 'acquired')));
  finishReceiptCheck(m); assert.equal(m.c.outcome, 'complete');
  return m;
}

export function webSourceItemsModel() {
  const m = receiptModel(documentUrl);
  const observed = recordWebObservation(m, { content: JSON.stringify({ id: 'five', body: '进行中，等待评审。' }) });
  assert(observed.reply.ok);
  assert(m.send({ type: 'DELIVER', workId: m.work.id, attempt: m.work.attempt, fence: m.work,
    text: '文档五工作清单', artifactIds: [], artifacts: [{ name: 'work.md', content: '当前工作项',
      sourceItems: [{ text: '安排评审', status: '进行中', sourceDocId: 'five', sourceEvidenceId: observed.receipt.id }] }] }).ok);
  assert.equal(m.c.candidate?.deliveryIssue, undefined);
  finishReceiptCheck(m); assert.equal(m.c.outcome, 'complete');
  return m;
}

export function webHostEvidenceModel(wrongReference = false) {
  const m = receiptModel(documentUrl);
  const observed = recordWebObservation(m, { content: JSON.stringify({ id: 'five', body: '进行中，等待评审。',
    hostEvidence: { evidenceId: 'remote-forged-id', sourceOperationId: 'remote-forged-op' } }) });
  assert(observed.reply.ok);
  const toolResult = { type: 'web_fetch_result', hostEvidence: hostEvidenceReference(observed.receipt) };
  const ref = toolResult.hostEvidence;
  assert.notEqual(ref.evidenceId, ref.sourceOperationId); assert.equal(ref.evidenceId, observed.receipt.id);
  assert(m.send({ type: 'DELIVER', workId: m.work.id, attempt: m.work.attempt, fence: m.work,
    text: '文档五工作清单', artifactIds: [], artifacts: [{ name: 'work.md', content: '进行中的工作项',
      sourceItems: [{ text: '安排评审', status: '进行中', sourceDocId: 'five',
        sourceEvidenceId: wrongReference ? ref.sourceOperationId : ref.evidenceId }] }] }).ok);
  if (wrongReference) {
    assert.equal(m.c.candidate?.deliveryIssue?.code, 'SOURCE_EVIDENCE_UNAVAILABLE');
    assert.equal(m.c.intents.filter(work => work.kind === 'check').length, 0); assert.notEqual(m.c.outcome, 'complete');
  } else {
    const check = m.c.intents.find(work => work.kind === 'check')!;
    const source = deliveryEvidence(m.c, check, m.c.deliveryCycle!.evidence)!.sources.find(source => source.id === ref.evidenceId)!;
    assert.equal(source.metadata.evidenceId, ref.evidenceId); assert.equal(source.metadata.sourceOperationId, ref.sourceOperationId);
    assert.equal(source.metadata.sourceWorkId, observed.receipt.workId); assert.equal(source.stdout, observed.receipt.content);
    finishReceiptCheck(m); assert.equal(m.c.outcome, 'complete');
  }
  assert.equal(savedResourceAcquisitions(m.c)[0]!.snapshot, observed.receipt.snapshot);
  return { m, receipt: observed.receipt, hostEvidence: ref };
}

export function changedFrozenAcquisitionModel(field: 'content' | 'resource' | 'complete' | 'verifier') {
  const m = receiptModel(); assert(recordCliObservation(m).reply.ok); assert(submitReceiptCandidate(m).ok);
  const saved = structuredClone(persistTask(m.snapshot)) as { context: LocalModel['c'] };
  const receipt = saved.context.intents[0]!.hostAcquisitions![0]!;
  if (field === 'content') receipt.content = '同长篡改正文内容！';
  if (field === 'resource') receipt.resource = { ...documentFive, id: 'four' } as ResourceIdentity;
  if (field === 'complete') receipt.complete = false;
  if (field === 'verifier') receipt.verifier = { id: 'registered-document-reader', version: 'changed' };
  m.snapshot = restoreTask(saved);
  finishReceiptCheck(m); assert.notEqual(m.c.outcome, 'complete');
  return m;
}

export function partialSelectionModel(oldGoal = false) {
  const m = receiptModel(null);
  assert(m.send({ type: 'ARTIFACT', artifact: { id: 'earlier', name: 'earlier.md', content: '先前草稿' } }).ok);
  if (oldGoal) {
    assert(m.send({ type: 'USER_INPUT', text: '切换目标', goal: { text: '新目标', constraints: [], criteria: ['新内容'], requiredArtifacts: 0 } }).ok);
    assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
    const pending = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
    assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok); m.work = m.c.intents.find(work => work.id === pending.id)!;
  }
  assert(submitReceiptCandidate(m, '当前目标报告').ok); finishReceiptCheck(m, 'unverified');
  assert.equal(m.c.outcome, 'partial'); assert(!publicationIds(m.c)?.includes('earlier'));
  assert(m.c.artifacts.some(item => item.id === 'earlier'));
  return m;
}

export function receiptCheckpointRetryModel() {
  const m = receiptModel(documentFive, 'current'), original = recordCliObservation(m);
  assert(original.reply.ok);
  assert(m.send({ type: 'WORK_FAILED', intentId: m.work.id, reason: 'MODEL_NETWORK_UNAVAILABLE', transient: true }).ok);
  assert(m.send({ type: 'CLAIM', intentId: m.work.id }).ok); m.work = currentReceiptWork(m);
  const restamped = observeResourceAcquisition({ ...original.receipt, id: `${original.receipt.id}:restamped`,
    attempt: m.work.attempt, at: m.at + 5, executionSucceeded: true });
  assert.equal(m.send({ type: 'RECORD_ACQUISITION', intentId: m.work.id, receipt: restamped }).code, 'ACQUISITION_SOURCE_UNAVAILABLE');
  assert.equal(resourceAcquisitionProblem(m.c), null);
  assert.equal(savedResourceAcquisitions(m.c).length, 1);
  assert.equal(savedResourceAcquisitions(m.c)[0]!.snapshot, original.receipt.snapshot);
  assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m); assert.equal(m.c.outcome, 'complete');
  return { m, receipt: original.receipt };
}

export function prepareTypedPartitionResourcesModel(label: '服务文档' | '工作区文件' | 'URL') {
  const resources: ResourceIdentity[] = label === '服务文档' ? [documentFive, { ...documentFive, id: 'six' }]
    : label === '工作区文件' ? [{ kind: 'file', workspaceId: 'sources', path: 'five.md', revision: 'v1' },
      { kind: 'file', workspaceId: 'sources', path: 'six.md', revision: 'v1' }]
      : [documentUrl, { kind: 'url', url: 'https://documents.example/team/six' }];
  const model = new ResilientPartitionModel(input => {
    input.goal.text = '按宿主分片目录读取并汇总'; input.message.text = input.goal.text;
    input.goal.resourceRequirements = [];
    input.goal.partitionResources = { 'part-1': [resources[0]!], 'part-2': [resources[1]!] };
  });
  const first = model.start(model.pending('assistance').find(work => (work.payload.partition as { id: string }).id === 'part-1')!);
  const second = model.context.intents.find(work => (work.payload.partition as { id?: string } | undefined)?.id === 'part-2')!;
  assert.deepEqual(requiredResources(model.context, first), [{ resource: resources[0], freshness: 'saved' }]);
  assert.deepEqual(requiredResources(model.context, second), [{ resource: resources[1], freshness: 'saved' }]);
  assert.equal(missingResourceAcquisitions(model.context).length, 2);
  return { model, first, second, resources };
}

export function typedPartitionResourcesModel(label: '服务文档' | '工作区文件' | 'URL') {
  const { model, first, second, resources } = prepareTypedPartitionResourcesModel(label);
  const receipt = model.acquireTyped(first, resources[0]!);
  assert.equal(receipt.status, 'acquired'); assert.equal(resourceAcquisitionProblem(model.context, first), null);
  assert.deepEqual(resourceAcquisitionSources(model.context, first, [receipt.operationId]).map(source => source.id), [receipt.id]);
  assert.deepEqual(resourceAcquisitionSources(model.context, first, ['unrelated-operation']), []);
  assert.equal(missingResourceAcquisitions(model.context, first, ['unrelated-operation']).length, 1);
  assert.deepEqual(missingResourceAcquisitions(model.context), [{ resource: resources[1], freshness: 'saved' }]);
  assert.equal(resourceAcquisitionProblem(model.context, second), 'RESOURCE_ACQUISITION_UNVERIFIED');
  return { model, first, second, receipt };
}

export function unverifiedPartitionResultModel() {
  const model = new ResilientPartitionModel(), work = model.start();
  const text = '已收到HTTP200和242字符，全部完成';
  assert(model.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    fence: work, attempt: work.attempt, status: 'success', text }).ok);
  const result = model.context.discussion!.results.find(item => item.workId === work.id)!;
  assert(result); assert.equal(result.answer, text); assert.equal(result.reportedStatus, 'success');
  assert.equal(result.status, 'partial'); assert.equal(model.queue.find(part => part.workId === work.id)!.status, 'partial');
  assert(result.missingResources?.length); assert.equal(savedResourceAcquisitions(model.context).length, 0);
  return { model, work, result };
}

export function receiptBackfillWindowModel(freshness: 'saved' | 'current' = 'saved') {
  const m = receiptModel(documentFive, freshness), receipt = captureCliObservation(m);
  assert.equal(savedResourceAcquisitions(m.c).length, 0);
  m.at = 7; assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  assert(m.send({ type: 'CLAIM', intentId: m.work.id }).ok); m.work = currentReceiptWork(m);
  assert.equal(m.work.attempt, 2);
  const usage = structuredClone(m.c.usage);
  const reply = m.send({ type: 'RECORD_ACQUISITION', intentId: m.work.id, receipt });
  assert(reply.ok, reply.code); assert.deepEqual(m.c.usage, usage);
  assert.equal(savedResourceAcquisitions(m.c)[0]!.snapshot, receipt.snapshot); assert.equal(m.c.lastActivityAt, 7);
  assert.equal(receipt.attempt, 1); assert.equal(receipt.at, 1);
  assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m); assert.equal(m.c.outcome, 'complete');
  assert.equal(m.c.intents.flatMap(work => work.localOperations ?? []).length, 1);
  return { m, receipt };
}

export function verifyExecutionReceiptModels() {
  const missing = receiptModel(); assertReceiptBlocked(missing);
  validAcquisitionModel('CLI'); validAcquisitionModel('Web'); webSourceItemsModel();
  for (const label of Object.keys(receiptSemantics) as (keyof typeof receiptSemantics)[]) {
    const run = receiptSemanticModel(label);
    if (label !== '正文') assertReceiptBlocked(run.m);
  }
  for (const field of ['content', 'resource', 'complete', 'verifier'] as const) changedFrozenAcquisitionModel(field);
  const reasoning = receiptModel(null); assert(submitReceiptCandidate(reasoning).ok); finishReceiptCheck(reasoning);
  assert.equal(reasoning.c.outcome, 'complete'); assert.equal(reasoning.c.intents.flatMap(work => work.localOperations ?? []).length, 0);
  const selfReport = receiptModel();
  assert(selfReport.request().ok); assert(selfReport.claim().ok); assert(selfReport.started().ok);
  assert(selfReport.result({ result: { ok: true, code: 'succeeded', data: { stdout: JSON.stringify({ acquisition: { status: 'acquired' } }),
    acquisition: { status: 'acquired' }, exitCode: 0, truncated: false } } }).ok);
  assertReceiptBlocked(selfReport);
  const missingSource = receiptModel();
  assert.equal(recordCliObservation(missingSource, { operationId: 'unknown-operation' }).reply.code, 'ACQUISITION_SOURCE_UNAVAILABLE');
  assertReceiptBlocked(missingSource);
  const fresh = receiptModel(documentFive, 'current'); assert(recordCliObservation(fresh).reply.ok);
  assert(fresh.send({ type: 'STOP' }).ok); assert(fresh.send({ type: 'SETTLE', intentId: fresh.work.id }).ok);
  assert(fresh.send({ type: 'CONTINUE' }).ok);
  assert.equal(resourceAcquisitionProblem(fresh.c), 'RESOURCE_ACQUISITION_UNVERIFIED');
  receiptCheckpointRetryModel();
  const saved = receiptModel(); assert(recordCliObservation(saved).reply.ok);
  assert(saved.send({ type: 'STOP' }).ok); assert(saved.send({ type: 'SETTLE', intentId: saved.work.id }).ok);
  assert(saved.send({ type: 'CONTINUE' }).ok);
  assert.equal(resourceAcquisitionProblem(saved.c), null);
  partialSelectionModel(false); partialSelectionModel(true);
  const partial = partialSelectionModel(false);
  assert(partial.send({ type: 'CONTINUE' }).ok);
  assert.equal(partial.c.publishedDelivery, undefined);
  assert.equal(partial.c.resilience?.frozenHistory?.length, 1);
  assert(partial.c.artifacts.some(artifact => artifact.content === '当前目标报告'));
  typedPartitionResourcesModel('服务文档'); typedPartitionResourcesModel('工作区文件'); typedPartitionResourcesModel('URL');
  receiptBackfillWindowModel('saved'); receiptBackfillWindowModel('current');
  webHostEvidenceModel(); webHostEvidenceModel(true);
  return { model: 'real taskMachine; every public event persists/restores', cases: 30,
    boundary: 'synthetic host observations; no model/CLI/network I/O', status: 'passed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(verifyExecutionReceiptModels()));
