import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { sharedToolKnowledge } from '../src/task/tool-knowledge.js';
import type { Intent } from '../src/types.js';

export function toolKnowledgeModelGate(boundary = '成功') {
  const model = new LocalModel();
  assert(model.request({ type: 'runCli', executable: 'node', args: ['read.mjs', 'https://example.com/first'] }).ok);
  assert(model.claim().ok); assert(model.started().ok);
  assert(model.result({ result: { ok: boundary !== '失败', code: boundary === '失败' ? 'failed' : 'succeeded',
    data: { exitCode: boundary === '失败' ? 1 : 0, stdout: '原始资料正文不应共享' } }, effectsKnown: boundary !== '效果不明' }).ok);
  const peer: Intent = { ...structuredClone(model.work), id: 'peer', target: 'B' };
  if (boundary === '旧目标') peer.goalVersion = ++model.c.goalVersion;
  if (boundary === '旧轮次') peer.epoch = ++model.c.epoch;
  if (boundary === '任务已停止') assert(model.send({ type: 'STOP' }).ok);
  if (boundary === '成员工具关闭') model.c.config.bots[1]!.localTools = false;
  if (boundary === '输入理解') peer.kind = 'interpretation';
  const methods = sharedToolKnowledge(model.c, peer);
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
