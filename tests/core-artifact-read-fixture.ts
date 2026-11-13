import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';

/** Pure scenario driver, also available before wiring real I/O. No test-runner registration. */
export class ArtifactReadContract {
  readonly model = new LocalModel();
  readonly ordinary: number;
  readonly candidate: string[] | undefined;
  reply?: { ok: boolean; code: string };
  constructor(subject: string) {
    const model = this.model;
    assert(model.send({ type: 'ARTIFACT', artifact: { id: 'original', name: 'report.md', content: 'original report' } }).ok);
    if (subject === '独立检查') {
      assert(model.send({ type: 'DELIVER', workId: model.work.id, text: 'Updated report', artifactIds: ['original'] }).ok);
      const check = model.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
      assert(model.send({ type: 'CLAIM', intentId: check.id }).ok);
      model.work = model.c.intents.find(work => work.id === check.id)!;
    } else assert.equal(subject, '负责人');
    this.ordinary = model.c.usage.ordinary;
    this.candidate = model.c.candidate?.artifactIds;
  }
  read(report: string) {
    const model = this.model;
    const response = model.send({ type: 'LOCAL_REQUEST', intentId: model.work.id, operationId: 'read-artifact', namespace: 'c'.repeat(64),
      requestHash: 'd'.repeat(64), action: { type: 'readArtifact', artifactId: report === '同任务报告' ? 'original' : 'foreign:report' },
      parentAttempt: model.work.attempt, messages: [], fence: model.work });
    if (!response.ok) { this.reply = response; return; }
    this.reply = model.send({ type: 'LOCAL_CLAIM', intentId: model.work.id, operationId: 'read-artifact', parentAttempt: model.work.attempt,
      sessionId: 'artifact-read-session', leaseAvailable: false, fence: model.work });
    if (this.reply.ok) assert(model.send({ type: 'LOCAL_RESULT', intentId: model.work.id, operationId: 'read-artifact',
      sessionId: 'artifact-read-session', result: { ok: true, code: 'ARTIFACT_PAGE', data: { text: 'original report' } },
      settled: true, effectsKnown: true }).ok);
  }
  verify(code: string, cost: number) {
    assert(this.reply);
    assert.equal(this.reply.code, code === 'ARTIFACT_PAGE' ? 'OK' : code);
    assert.equal(this.model.c.usage.ordinary, this.ordinary + cost);
    const operations = this.model.c.intents.find(work => work.id === this.model.work.id)!.localOperations ?? [];
    if (code === 'ARTIFACT_PAGE') {
      assert.equal(operations.length, 1);
      const operation = operations[0]!;
      assert.equal(operation.status, 'succeeded');
      assert.deepEqual(operation.action, { type: 'readArtifact', artifactId: 'original' });
      assert.equal(operation.result?.code, 'ARTIFACT_PAGE');
      assert.equal(operation.result?.data.text, 'original report');
    } else {
      assert.equal(operations.length, 1);
      assert.equal(operations[0]!.status, 'queued');
      assert.equal(operations[0]!.attempt, 0);
      assert.equal(operations[0]!.sessionId, undefined);
      assert.equal(operations[0]!.result, undefined);
    }
  }
  verifyUnchanged() {
    assert.equal(this.model.c.artifacts[0]?.content, 'original report');
    assert.deepEqual(this.model.c.candidate?.artifactIds, this.candidate);
  }
}
