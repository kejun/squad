import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Intent, TaskInput } from '../src/types.js';
import type { LocalAction, LocalToolResult } from '../src/local-operation.js';
import { observeResourceAcquisition, operationAcquisitionSnapshot, type ResourceIdentity } from '../src/resource-acquisition.js';
import { sharedToolKnowledge } from '../src/task/tool-knowledge.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';

export const partitionUrls = Array.from({ length: 8 }, (_, index) => `https://docs.example.com/doc-${index + 1}`);
export class ResilientPartitionModel extends CapacityModel {
  operation = 0;
  constructor(change: (input: TaskInput) => void = () => {}, otherOrigin = false) {
    super(input => {
      input.goal.text = `读取并汇总${partitionUrls.join(' ')}`;
      input.message.text = input.goal.text;
      input.config.limits.ordinary = 90; input.config.limits.assists = 30; input.config.limits.retries = 8;
      change(input);
    });
    this.claim(); this.consume();
    const spec = capacityModelIntent();
    spec.decomposition!.partitions = partitionUrls.map((url, index) => ({ id: `part-${index + 1}`,
      objective: `读取${otherOrigin && index >= 4 ? url.replace('docs.example.com', 'other.example.com') : url}`, expectedOutput: '独立正文和出处' }));
    assert(this.interpret(spec).ok);
  }
  get queue() { return this.context.discussion!.mapReduce!.queue!; }
  start(work = this.pending('assistance')[0]!) {
    assert(work); assert(this.send({ type: 'CLAIM', intentId: work.id }).ok);
    const claimed = this.context.intents.find(item => item.id === work.id)!;
    assert(this.send({ type: 'CONSUME', intentId: claimed.id, attempt: claimed.attempt, fence: claimed }).ok);
    return structuredClone(this.context.intents.find(item => item.id === work.id)!);
  }
  settleOperation(work: Intent, action: LocalAction, result: LocalToolResult, effectsKnown = true) {
    const operationId = `resilience-op:${++this.operation}`, sessionId = `session:${this.operation}`;
    assert(this.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId, namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
      action, parentAttempt: work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(action) }], workspaceId: 'project', fence: work }).ok);
    assert(this.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId, sessionId, parentAttempt: work.attempt,
      leaseAvailable: true, fence: work }).ok);
    assert(this.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId, sessionId, workspaceRevision: 'revision1', isolated: true }).ok);
    assert(this.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId, sessionId, result, settled: effectsKnown, effectsKnown }).ok);
    return this.context.intents.find(item => item.id === work.id)!.localOperations!.find(item => item.id === operationId)!;
  }
  fail(work: Intent, trusted = true) {
    if (trusted) this.settleOperation(work, { type: 'runCli', executable: 'node', args: ['read.mjs', this.url(work)] },
      { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'authentication required' } });
    assert(this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
      attempt: work.attempt, fence: work, status: 'failed', text: '读取前提失败' }).ok);
  }
  url(work: Intent) { return /https?:\/\/\S+/.exec((work.payload.partition as { objective: string }).objective)![0]; }
  discover(work: Intent, version = 'reader-v1') {
    return this.settleOperation(work, { type: 'discoverHost', commands: ['node'] }, { ok: true, code: 'succeeded',
      data: { cli: { catalog: { catalogVersion: version, entries: [{ command: 'node', description: 'Reader',
        domains: ['docs.example.com'], execution: 'sandbox' }] } } } });
  }
  acquire(work: Intent, url = this.url(work), body = '取得的正文与可核对事实', registered = true, record = true) {
    if (registered) this.discover(work);
    const operation = this.settleOperation(work, { type: 'runCli', executable: 'node', args: ['read.mjs', url] },
      { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: body, truncated: false } });
    return this.recordReceipt(work, operation, { kind: 'url', url }, body, record);
  }
  acquireTyped(work: Intent, resource: ResourceIdentity, body = '结构化资源独立正文') {
    const operation = this.settleOperation(work, { type: 'runCli', executable: 'node', args: ['read-typed.mjs', JSON.stringify(resource)] },
      { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: body, truncated: false } });
    return this.recordReceipt(work, operation, resource, body, true);
  }
  recordReceipt(work: Intent, operation: NonNullable<Intent['localOperations']>[number], resource: ResourceIdentity, body: string, record: boolean) {
    const receipt = observeResourceAcquisition({ id: `receipt:${operation.id}`, operationId: operation.id,
      taskId: this.context.taskId, workId: work.id, attempt: work.attempt, epoch: work.epoch, goalVersion: work.goalVersion,
      requestHash: operation.requestHash, source: 'runCli', requestedResource: resource, resource,
      content: body, contentHash: createHash('sha256').update(body).digest('hex'), complete: true,
      verifier: { id: 'fixture-reader', version: '1' },
      configuration: { id: 'task-protocol', version: JSON.stringify([this.context.config.version, this.context.config.toolVersion]), authentication: 'satisfied' }, at: operation.finishedAt!,
      sourceSnapshot: operationAcquisitionSnapshot(operation), executionSucceeded: true });
    if (record) { const recorded = this.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt }); assert(recorded.ok, recorded.code); }
    return receipt;
  }
}

