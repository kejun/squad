import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { LocalModel } from './local-model-fixture.js';

function withSavedArtifact() {
  const model = new LocalModel();
  assert(model.send({ type: 'ARTIFACT', artifact: { id: 'original', name: 'report.md', content: 'original report' } }).ok);
  return model;
}

function request(model: LocalModel, artifactId: string) {
  return model.send({ type: 'LOCAL_REQUEST', intentId: model.work.id, operationId: 'read-artifact', namespace: 'c'.repeat(64),
    requestHash: 'd'.repeat(64), action: { type: 'readArtifact', artifactId }, parentAttempt: model.work.attempt,
    messages: [], fence: model.work });
}

function claim(model: LocalModel) {
  return model.send({ type: 'LOCAL_CLAIM', intentId: model.work.id, operationId: 'read-artifact', parentAttempt: model.work.attempt,
    sessionId: 'artifact-read-session', leaseAvailable: false, fence: model.work });
}

describe('historical artifacts in the durable local operation model', () => {
  it('[BT_A26] lets the owner read a saved report using one ordinary request', () => {
    const model = withSavedArtifact();
    assert(request(model, 'original').ok);
    const used = model.c.usage.ordinary;

    expect(claim(model).ok).toBe(true);
    expect(model.send({ type: 'LOCAL_RESULT', intentId: model.work.id, operationId: 'read-artifact',
      sessionId: 'artifact-read-session', result: { ok: true, code: 'ARTIFACT_PAGE', data: { text: 'original report' } },
      settled: true, effectsKnown: true }).ok).toBe(true);
    expect(model.c.usage.ordinary).toBe(used + 1);
    expect(model.c.artifacts[0]?.content).toBe('original report');
  });

  it('[BT_A26] denies a foreign artifact without consuming an ordinary request', () => {
    const model = withSavedArtifact();
    assert(request(model, 'foreign:report').ok);
    const used = model.c.usage.ordinary;

    expect(claim(model).code).toBe('ARTIFACT_UNAVAILABLE');
    expect(model.c.usage.ordinary).toBe(used);
  });

  it('[BT_A26] rejects a local artifact read under the independent check', () => {
    const model = withSavedArtifact();
    assert(model.send({ type: 'DELIVER', workId: model.work.id, text: 'Updated report', artifactIds: ['original'] }).ok);
    const check = model.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
    assert(model.send({ type: 'CLAIM', intentId: check.id }).ok);
    model.work = model.c.intents.find(work => work.id === check.id)!;
    const used = model.c.usage.ordinary;

    const response = request(model, 'original');

    expect(response.code).toBe('CHECK_LOCAL_TOOLS_NOT_ALLOWED');
    expect(model.c.usage.ordinary).toBe(used);
    expect(model.c.candidate?.artifactIds).toEqual(['original']);
  });
});
