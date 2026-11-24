import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LocalModel } from './local-model-fixture.js';

export const pageName = '把 Agents 变成真团队.html';
export const page = '<!DOCTYPE html>\n<html lang="zh"><title>团队</title><h1 id="team">团队</h1></html>\n';
export const pageHash = createHash('sha256').update(page).digest('hex');

export function verifyCliArtifactModel(scenario: 'failed' | 'deliver' | 'stopped' | 'reconcile') {
  const model = new LocalModel();
  assert(model.request({ type: 'runCli', executable: 'pandoc', args: ['share.md', '-o', pageName], artifactPath: pageName }).ok,
    'The declared workspace output must be accepted by the real local request boundary');
  assert(model.claim().ok);
  assert(model.send({ type: 'LOCAL_STARTED', intentId: model.work.id, operationId: 'op1', sessionId: 'session1' }).ok);
  if (scenario === 'stopped') assert(model.send({ type: 'STOP' }).ok);
  if (scenario === 'reconcile') assert(model.send({ type: 'RECOVER', config: model.c.config }).ok);
  const artifact = { path: pageName, content: page, sha256: pageHash };
  const result = { ok: true, code: 'succeeded', data: {} };
  const response = scenario === 'reconcile' ? model.send({ type: 'LOCAL_RECONCILE', intentId: model.work.id,
    operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'durable process receipt', result, artifact })
    : model.result({ result, artifact });
  assert(response.ok);
  if (scenario === 'stopped') {
    assert(!model.c.artifacts.some(file => file.name === pageName));
    return;
  }
  const saved = model.c.artifacts.find(file => file.name === pageName);
  assert(saved, 'CLI result must save the complete attachment before a model delivery');
  assert.equal(saved.content, page);
  assert.deepEqual(model.op?.result?.data.artifact, { id: saved.id, name: pageName, sha256: pageHash });
  assert(!JSON.stringify(model.op?.result).includes(page));
  if (scenario === 'failed') {
    assert(model.send({ type: 'WORK_FAILED', intentId: model.work.id, reason: 'INVALID_TOOL_REQUEST', transient: false }).ok);
    assert(model.c.messages.some(message => message.artifactIds?.includes(saved.id)));
    assert.notEqual(model.c.outcome, 'complete');
  } else if (scenario === 'deliver') {
    assert(model.send({ type: 'DELIVER', workId: model.work.id, fence: model.work, text: '生成网页', artifactIds: [] }).ok);
    assert.deepEqual(model.c.candidate?.artifactIds, [saved.id]);
    const check = model.c.intents.find(work => work.kind === 'check');
    assert.deepEqual(check?.payload.artifacts, [saved]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const scenario of ['failed', 'deliver', 'stopped', 'reconcile'] as const) verifyCliArtifactModel(scenario);
  console.log('BT_A67–BT_A69: verified persisted taskMachine attachment and result boundaries');
}
