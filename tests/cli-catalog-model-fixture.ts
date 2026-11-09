import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';

export function catalogModelAcceptance(constraint?: string) {
  const m = new LocalModel(i => {
    i.config.limits.ordinary = 1;
    if (constraint === '工具关闭') i.config.localTools = { enabled: false };
  });
  if (constraint === '已停止') assert(m.send({ type: 'STOP' }).ok);
  if (constraint === '旧目标') m.c.goalVersion++;
  if (constraint === '未授权') delete (m.work.payload.capabilities as Record<string, unknown>).localTools;
  const action = { type: 'discoverHost', query: constraint === '查询含空字符' ? 'read\0documents' : 'read documents',
    ...(constraint === '请求伪造执行批准' ? { approved: true } : {}) };
  const response = m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'op1', namespace: 'c'.repeat(64),
    requestHash: 'a'.repeat(64), action, parentAttempt: m.work.attempt,
    messages: [{ role: 'assistant', content: JSON.stringify(action) }], fence: m.work });
  if (constraint) {
    assert.equal(response.ok, false); assert.equal(m.op, undefined); assert.equal(m.c.usage.ordinary, 1);
    return { model: m, response };
  }
  assert(response.ok, JSON.stringify(response)); assert.equal(m.op?.status, 'queued');
  assert(m.claim(false).ok); assert.equal(m.op?.status, 'claimed'); assert.equal(m.c.usage.ordinary, 1);
  const result = { ok: true, code: 'discoverHost', data: { cli: { catalog: { entries: [{ command: 'document-reader', description: 'read documents' }], nextCursor: null } } } };
  assert(m.result({ result }).ok); assert.equal(m.op?.status, 'succeeded'); assert.deepEqual(m.op.result, result);
  assert.equal(m.op.workspaceId, undefined); assert.equal(m.c.usage.ordinary, 1);
  assert(m.c.intents[0]!.localCheckpoint!.messages.at(-1)!.content.includes('document-reader'));
  assert.equal(m.c.intents.filter(work => work.kind === 'owner').length, 1);
  return { model: m, response };
}
