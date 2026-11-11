import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { heldLocalResourceLeases } from '../src/local-operation.js';
import { resolveLocalResourcePolicy, unconfinedEffectsKey } from '../src/local-resource-policy.js';

export function verifyLocalResourcePreparationModel() {
  const policy = resolveLocalResourcePolicy({ workspaceId: 'source', copyId: 'copy-A', isolatedWork: true,
    execution: 'sandbox', sandboxConfinesWorkspace: true, action: 'runCli' });
  const cases: { name: string; prepared: boolean; held: string[] }[] = [];
  for (const boundary of ['normal', 'stop', 'expired', 'wrong-session', 'duplicate'] as const) {
    const model = new LocalModel();
    assert(model.send({ type: 'LOCAL_REQUEST', intentId: model.work.id, operationId: 'op1', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
      action: { type: 'runCli', executable: 'node', args: [] }, parentAttempt: model.work.attempt, messages: [], workspaceId: 'source',
      conflictKey: policy.conflictKey, resourceLeases: policy.resourceLeases, fence: model.work }).ok);
    assert(model.claim().ok);
    assert.deepEqual(heldLocalResourceLeases(model.op!).map(lease => lease.key), [unconfinedEffectsKey, 'source', 'copy-A']);
    assert.equal(model.started().code, 'LOCAL_PREPARATION_REQUIRED');
    if (boundary === 'stop') model.send({ type: 'STOP' });
    if (boundary === 'expired') model.at = 1001;
    const prepared = () => model.send({ type: 'LOCAL_PREPARED', intentId: model.work.id, operationId: 'op1',
      sessionId: boundary === 'wrong-session' ? 'wrong' : 'session1', workspaceRevision: 'd'.repeat(64), isolated: true });
    const response = prepared();
    if (boundary === 'normal' || boundary === 'duplicate') {
      assert(response.ok, response.code); assert.deepEqual(heldLocalResourceLeases(model.op!).map(lease => lease.key), [unconfinedEffectsKey, 'copy-A']);
      if (boundary === 'duplicate') assert.equal(prepared().code, 'LOCAL_PREPARATION_NOT_EXPECTED');
      assert(model.started().ok);
      assert(model.result({ settled: true, effectsKnown: false }).ok);
      assert.equal(model.op!.status, 'uncertain');
      assert.deepEqual(heldLocalResourceLeases(model.op!).map(lease => lease.key), [unconfinedEffectsKey, 'copy-A']);
    } else {
      assert.equal(response.ok, false); assert.equal(model.op!.preparedAt, undefined);
      assert.deepEqual(heldLocalResourceLeases(model.op!).map(lease => lease.key), [unconfinedEffectsKey, 'source', 'copy-A']);
    }
    cases.push({ name: boundary, prepared: model.op!.preparedAt !== undefined, held: heldLocalResourceLeases(model.op!).map(lease => lease.key) });
  }
  const host = new LocalModel();
  assert.equal(host.send({ type: 'LOCAL_REQUEST', intentId: host.work.id, operationId: 'op1', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: [], execution: 'host', reason: '明确宿主执行' }, parentAttempt: host.work.attempt,
    messages: [], workspaceId: 'source', conflictKey: policy.conflictKey, resourceLeases: policy.resourceLeases, fence: host.work }).code, 'INVALID_LOCAL_RESOURCES');
  return { cases: cases.length + 1, traces: cases };
}
if (process.argv[1]?.endsWith('local-resource-preparation-model-fixture.ts')) console.log(JSON.stringify(verifyLocalResourcePreparationModel(), null, 2));
