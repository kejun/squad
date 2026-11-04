import { LocalModel } from './local-model-fixture.js';

export function failedSandbox(ended = false) {
  const m = new LocalModel(); m.request(); m.claim(); m.result({ result: { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'Operation not permitted', execution: 'sandbox' } } });
  if (ended) { m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: '请粘贴内容', artifactIds: [] });
    const check = m.c.intents.at(-1)!; m.send({ type: 'CLAIM', intentId: check.id }); m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, resultId: 'check1', passed: true, gaps: [] }); }
  return m;
}
export const request = (m: LocalModel, sourceRequestHash = 'a'.repeat(64)) => m.send({ type: 'REQUEST_HOST_RETRY', sourceWorkId: m.work.id,
  sourceOperationId: 'op1', sourceRequestHash, requestHash: 'b'.repeat(64), fence: { epoch: m.c.epoch, goalVersion: m.c.goalVersion } });