function permutations(values: string[]): string[][] {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, current) => index !== current))
    .map(rest => [value, ...rest])) : [[]];
}

export function commonFailureGate(order = ['B', 'C', 'D', 'E'], unrelated = false, change: (input: TaskInput) => void = () => {}) {
  const model = new ResilientPartitionModel(change, unrelated);
  const initial = model.pending('assistance').map(work => model.start(work));
  const first = initial.find(work => work.target === order[0])!; model.fail(first);
  const followup = unrelated ? initial.find(work => work.target === order[1])!
    : model.pending('assistance').find(work => work.target === first.target)!;
  assert(followup); model.fail(unrelated ? followup : model.start(followup));
  const failures = model.context.discussion!.mapReduce!.scheduling!.blockedPrerequisites;
  assert.equal(failures.length, 1); assert.equal(failures[0]!.partitionIds.length, 2);
  if (unrelated) assert(model.pending('assistance').some(work => model.url(work).includes('other.example.com')));
  else assert.equal(model.pending('assistance').length, 0);
  assert.equal(model.queue.filter(part => part.status === 'running').length, unrelated ? 4 : 3);
  return { model, initial, first };
}

export function untrustedFailureGate() {
  const model = new ResilientPartitionModel(), work = model.start(); model.fail(work, false);
  const next = model.start(model.pending('assistance').find(item => item.target === work.target)!); model.fail(next, false);
  assert.equal(model.context.discussion!.mapReduce!.scheduling?.blockedPrerequisites.length ?? 0, 0);
  assert(model.pending('assistance').some(item => item.target === work.target));
  return model;
}

export function newMethodGate() {
  const { model, initial } = commonFailureGate();
  const successful = initial.find(work => work.target === 'D')!;
  model.acquire(successful, model.url(successful), '已成功片正文', false);
  assert(model.send({ type: 'DISCUSSION_RESULT', discussionId: successful.discussionId!, workId: successful.id,
    attempt: successful.attempt, fence: successful, status: 'success', text: '已成功片正文' }).ok);
  const successPart = structuredClone(model.queue.find(part => part.workId === successful.id)!);
  assert.equal(successPart.status, 'succeeded');
  const history = structuredClone(model.context.discussion!.results);
  const source = initial.find(work => work.target === 'C')!;
  const receipt = model.acquire(source);
  assert.equal(receipt.status, 'acquired');
  assert.equal(model.context.usage.retries, 2);
  assert.equal(model.queue.filter(part => part.attempt === 2 || part.status === 'queued' && part.reason === 'VERIFIED_METHOD_AVAILABLE').length, 2);
  assert.deepEqual(model.context.discussion!.results, history);
  assert.deepEqual(model.queue.find(part => part.partitionId === successPart.partitionId), successPart);
  const peer = initial.find(work => work.target === 'E')!;
  const methods = sharedToolKnowledge(model.context, peer).filter(item => 'validation' in item);
  assert.equal(methods.length, 1); assert.equal(methods[0]!.requiresIndependentExecution, true);
  assert(!JSON.stringify(methods).includes(receipt.content));
  const usage = structuredClone(model.context.usage), assignments = model.context.discussion!.mapReduce!.assignments.length;
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  assert.deepEqual(model.context.usage, usage);
  assert.equal(model.context.discussion!.mapReduce!.assignments.length, assignments);
  assert.equal(model.send({ type: 'DISCUSSION_RESULT', discussionId: initial[0]!.discussionId!, workId: initial[0]!.id,
    attempt: initial[0]!.attempt, fence: initial[0]!, status: 'success', text: '旧尝试迟到自述' }).ok, false);
  return { model, initial, history };
}

