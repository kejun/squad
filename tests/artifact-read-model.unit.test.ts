import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { LocalModel } from './local-model-fixture.js';

function checking(artifactId = 'original') {
  const model = new LocalModel();
  assert(model.send({ type: 'ARTIFACT', artifact: { id: 'original', name: 'report.md', content: 'original report' } }).ok);
  assert(model.send({ type: 'DELIVER', workId: model.work.id, text: 'Updated report', artifactIds: [],
    artifacts: [{ name: 'updated.md', content: 'updated report' }] }).ok);
  const intent = model.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
  assert(model.send({ type: 'CLAIM', intentId: intent.id }).ok);
  model.work = model.c.intents.find(work => work.id === intent.id)!;
  assert(model.send({ type: 'LOCAL_REQUEST', intentId: intent.id, operationId: 'read-artifact', namespace: 'c'.repeat(64),
    requestHash: 'd'.repeat(64), action: { type: 'readArtifact', artifactId }, parentAttempt: model.work.attempt,
    messages: [], fence: model.work }).ok);
  return model;
}

function claim(model: LocalModel) {
  return model.send({ type: 'LOCAL_CLAIM', intentId: model.work.id, operationId: 'read-artifact', parentAttempt: model.work.attempt,
    sessionId: 'artifact-read-session', leaseAvailable: false, fence: model.work });
}

describe('historical artifacts in the durable local operation model', () => {
  it('[BT_A26] claims a saved artifact as one ordinary read while retaining the candidate', () => {
    const model = checking();
    const candidate = model.c.candidate;
    const used = model.c.usage.ordinary;

    expect(claim(model).ok).toBe(true);
    expect(model.send({ type: 'LOCAL_RESULT', intentId: model.work.id, operationId: 'read-artifact',
      sessionId: 'artifact-read-session', result: { ok: true, code: 'ARTIFACT_PAGE', data: { text: 'original report' } },
      settled: true, effectsKnown: true }).ok).toBe(true);
    expect(model.c.usage.ordinary).toBe(used + 1);
    expect(model.c.candidate).toEqual(candidate);
  });

  it('[BT_A26] denies a foreign artifact without consuming an ordinary request', () => {
    const model = checking('foreign:report');
    const used = model.c.usage.ordinary;

    expect(claim(model).code).toBe('ARTIFACT_UNAVAILABLE');
    expect(model.c.usage.ordinary).toBe(used);
  });
});
