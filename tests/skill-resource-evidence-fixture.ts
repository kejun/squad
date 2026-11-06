import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { deliveryEvidence } from '../src/task/evidence.js';
export function skillResourceModel(mode: 'complete' | 'paged' | 'failed' = 'complete') {
  const model = new LocalModel();
  assert(model.request({ type: 'readSkillResource', skillId: 'local:source', path: 'references/orders.json' }).ok);
  assert(model.claim().ok);
  assert(model.result({ result: { ok: mode !== 'failed', code: mode === 'failed' ? 'READ_FAILED' : 'succeeded',
    data: mode === 'failed' ? {} : { content: '{"total":62500}', hash: 'a'.repeat(64), skillVersion: 'version1', nextOffset: mode === 'paged' ? 14 : null } } }).ok);
  assert(model.send({ type: 'DELIVER', workId: model.work.id, fence: model.work, text: '对账报告', artifactIds: [] }).ok);
  const check = model.c.intents.find(work => work.kind === 'check')!;
  assert(check);
  return { model, check, evidence: deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence)! };
}
