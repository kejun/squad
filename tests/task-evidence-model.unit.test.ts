import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import type { LocalAction, LocalToolResult } from '../src/local-operation.js';
import { deliveryEvidence, evidenceIndex } from '../src/task/evidence.js';
import { LocalModel, localModelInput } from './local-model-fixture.js';

const firstSource = 'op1';
const readId = 'read-1';
const runAction: LocalAction = { type: 'runCli', executable: 'node', args: ['script.js'] };
const readAction = (sourceOperationId = firstSource): LocalAction => ({ type: 'readEvidence', sourceOperationId, stream: 'stdout' });
const receipt: LocalToolResult = {
  ok: true, code: 'succeeded', data: { stdout: '已有正文', stderr: '', exitCode: 0, truncated: false,
    capturedEvidence: { stdout: { capturedContentHash: 'd'.repeat(64), bytes: 12, chars: 4 } } },
};

function newSource(result = receipt, ordinary = 30) {
  const m = new LocalModel(input => { input.config.limits.ordinary = ordinary; });
  assert(m.request(runAction).ok);
  assert(m.claim().ok);
  assert(m.started().ok);
  assert(m.result({ result }).ok);
  return m;
}

function request(m: LocalModel, action: LocalAction, operationId = readId) {
  return m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId, namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
    action, parentAttempt: m.work.attempt, messages: [], fence: m.work,
    ...(action.type === 'runCli' ? { workspaceId: 'project' } : {}) });
}

function claim(m: LocalModel, operationId = readId, sessionId = 'reading') {
  return m.send({ type: 'LOCAL_CLAIM', intentId: m.work.id, operationId, sessionId, parentAttempt: m.work.attempt, leaseAvailable: false, fence: m.work });
}

function operation(m: LocalModel) {
  return m.c.intents.find(work => work.id === m.work.id)?.localOperations?.find(item => item.id === readId);
}

function claimLatest(m: LocalModel) {
  const work = m.c.intents.at(-1)!;
  assert(m.send({ type: 'CLAIM', intentId: work.id }).ok);
  m.work = m.c.intents.find(item => item.id === work.id)!;
}

function checking(result = receipt) {
  const m = newSource(result);
  assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: '待验收', artifactIds: [] }).ok);
  claimLatest(m);
  return m;
}

function assisting(refs: string[]) {
  const m = newSource();
  assert(m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', target: 'B', requestId: 'help-1',
    question: '核对来源', expected: '提供独立意见', refs }).ok);
  claimLatest(m);
  return m;
}

function savedRead(m: LocalModel) {
  assert(request(m, readAction()).ok);
  assert(claim(m).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: m.work.id, operationId: readId, sessionId: 'reading',
    result: { ok: true, code: 'EVIDENCE_PAGE', data: { text: '已有正文' } }, settled: true, effectsKnown: true }).ok);
  return m;
}