export function invalidMethodGate(boundary: string) {
  const { model, initial } = commonFailureGate();
  const source = initial.find(work => work.target === 'C')!;
  if (boundary === '配置版本不适用') {
    const receipt = model.acquire(source, model.url(source), '旧配置下取得的正文', true, false);
    model.discover(source, 'reader-v2');
    assert(model.send({ type: 'RECORD_ACQUISITION', intentId: source.id, receipt }).ok);
  } else if (boundary === '登录页退出成功') model.acquire(source, model.url(source), '<title>Login</title>', true);
  else if (boundary === '来源范围不适用') model.acquire(source, 'https://unrelated.example.com/doc', '独立来源正文', false);
  else if (boundary === '没有正文获取凭证') model.settleOperation(source,
    { type: 'runCli', executable: 'node', args: ['read.mjs', model.url(source)] },
    { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: '自报正文' } });
  else if (boundary === '执行结果仍不确定') model.settleOperation(source,
    { type: 'runCli', executable: 'node', args: ['read.mjs', model.url(source)] },
    { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: '未结算正文' } }, false);
  else assert.fail(`Unknown method boundary: ${boundary}`);
  assert.equal(model.context.usage.retries, 0);
  assert.equal(model.queue.filter(part => part.attempt === 2).length, 0);
  return model;
}


export function retryBoundaryGate(boundary: string) {
  const { model, initial } = commonFailureGate(undefined, false, input => {
    if (boundary === '剩余额度不足') input.config.limits.ordinary = 14;
    if (boundary === '重试额度已尽') input.config.limits.retries = 0;
  });
  const source = initial.find(work => work.target === 'C')!;
  const receipt = model.acquire(source, model.url(source), '可信新方法正文', true, false);
  if (boundary === '原截止时间已到') model.sequence = model.queue[0]!.deadline;
  if (boundary === '用户已停止任务') assert(model.send({ type: 'STOP' }).ok);
  if (boundary === '目标版本已变化') assert(model.send({ type: 'USER_INPUT', text: '新目标',
    goal: { ...model.context.goal, text: '新的目标与来源' } }).ok);
  if (boundary === '当前成员工具权限已撤销') {
    const config = structuredClone(model.context.config); config.localTools = { enabled: false };
    assert(model.send({ type: 'RECOVER', config }).ok);
  }
  model.send({ type: 'RECORD_ACQUISITION', intentId: source.id, receipt });
  assert.equal(model.context.usage.retries, 0);
  assert.equal(model.queue.filter(part => part.attempt > 1).length, 0);
  return model;
}

export function uncertainPartitionGate() {
  const model = new ResilientPartitionModel(), initial = model.pending('assistance').map(work => model.start(work));
  const uncertain = initial[0]!;
  assert(model.send({ type: 'WORK_FAILED', intentId: uncertain.id, transient: true,
    resultUncertain: true, reason: '外部执行效果尚未核对' }).ok);
  model.acquire(initial[1]!);
  assert.equal(model.queue.find(part => part.workId === uncertain.id)!.status, 'uncertain');
  assert.equal(model.queue.find(part => part.workId === uncertain.id)!.attempt, 1);
  assert.equal(model.context.usage.retries, 0);
  return model;
}

export function renewedFailureInvalidatesMethodGate() {
  const { model, initial } = commonFailureGate();
  const source = initial.find(work => work.target === 'C')!;
  model.acquire(source);
  const retried = model.start(model.pending('assistance').find(work => work.payload.partitionAttempt === 2)!);
  const retriesBeforeNewFailure = model.context.usage.retries;
  model.fail(retried);
  const peer = initial.find(work => work.target === 'E')!;
  assert.equal(sharedToolKnowledge(model.context, peer).filter(item => 'validation' in item).length, 0,
    'A later trusted authentication failure must invalidate a formerly verified method');
  assert.equal(model.context.usage.retries, retriesBeforeNewFailure);
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  assert(model.send({ type: 'RECOVER', config: model.context.config }).ok);
  assert.equal(model.context.usage.retries, retriesBeforeNewFailure);
  const restoredSource = model.start(model.pending('assistance').find(work => work.id === source.id)!);
  model.acquire(restoredSource);
  assert.equal(model.context.usage.retries, retriesBeforeNewFailure + 1,
    'A genuinely fresh acquisition after the renewed failure may authorize one bounded generation');
  return model;
}

