import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { observeResourceAcquisition, operationAcquisitionSnapshot } from '../src/resource-acquisition.js';
import { LocalModel } from './local-model-fixture.js';
import { sharedToolKnowledge } from '../src/task/tool-knowledge.js';
import type { Intent, TaskContext } from '../src/types.js';

export function toolKnowledgeModelGate(boundary = '成功', observe?: (context: TaskContext, peer: Intent) => void) {
  const model = new LocalModel();
  const catalog = { type: 'discoverHost' as const, commands: ['node'] };
  assert(model.send({ type: 'LOCAL_REQUEST', intentId: model.work.id, operationId: 'catalog', namespace: 'c'.repeat(64),
    requestHash: 'b'.repeat(64), action: catalog, parentAttempt: model.work.attempt, messages: [], fence: model.work }).ok);
  assert(model.send({ type: 'LOCAL_CLAIM', intentId: model.work.id, operationId: 'catalog', sessionId: 'catalog-session', parentAttempt: model.work.attempt, leaseAvailable: true, fence: model.work }).ok);
  assert(model.send({ type: 'LOCAL_STARTED', intentId: model.work.id, operationId: 'catalog', sessionId: 'catalog-session' }).ok);
  assert(model.send({ type: 'LOCAL_RESULT', intentId: model.work.id, operationId: 'catalog', sessionId: 'catalog-session',
    result: { ok: true, code: 'succeeded', data: { cli: { catalog: { catalogVersion: 'v1', entries: [{ command: 'node', domains: ['example.com'], execution: 'sandbox' }] } } } }, settled: true, effectsKnown: true }).ok);
  assert(model.request({ type: 'runCli', executable: 'node', args: ['read.mjs', 'https://example.com/first'] }).ok);
  assert(model.claim().ok); assert(model.started().ok);
  assert(model.result({ result: { ok: boundary !== '失败', code: boundary === '失败' ? 'failed' : 'succeeded',
    data: { exitCode: boundary === '失败' ? 1 : 0, stdout: '原始资料正文不应共享' } }, effectsKnown: boundary !== '效果不明' }).ok);
  if (!['失败', '效果不明', '仅退出零'].includes(boundary)) {
    const operation = model.c.intents[0]!.localOperations!.find(op => op.id === 'op1')!;
    const resource = { kind: 'url' as const, url: 'https://example.com/first' }, content = '原始资料正文不应共享';
    const receipt = observeResourceAcquisition({ id: 'verified-first', operationId: operation.id, taskId: model.c.taskId,
      workId: model.work.id, attempt: model.work.attempt, epoch: model.work.epoch, goalVersion: model.work.goalVersion,
      requestHash: operation.requestHash, source: 'runCli', requestedResource: resource, resource, content,
      contentHash: createHash('sha256').update(content).digest('hex'), complete: true, verifier: { id: 'fixture-reader', version: '1' },
      configuration: { id: 'task-protocol', version: JSON.stringify([model.c.config.version, model.c.config.toolVersion]), authentication: 'satisfied' },
      at: model.at, sourceSnapshot: operationAcquisitionSnapshot(operation), executionSucceeded: true });
    assert(model.send({ type: 'RECORD_ACQUISITION', intentId: model.work.id, receipt }).ok);
  }
  const peer: Intent = { ...structuredClone(model.work), id: 'peer', target: 'B',
    payload: { ...model.work.payload, question: '读取https://example.com/second' } };
  if (boundary === '旧目标') peer.goalVersion = ++model.c.goalVersion;
  if (boundary === '旧轮次') peer.epoch = ++model.c.epoch;
  if (boundary === '任务已停止') assert(model.send({ type: 'STOP' }).ok);
  if (boundary === '成员工具关闭') model.c.config.bots[1]!.localTools = false;
  if (boundary === '输入理解') peer.kind = 'interpretation';
  observe?.(model.c, peer);
  const methods = sharedToolKnowledge(model.c, peer).filter(item => 'validation' in item);
  if (boundary !== '成功') assert.deepEqual(methods, []);
  else {
    assert.equal(methods.length, 1);
    assert.deepEqual(methods[0]!.action, { type: 'runCli', executable: 'node', args: ['read.mjs', 'https://example.com/first'] });
    assert.equal(methods[0]!.sourceOperationId, 'op1');
    assert.equal(methods[0]!.requiresIndependentExecution, true);
    assert(!JSON.stringify(methods).includes('原始资料正文'));
    assert.equal(model.c.usage.ordinary, 2);
  }
  return methods;
}
