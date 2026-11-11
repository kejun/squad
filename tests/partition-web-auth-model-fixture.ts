import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Intent } from '../src/types.js';
import { observeResourceAcquisition, type AcquisitionObservationInput } from '../src/resource-acquisition.js';
import { mapConfigurationKey, sharedPrerequisiteFailures, verifiedReadMethods } from '../src/task/map-scheduling.js';
import { sharedToolKnowledge } from '../src/task/tool-knowledge.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const login = '<title>Login</title><input type="password">';
export function recordPartitionWebObservation(model: ResilientPartitionModel, work: Intent, index: number,
  url: string, content: string, options: Partial<AcquisitionObservationInput> = {}) {
  const operationId = `request:${work.id}:${work.attempt}:web_fetch:${index}`;
  const consume = { type: 'CONSUME' as const, id: operationId, intentId: work.id, capability: 'web_fetch' as const, attempt: work.attempt, fence: work };
  assert(model.send(consume).ok);
  const receipt = observeResourceAcquisition({ id: `${operationId}:acquisition`, operationId, taskId: model.context.taskId,
    workId: work.id, attempt: work.attempt, epoch: work.epoch, goalVersion: work.goalVersion, source: 'webFetch',
    requestHash: sha(operationId), requestedResource: { kind: 'url', url }, resource: { kind: 'url', url }, content,
    contentHash: sha(content), complete: true, verifier: { id: 'squad-web-fetch', version: '1' }, executionSucceeded: true,
    at: model.sequence, sourceSnapshot: JSON.stringify({ url, content }),
    configuration: { id: 'task-protocol', version: mapConfigurationKey(model.context), authentication: 'unknown' }, ...options });
  assert(model.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt }).ok); return receipt;
}
function preparation() {
  const model = new ResilientPartitionModel(input => { input.config.webTools = { enabled: true }; });
  const peer = model.pending('assistance').find(work => work.target === 'B')!;
  const source = model.start(model.pending('assistance').find(work => work.target === 'C')!);
  const acquired = recordPartitionWebObservation(model, source, 1, model.url(peer), '实际取得的完整来源正文');
  assert.equal(verifiedReadMethods(model.context).length, 1);
  assert.equal(sharedToolKnowledge(model.context, peer).filter(item => 'validation' in item).length, 1);
  return { model, source, peer, acquired };
}
export function newWebAuthenticationInvalidatesMethodGate() {
  const scenario = preparation(), { model, source, peer } = scenario;
  const originalId = verifiedReadMethods(model.context)[0]!.id;
  const auth = recordPartitionWebObservation(model, source, 2, model.url(peer), login);
  assert.equal(auth.status, 'authentication_required'); assert(auth.at > scenario.acquired.at);
  assert.equal(verifiedReadMethods(model.context).length, 0, 'New trusted Web authentication observation must invalidate the older method before any final model answer');
  assert.equal(sharedToolKnowledge(model.context, peer).filter(item => 'validation' in item).length, 0);
  model.fail(model.start(peer), false);
  assert.equal(model.context.usage.retries, 0, 'The failed partition must not be retried with the invalidated older method');
  const fresh = recordPartitionWebObservation(model, source, 3, model.url(peer), '故障之后重新取得的完整来源正文');
  const renewed = verifiedReadMethods(model.context);
  assert.equal(renewed.length, 1); assert.notEqual(renewed[0]!.id, originalId);
  assert.equal(renewed[0]!.acquisition.id, fresh.id); assert.equal(model.context.usage.retries, 1);
  const assignments = model.context.discussion!.mapReduce!.assignments.length;
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  assert.equal(verifiedReadMethods(model.context)[0]!.id, renewed[0]!.id);
  assert.equal(model.context.usage.retries, 1); assert.equal(model.context.discussion!.mapReduce!.assignments.length, assignments);
  return scenario;
}
export function commonWebAuthenticationGate() {
  const model = new ResilientPartitionModel(input => { input.config.webTools = { enabled: true }; });
  const initial = model.pending('assistance').map(work => model.start(work)), first = initial.find(work => work.target === 'B')!;
  recordPartitionWebObservation(model, first, 1, model.url(first), login); model.fail(first, false);
  const second = model.start(model.pending('assistance').find(work => work.target === 'B')!);
  recordPartitionWebObservation(model, second, 1, model.url(second), login); model.fail(second, false);
  const faults = sharedPrerequisiteFailures(model.context);
  assert.equal(faults.length, 1); assert.equal(faults[0]!.kind, 'web_authentication'); assert.equal(faults[0]!.partitionIds.length, 2);
  assert.equal(model.pending('assistance').length, 0); assert.equal(model.queue.filter(part => part.status === 'running').length, 3);
  return model;
}
export function ignoredWebObservationGate(boundary: '旧配置' | 'unknown') {
  const scenario = preparation(), { model, source, peer } = scenario;
  const originalId = verifiedReadMethods(model.context)[0]!.id;
  recordPartitionWebObservation(model, source, 2, model.url(peer), boundary === '旧配置' ? login : '尚未核实的服务返回',
    boundary === '旧配置' ? { configuration: { id: 'task-protocol', version: 'old-configuration', authentication: 'unknown' } } : { verifier: null });
  assert.equal(verifiedReadMethods(model.context)[0]!.id, originalId, 'Only matching trusted Web authentication diagnosis can invalidate a method');
  assert.equal(sharedPrerequisiteFailures(model.context).length, 0); return scenario;
}
export function partitionWebAuthenticationModelGate() {
  newWebAuthenticationInvalidatesMethodGate(); commonWebAuthenticationGate(); ignoredWebObservationGate('旧配置'); ignoredWebObservationGate('unknown');
  return { paths: 4, model: 'real taskMachine', persistence: 'each public event',
    scope: 'Saved same-config Web auth invalidates stale methods immediately; a later new capture opens one bounded generation; unknown and old config do not classify' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(partitionWebAuthenticationModelGate()));
