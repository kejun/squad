import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AcquisitionObservationInput } from '../src/resource-acquisition.js';
import { observeResourceAcquisition } from '../src/resource-acquisition.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';

export const recoveryWebUrl = 'https://docs.example.com/doc-1';
export const recoveryWebBody = 'WEB_DOC_1_FACT：由宿主完整保存的原文正文';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export function webRecoveryPreparation(options: Partial<AcquisitionObservationInput> = {}) {
  const model = new ResilientPartitionModel(input => {
    input.goal.text = '按宿主目录汇总文档并保留原文依据'; input.message.text = input.goal.text;
    input.goal.resourceRequirements = [{ resource: { kind: 'url', url: recoveryWebUrl }, freshness: 'current' }];
    input.goal.partitionResources = { 'part-1': [{ kind: 'url', url: recoveryWebUrl }] };
    input.config.webTools = { enabled: true };
  });
  const first = model.start(model.pending('assistance')[0]!);
  const operationId = `request:${first.id}:${first.attempt}:web_fetch:1`;
  const consume = { type: 'CONSUME' as const, id: operationId, intentId: first.id, capability: 'web_fetch' as const,
    fence: first, attempt: first.attempt };
  assert(model.send(consume).ok);
  const receipt = observeResourceAcquisition({ id: `${operationId}:acquisition`, operationId, taskId: model.context.taskId,
    workId: first.id, attempt: first.attempt, epoch: first.epoch, goalVersion: first.goalVersion,
    requestHash: sha(operationId), source: 'webFetch', requestedResource: { kind: 'url', url: recoveryWebUrl },
    resource: { kind: 'url', url: recoveryWebUrl }, content: recoveryWebBody, contentHash: sha(recoveryWebBody), complete: true,
    verifier: { id: 'squad-web-fetch', version: '1' }, executionSucceeded: true, at: model.sequence,
    sourceSnapshot: JSON.stringify({ url: recoveryWebUrl, content: recoveryWebBody }), ...options });
  assert(model.send({ type: 'RECORD_ACQUISITION', intentId: first.id, receipt }).ok);
  model.fail(first, false);
  while (model.pending('assistance').length) {
    const work = model.start();
    assert(model.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
      attempt: work.attempt, fence: work, status: 'success', text: '已有上下文推理完整结论' }).ok);
  }
  const summary = model.start(model.pending('discussionSummary')[0]!);
  assert(model.send({ type: 'DISCUSSION_RESULT', discussionId: summary.discussionId!, workId: summary.id,
    attempt: summary.attempt, fence: summary, status: 'partial', text: '保留原分片未形成报告的缺口' }).ok);
  const owner = model.start(model.pending('owner')[0]!);
  const claims = [{ discussionId: model.context.discussion!.id, partitionId: 'part-1', sourceOperationIds: [receipt.id] }];
  const failures = structuredClone(model.context.discussion!.results.filter(result => result.status === 'failed'));
  return { model, owner, receipt, claims, failures };
}
export type WebRecoveryScenario = ReturnType<typeof webRecoveryPreparation>;
export function submitWebRecovery(scenario: WebRecoveryScenario, sourceRef = scenario.receipt.id) {
  const { model, owner } = scenario;
  assert(model.send({ type: 'DELIVER', workId: owner.id, fence: owner, attempt: owner.attempt,
    text: '根据宿主完整网页原文补齐报告', artifactIds: [], artifacts: [{ name: 'web-recovery.md', content: recoveryWebBody }],
    partitionRecoveries: [{ ...scenario.claims[0]!, sourceOperationIds: [sourceRef] }] }).ok);
}
export function webRecoveryCheck(scenario: WebRecoveryScenario) {
  const { model } = scenario, pending = model.pending('check')[0];
  assert(pending, 'A complete trusted Web source must be accepted for independent partition recovery inspection');
  const check = model.start(pending);
  const criteriaResults = model.context.candidate!.acceptance!.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed' as const,
    ...(criterion.requiredSourceIds?.length ? { source: { id: scenario.receipt.id, quote: recoveryWebBody } } : {}) }));
  return { check, event: { type: 'CHECK_RESULT' as const, workId: check.id, fence: check, attempt: check.attempt,
    resultId: 'web-recovery-pass', candidateRevision: model.context.candidate!.revision!, criteriaResults } };
}
export function completeWebRecoveryGate() {
  const scenario = webRecoveryPreparation(); submitWebRecovery(scenario);
  const { event } = webRecoveryCheck(scenario); assert(scenario.model.send(event).ok);
  const { model, receipt } = scenario;
  assert.equal(model.context.outcome, 'complete'); assert.equal(model.queue[0]!.status, 'failed');
  assert.deepEqual(model.queue[0]!.resolution!.sourceOperationIds, [receipt.id]);
  assert.deepEqual(model.context.discussion!.results.filter(result => result.status === 'failed'), scenario.failures);
  assert.equal(model.context.intents.flatMap(work => work.localOperations ?? []).length, 0);
  assert.notEqual(receipt.id, receipt.operationId, 'Canonical evidence reference is distinct from the original Web request operation');
  return scenario;
}
export function rejectedWebRecoveryGate(boundary: string) {
  const options: Partial<AcquisitionObservationInput> = boundary === '不完整' ? { complete: false }
    : boundary === '未验证' ? { verifier: null }
      : boundary === '资源不匹配' ? { resource: { kind: 'url', url: 'https://docs.example.com/other' } }
        : boundary === '登录页' ? { content: '<title>Login</title><input type="password">' }
          : boundary === '读取失败' ? { executionSucceeded: false } : {};
  const scenario = webRecoveryPreparation(options);
  submitWebRecovery(scenario, boundary === '请求ID冒充来源引用' ? scenario.receipt.operationId : scenario.receipt.id);
  assert.equal(scenario.model.pending('check').length, 0);
  assert(scenario.model.context.candidate?.deliveryIssue?.code.startsWith('MAP_RECOVERY_'));
  assert.equal(scenario.model.queue.filter(part => part.resolution).length, 0);
  assert.equal(scenario.model.context.publishedDelivery, undefined);
  return scenario;
}
export function changedFrozenWebRecoveryGate() {
  const scenario = webRecoveryPreparation(); submitWebRecovery(scenario); const { event } = webRecoveryCheck(scenario);
  const source = scenario.model.context.intents.flatMap(work => work.hostAcquisitions ?? []).find(receipt => receipt.id === scenario.receipt.id)!;
  source.content = '同一来源身份下被篡改的正文';
  scenario.model.send(event);
  assert.equal(scenario.model.queue.filter(part => part.resolution).length, 0);
  assert.equal(scenario.model.context.publishedDelivery, undefined); assert.notEqual(scenario.model.context.outcome, 'complete');
  return scenario;
}
export function stoppedWebRecoveryGate() {
  const scenario = webRecoveryPreparation(); submitWebRecovery(scenario); const { event } = webRecoveryCheck(scenario);
  assert(scenario.model.send({ type: 'STOP' }).ok); assert.equal(scenario.model.send(event).ok, false);
  assert.equal(scenario.model.queue.filter(part => part.resolution).length, 0); return scenario;
}
export function mapRecoveryWebModelGate() {
  completeWebRecoveryGate();
  for (const boundary of ['不完整', '未验证', '资源不匹配', '登录页', '读取失败', '请求ID冒充来源引用']) rejectedWebRecoveryGate(boundary);
  changedFrozenWebRecoveryGate(); stoppedWebRecoveryGate();
  return { paths: 9, model: 'real taskMachine public Web CONSUME/acquisition/delivery/check', persistence: 'each public event',
    boundary: 'Controlled host observations; no CLI call and no I/O; original request ID and canonical evidence reference remain distinct' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(mapRecoveryWebModelGate()));