describe('task evidence persisted by the real task machine', () => {
  it('[BT_L38] gives the checker one fixed source with its original text and denies paged reads', () => {
    const m = checking();

    const projected = deliveryEvidence(m.c, m.work, m.c.deliveryCycle?.evidence);
    const denied = request(m, readAction());

    expect(projected?.sources).toMatchObject([{ id: firstSource, stdout: '已有正文', metadata: { sourceRole: 'owner',
      completeness: 'complete', capturedContentHash: 'd'.repeat(64), stdoutBytes: 12, stdoutChars: 4, obtainedAt: 1 } }]);
    expect(denied.code).toBe('CHECK_LOCAL_TOOLS_NOT_ALLOWED');
    expect(operation(m)).toBeUndefined();
    expect(m.c.usage).toMatchObject({ ordinary: 2, checks: 0 });
  });

  it('[BT_L40] keeps a truncated check source as metadata without presenting a usable quotation', () => {
    const m = checking({ ...receipt, data: { ...receipt.data, truncated: true } });

    const projected = deliveryEvidence(m.c, m.work, m.c.deliveryCycle?.evidence);

    expect(projected?.sources).toMatchObject([{ id: firstSource, metadata: { completeness: 'truncated' } }]);
    expect(projected?.sources[0]?.stdout).toBeUndefined();
  });

  it('[BT_L39] retains a distinct CLI operation even when its action and hash match the original', () => {
    const m = newSource();

    const response = request(m, runAction, 'refresh-2');

    expect(response.ok).toBe(true);
    expect(m.c.intents[0]!.localOperations?.map(item => [item.id, item.status])).toEqual([[firstSource, 'succeeded'], ['refresh-2', 'queued']]);
  });

  it.each([
    { data: { stdout: '部分正文', truncated: true }, ok: true, completeness: 'truncated' },
    { data: { stdout: '错误诊断' }, ok: false, completeness: 'failed' },
    { data: {}, ok: true, completeness: 'missing' },
    { data: { stdout: '旧正文' }, ok: true, completeness: 'unknown' },
  ])('[BT_L40] projects $completeness evidence as the original receipt allows', ({ data, ok, completeness }) => {
    const m = newSource({ ok, code: 'fixture', data });

    expect(evidenceIndex(m.c, m.work)).toMatchObject([{ sourceOperationId: firstSource, completeness, stdoutChars: null }]);
  });

  it('[BT_L41] refuses source IDs outside the task', () => {
    const m = newSource();
    assert(request(m, readAction('other-task:work:local:0')).ok);

    const response = claim(m);

    expect(response.code).toBe('EVIDENCE_UNAVAILABLE');
    expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_L41] refuses a prior goal receipt from the new active work', () => {
    const m = newSource();
    assert(m.send({ type: 'USER_INPUT', text: '换目标', goal: { ...m.c.goal, text: '新目标' } }).ok);
    assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
    claimLatest(m);
    assert(request(m, readAction()).ok);

    const response = claim(m);

    expect(response.code).toBe('EVIDENCE_UNAVAILABLE');
    expect(evidenceIndex(m.c, m.work)).toEqual([]);
  });

  it('[BT_L41] refuses an existing source absent from the assignment', () => {
    const m = assisting([]);
    assert(request(m, readAction()).ok);

    const response = claim(m);

    expect(response.code).toBe('EVIDENCE_UNAVAILABLE');
    expect(evidenceIndex(m.c, m.work)).toEqual([]);
  });

  it('[BT_L41] admits a host-selected source in the current assignment', () => {
    const m = assisting([firstSource, 'unknown-source']);
    assert(request(m, readAction()).ok);

    const response = claim(m);

    expect(response.ok).toBe(true);
    expect(m.work.evidenceRefs).toEqual([firstSource]);
  });

  it('[BT_L42] cancels a queued read without consuming its budget', () => {
    const m = newSource();
    assert(request(m, readAction()).ok);

    const response = m.send({ type: 'STOP' });

    expect(response.ok).toBe(true);
    expect(operation(m)?.status).toBe('cancelled');
    expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_L42] refuses a first read when ordinary budget is exhausted', () => {
    const m = newSource(receipt, 2);
    assert(request(m, readAction()).ok);

    const response = claim(m);

    expect(response.code).toBe('BUDGET_EXHAUSTED');
    expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_L42] preserves the completed read and its charge on recovery', () => {
    const m = savedRead(newSource());

    const response = m.send({ type: 'RECOVER', config: localModelInput().config });

    expect(response.ok).toBe(true);
    expect(operation(m)).toMatchObject({ status: 'succeeded', result: { data: { text: '已有正文' } } });
    expect(m.c.usage.ordinary).toBe(3);
  });

  it('[BT_L42] reclaims a recovered in-progress read under the same identity without charging again', () => {
    const m = newSource();
    assert(request(m, readAction()).ok);
    assert(claim(m).ok);
    assert(m.send({ type: 'RECOVER', config: localModelInput().config }).ok);
    assert(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: readId, sessionId: 'reading',
      resolution: 'notStarted', detail: 'saved content read has no external effect' }).ok);
    claimLatest(m);
    const before = m.c.usage.ordinary;

    const response = claim(m, readId, 'reading-again');

    expect(response.ok).toBe(true);
    expect(operation(m)).toMatchObject({ id: readId, status: 'claimed', attempt: 2 });
    expect(m.c.usage.ordinary).toBe(before);
  });

  it('[BT_L43] exposes a settled source from a previous epoch only as historical observation', () => {
    const m = newSource();
    assert(m.send({ type: 'STOP' }).ok);
    assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
    assert(m.send({ type: 'CONTINUE' }).ok);
    claimLatest(m);

    expect(evidenceIndex(m.c, m.work)).toMatchObject([{ sourceOperationId: firstSource, epoch: m.c.epoch - 1,
      goalVersion: m.c.goalVersion, historicalObservation: true, obtainedAt: 1, resourceVersion: null }]);
  });
});
