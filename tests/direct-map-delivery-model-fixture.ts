import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MapQueueModel } from './map-queue-fixture.js';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { deliveryCheckMaterials } from '../src/delivery-check-delta.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';
import { ResilienceModel } from './task-resilience-model-fixture.js';
import { observeResourceAcquisition, operationAcquisitionSnapshot, resourceAcquisitionProblem, type ResourceIdentity } from '../src/resource-acquisition.js';
import type { Intent } from '../src/types.js';

function acquireRequiredResource(m: MapQueueModel, work: Intent, resource: ResourceIdentity) {
  const operationId = `typed-reading:${work.id}`, sessionId = `${operationId}:session`;
  const action = { type: 'runCli' as const, executable: 'node', args: ['read-typed.mjs', JSON.stringify(resource)] };
  const content = '宿主读取的完整资源正文', requestHash = createHash('sha256').update(JSON.stringify(action)).digest('hex');
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId, namespace: requestHash, requestHash,
    action, parentAttempt: work.attempt, messages: [], workspaceId: 'project', fence: work }).ok);
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId, sessionId, parentAttempt: work.attempt,
    leaseAvailable: true, fence: work }).ok);
  assert(m.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId, sessionId, workspaceRevision: 'r1', isolated: true }).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId, sessionId,
    result: { ok: true, code: 'succeeded', data: { stdout: content, exitCode: 0, truncated: false } }, settled: true, effectsKnown: true }).ok);
  const operation = m.context.intents.find(item => item.id === work.id)!.localOperations!.find(item => item.id === operationId)!;
  assert.equal(resourceAcquisitionProblem(m.context), 'RESOURCE_ACQUISITION_UNVERIFIED', 'A successful CLI output alone must not satisfy the resource obligation');
  const receipt = observeResourceAcquisition({ id: `${operationId}:acquisition`, operationId, taskId: m.context.taskId,
    workId: work.id, attempt: work.attempt, epoch: work.epoch, goalVersion: work.goalVersion, requestHash, source: 'runCli',
    requestedResource: resource, resource, content, contentHash: createHash('sha256').update(content).digest('hex'),
    complete: true, verifier: { id: 'fixture-typed-reader', version: '1' }, executionSucceeded: true,
    configuration: { id: 'task-protocol', version: JSON.stringify([m.context.config.version, m.context.config.toolVersion]), authentication: 'satisfied' },
    at: operation.finishedAt!, sourceSnapshot: operationAcquisitionSnapshot(operation) });
  assert(m.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt }).ok);
  assert.equal(resourceAcquisitionProblem(m.context), null);
}