export function typedResourcePreparation(kind: string, matched = true, mapped = true) {
  const resource: ResourceIdentity = kind === '文档'
    ? { kind: 'document', service: 'yuque', namespace: 'team/book', id: 'doc-1' }
    : { kind: 'file', workspaceId: 'project', path: 'docs/source.md', revision: 'r1' };
  const sourceResource: ResourceIdentity = matched ? resource : resource.kind === 'document'
    ? { ...resource, namespace: 'different/book' } : { ...resource, revision: 'r2' };
  const model = new ResilientPartitionModel(input => {
    input.goal.text = '按照宿主资源映射分别读取文档并保留独立来源'; input.message.text = input.goal.text;
    input.goal.partitionResources = { 'part-3': [sourceResource], ...(mapped ? { 'part-1': [resource] } : {}) };
  });
  const initial = model.pending('assistance').map(work => model.start(work));
  model.fail(initial[0]!, false);
  return { model, initial, resource, sourceResource, source: initial.find(work => (work.payload.partition as { id: string }).id === 'part-3')! };
}

export function typedResourceIdentityGate(kind: string, matched = true, mapped = true) {
  const scenario = typedResourcePreparation(kind, matched, mapped), { model, source, sourceResource } = scenario;
  model.acquireTyped(source, sourceResource);
  assert.equal(model.context.usage.retries, matched && mapped ? 1 : 0);
  assert.equal(model.queue.find(part => part.partitionId === 'part-1')!.status, matched && mapped ? 'queued' : 'failed');
  const methods = sharedToolKnowledge(model.context, scenario.initial[0]!).filter(item => 'validation' in item);
  assert.equal(methods.length, matched && mapped ? 1 : 0);
  return scenario;
}

export function alternateMemberPreparation() {
  const { model, initial } = commonFailureGate();
  model.acquire(initial.find(work => work.target === 'C')!);
  const retry = model.pending('assistance').find(work => work.payload.partitionAttempt === 2)!; assert(retry);
  const config = structuredClone(model.context.config);
  config.bots.find(bot => bot.id === 'B')!.localTools = false;
  config.bots.push({ id: 'F', name: 'F', instructions: '合法替代成员', tools: [] });
  assert(model.send({ type: 'RECOVER', config }).ok);
  return { model, retry };
}

export function alternateMemberGate() {
  const { model, retry } = alternateMemberPreparation();
  assert(model.send({ type: 'WORK_FAILED', intentId: retry.id, transient: false, reason: '原首选成员已撤销工具权限' }).ok);
  assert(model.pending('assistance').some(work => work.target === 'F' && !!work.payload.verifiedReadMethod));
  assert.equal(model.context.discussion!.mapReduce!.concurrency, 4);
  assert(model.queue.filter(part => part.status === 'running').length <= 4);
  return model;
}

export function unfinishedResultInvalidatesMethodGate() {
  const { model, initial } = commonFailureGate();
  model.acquire(initial.find(work => work.target === 'C')!);
  const retried = model.start(model.pending('assistance').find(work => work.payload.partitionAttempt === 2)!);
  const resultCount = model.context.discussion!.results.length;
  model.settleOperation(retried, { type: 'runCli', executable: 'node', args: ['read.mjs', model.url(retried)] },
    { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'authentication required' } });
  assert.equal(model.context.discussion!.results.length, resultCount, 'The member has not returned its final partition result yet');
  assert.equal(sharedToolKnowledge(model.context, initial.find(work => work.target === 'E')!).filter(item => 'validation' in item).length, 0,
    'Actual settled authentication failure invalidates the old method before any model explanation');
  return model;
}

export function partitionResilienceModelGate() {
  for (const order of permutations(['B', 'C', 'D', 'E'])) commonFailureGate(order);
  commonFailureGate(undefined, true); untrustedFailureGate(); newMethodGate();
  for (const boundary of ['配置版本不适用', '登录页退出成功', '来源范围不适用', '没有正文获取凭证', '执行结果仍不确定']) invalidMethodGate(boundary);
  for (const boundary of ['原截止时间已到', '剩余额度不足', '用户已停止任务', '目标版本已变化', '当前成员工具权限已撤销', '重试额度已尽']) retryBoundaryGate(boundary);
  uncertainPartitionGate(); renewedFailureInvalidatesMethodGate();
  for (const kind of ['文档', '文件']) { typedResourceIdentityGate(kind); typedResourceIdentityGate(kind, false); typedResourceIdentityGate(kind, true, false); }
  alternateMemberGate();
  unfinishedResultInvalidatesMethodGate();
  return { paths: 48, model: 'real taskMachine', persistence: 'every public event', responseOrders: 24 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(partitionResilienceModelGate()));