export function settledDirectMap(resource?: ResourceIdentity) {
  const m = new MapQueueModel(input => { if (resource) input.goal.partitionResources = { 'part-7': [resource] }; });
  while (m.pending('assistance').length) {
    const work = m.start(), id = (work.payload.partition as { id: string }).id;
    if (resource && id === 'part-7') acquireRequiredResource(m, work, resource);
    assert(m.send({ type: 'DISCUSSION_RESULT', workId: work.id, fence: work, attempt: work.attempt, discussionId: work.discussionId!,
      status: id === 'part-7' ? 'success' : 'failed', text: id === 'part-7' ? 'doc-7已完成内容' : '失败诊断，不是交付正文',
      artifacts: [{ name: id + '.md', content: id === 'part-7' ? '成功文件' : '失败片不得交付此文件' }] }).ok);
  }
  assert(m.answer(m.start(m.pending('discussionSummary')[0]!)).ok);
  const owner = m.start(m.pending('owner')[0]!);
  return { m, owner };
}
export type DirectMapRun = ReturnType<typeof settledDirectMap>;
export function ordinaryDelivery(run: DirectMapRun, legacy?: unknown) {
  return run.m.send({ type: 'DELIVER', workId: run.owner.id, fence: run.owner, attempt: run.owner.attempt,
    text: '负责人依据已有内容自行完成普通交付', artifactIds: [], artifacts: [{ name: 'report.md', content: '普通汇总正文' }],
    ...(legacy === undefined ? {} : { partitionRecoveries: legacy }) });
}
export function finishOrdinary(run: DirectMapRun) {
  const check = run.m.start(run.m.pending('check')[0]!);
  const materials = deliveryCheckMaterials(run.m.context, check)!;
  assert(materials.requirements.length > 0);
  assert(materials.requirements.every(item => !item.id.startsWith('map-recovery:') && !Reflect.has(item, 'requiredSourceIds')));
  assert(run.m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt,
    resultId: 'ordinary-pass', candidateRevision: run.m.context.candidate!.revision!,
    criteriaResults: fixtureCheck(run.m.context.candidate!).criteriaResults }).ok);
  assert.equal(run.m.context.outcome, 'complete');
  assert.equal(run.m.queue.filter(part => part.status === 'failed').length, 7);
  assert(run.m.queue.every(part => !Reflect.has(part, 'resolution')));
}
export function legacyDeclaration(kind: string): unknown {
  const claim = { discussionId: 'old-round', partitionId: kind === '成功分片' ? 'part-7' : 'unknown', sourceOperationIds: ['missing-source'] };
  return kind === '重复分片' ? [claim, claim] : kind === '无来源' ? [{ ...claim, sourceOperationIds: [] }] : [claim];
}
export function childResultModel(status: 'success' | 'partial' | 'failed', text = '子Agent原样正文', invalidFiles = false) {
  const m = new MapQueueModel(input => { input.goal.partitionResources = { 'part-1': [{ kind: 'url', url: 'https://example.test/doc-1' }] }; });
  const work = m.start();
  const reply = m.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, attempt: work.attempt, fence: work,
    status, text, artifacts: invalidFiles ? { ignored: '不是产物协议，但失败不会交付' } as never : [{ name: 'child.md', content: '子Agent原样文件' }] });
  assert(reply.ok);
  const result = m.context.discussion!.results.find(item => item.workId === work.id)!;
  assert.equal(result.status, status);
  assert.equal(result.answer, status === 'failed' ? '' : text);
  assert.equal(result.artifactIds.length, status === 'failed' ? 0 : 1);
  assert.equal(m.context.artifacts.some(a => a.content === '子Agent原样文件'), status !== 'failed');
  return { m, work, result };
}
export function failedChildModel(timeout = false) {
  const m = new MapQueueModel(), work = m.start();
  assert(m.send({ type: 'WORK_FAILED', intentId: work.id, fence: work, attempt: work.attempt,
    transient: false, reason: timeout ? 'deadline 超时诊断' : '独立执行失败诊断' }).ok);
  const result = m.context.discussion!.results.find(item => item.workId === work.id)!;
  assert.equal(result.status, timeout ? 'timeout' : 'failed');
  assert.equal(result.answer, ''); assert.deepEqual(result.artifactIds, []); assert(result.reason?.includes('诊断'));
  return { m, work, result };
}
export function prepareRetiredSnapshot() {
  const run = settledDirectMap(); assert(ordinaryDelivery(run).ok);
  const raw = structuredClone(persistTask(run.m.snapshot)) as { context: typeof run.m.context };
  const candidate = raw.context.candidate!;
  Reflect.set(candidate, 'partitionRecoveries', legacyDeclaration('成功分片'));
  candidate.acceptance!.criteria.push({ id: 'map-recovery:old-round:part-7', text: '逐片补救验收', sources: [], goalVersion: 1 });
  Reflect.set(raw.context.discussion!.mapReduce!.queue![6]!, 'resolution', { privateProof: 'old' });
  raw.context.reason = 'MAP_RECOVERY_PARTITION_NOT_UNRESOLVED';
  const spent = structuredClone(raw.context.usage), attempts = raw.context.discussion!.mapReduce!.queue!.map(p => p.attempt);
  return { run, raw, spent, attempts };
}
export function retiredSnapshotModel() {
  const { run, raw, spent, attempts } = prepareRetiredSnapshot();
  run.m.snapshot = restoreTask(raw);
  assert(!Reflect.has(run.m.context.candidate!, 'partitionRecoveries'));
  assert(run.m.context.candidate!.acceptance!.criteria.every(item => !item.id.startsWith('map-recovery:')));
  assert.equal(run.m.context.reason, ''); assert.deepEqual(run.m.context.usage, spent);
  assert.deepEqual(run.m.queue.map(p => p.attempt), attempts);
  assert.equal(run.m.queue[6]!.status, 'succeeded');
  assert(run.m.queue.every(p => !Reflect.has(p, 'resolution')));
  return run;
}
export function staleChildModel(stop = true) {
  const m = new MapQueueModel(), work = m.start();
  if (stop) assert(m.send({ type: 'STOP' }).ok);
  else assert(m.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
  assert.equal(m.answer(work).ok, false);
  assert(!m.context.discussion?.results.some(r => r.workId === work.id));
  return m;
}
export function prepareUnknownEffects() {
  const m = new ResilienceModel(); const work = m.unknown();
  const operations = structuredClone(m.c.intents.find(i => i.id === work.id)!.localOperations);
  return { m, work, operations };
}
export function unknownEffectsModel() {
  const { m, work, operations } = prepareUnknownEffects();
  assert.equal(m.send({ type: 'DELIVER', workId: work.id, fence: work, text: '旧声明不能结算物理效果', artifactIds: [],
    partitionRecoveries: legacyDeclaration('成功分片') }).ok, false);
  assert.deepEqual(m.c.intents.find(i => i.id === work.id)!.localOperations, operations);
  return m;
}
export function directMapDeliveryModelGate() {
  const traces: string[] = [];
  for (const kind of [undefined, '成功分片', '未知分片', '重复分片', '错误轮次', '无来源']) {
    const run = settledDirectMap(); assert(ordinaryDelivery(run, kind ? legacyDeclaration(kind) : undefined).ok);
    assert.equal(run.m.context.candidate?.deliveryIssue, undefined); finishOrdinary(run);
    traces.push(`ordinary-delivery:${kind ?? 'no-declaration'}:complete`);
  }
  for (const status of ['success', 'partial', 'failed'] as const) { childResultModel(status); traces.push(`child:${status}:direct`); }
  childResultModel('failed', ''); failedChildModel(); failedChildModel(true); retiredSnapshotModel(); staleChildModel(); staleChildModel(false); unknownEffectsModel();
  traces.push('failure-and-timeout-empty', 'legacy-snapshot-cleaned', 'stop-and-goal-isolation', 'unknown-effects-preserved');
  return { model: createHash('sha256').update(readFileSync(new URL('../src/task.machine.ts', import.meta.url))).digest('hex'), traces };
}
if (process.argv[1]?.endsWith('direct-map-delivery-model-fixture.ts')) console.log(JSON.stringify(directMapDeliveryModelGate(), null, 2));
