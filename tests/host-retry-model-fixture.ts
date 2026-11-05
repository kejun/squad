import assert from 'node:assert/strict';
import type { HostApproval } from '../src/local-operation.js';
import type { Intent } from '../src/types.js';
import { LocalModel } from './local-model-fixture.js';

export function failedSandbox(ended = false, multiple = false) {
  const m = new LocalModel(); m.request(); m.claim(); m.result({ result: { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'Operation not permitted', execution: 'sandbox' } } });
  if (multiple) {
    const action = { type: 'runCli', executable: 'node', args: ['second.js'] };
    assert(m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'op2', namespace: 'c'.repeat(64), requestHash: 'c'.repeat(64),
      action, parentAttempt: m.work.attempt, messages: [], workspaceId: 'project', fence: m.work }).ok);
    assert(m.send({ type: 'LOCAL_CLAIM', intentId: m.work.id, operationId: 'op2', sessionId: 'session2', parentAttempt: m.work.attempt, leaseAvailable: true, fence: m.work }).ok);
    assert(m.result({ operationId: 'op2', sessionId: 'session2', result: { ok: false, code: 'failed', data: { execution: 'sandbox' } } }).ok);
  }
  if (ended) {
    assert(deliver(m).ok);
    assert(passCheck(m, claimCheck(m), 'check1').ok);
  }
  return m;
}

export function claimCheck(m: LocalModel): Intent {
  const pending = m.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const work = m.c.intents.find(item => item.id === pending.id)!;
  assert(m.send({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt }).ok);
  return work;
}

export function passCheck(m: LocalModel, check: Intent, resultId: string) {
  const candidate = m.c.candidate!;
  return m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, resultId,
    candidateRevision: candidate.revision, criteriaResults: candidate.acceptance!.criteria.map(item => ({ criterionId: item.id, status: 'passed' })) });
}

export const request = (m: LocalModel, sourceRequestHash = 'a'.repeat(64), sourceOperationId = 'op1') => m.send({ type: 'REQUEST_HOST_RETRY', sourceWorkId: m.work.id,
  sourceOperationId, sourceRequestHash, requestHash: (sourceOperationId === 'op1' ? 'b' : 'f').repeat(64), fence: { epoch: m.c.epoch, goalVersion: m.c.goalVersion } });
export const requestSecond = (m: LocalModel) => request(m, 'c'.repeat(64), 'op2');
export const deliver = (m: LocalModel, work = m.work) => m.send({ type: 'DELIVER', workId: work.id, fence: work, text: '候选说明', artifactIds: [] });
export const retryWork = (m: LocalModel) => m.c.intents.find(w => w.id === m.c.hostRetryBatch?.workId)!;
export const retryOp = (m: LocalModel) => retryWork(m).localOperations!.at(-1)!;
export function claimRetryWork(m: LocalModel) {
  assert(m.send({ type: 'CLAIM', intentId: retryWork(m).id }).ok);
}
export function claimRetryOp(m: LocalModel, sessionId: string) {
  const work = retryWork(m), operation = retryOp(m);
  return m.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: operation.id, sessionId, parentAttempt: work.attempt, leaseAvailable: true, fence: work });
}
export function prepareRetry(m: LocalModel, approvalId = 'approval1') {
  const work = retryWork(m), operation = retryOp(m);
  assert(operation.action.type === 'runCli');
  assert(claimRetryOp(m, approvalId).ok);
  const approval: HostApproval = { id: approvalId, digest: 'd'.repeat(64), status: 'pending', expiresAt: operation.deadline!,
    plan: { executable: '/usr/bin/node', args: operation.action.args, cwd: '/task', workspaceRevision: 'b'.repeat(64), executableHash: 'c'.repeat(64),
      environmentHash: 'e'.repeat(64), host: 'host', account: 'user', reason: operation.action.reason! } };
  assert(m.send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId: operation.id, sessionId: approvalId, approval, fence: work }).ok);
}
export function decideRetry(m: LocalModel, decision = 'approve') {
  const work = retryWork(m), op = retryOp(m);
  return m.send({ type: 'LOCAL_APPROVAL_DECISION', intentId: work.id, operationId: op.id, approvalId: op.approval!.id, decision, fence: work });
}
export function startRetry(m: LocalModel, sessionId = 'run1') {
  assert(claimRetryOp(m, sessionId).ok);
  return m.send({ type: 'LOCAL_STARTED', intentId: retryWork(m).id, operationId: retryOp(m).id, sessionId });
}
export function settleRetry(m: LocalModel, options: { uncertain?: boolean; failed?: boolean } = {}) {
  const op = retryOp(m);
  return m.send({ type: 'LOCAL_RESULT', intentId: retryWork(m).id, operationId: op.id, sessionId: op.sessionId,
    result: { ok: !options.failed && !options.uncertain, code: options.uncertain ? 'cancelled' : options.failed ? 'failed' : 'succeeded', data: { execution: 'host' } },
    settled: !options.uncertain, effectsKnown: !options.uncertain });
}
export function twoQueued() {
  const m = failedSandbox(false, true);
  assert(request(m).ok); assert(requestSecond(m).ok); assert(deliver(m).ok); claimRetryWork(m);
  return m;
}

export function secondWaitingBehindFirstBatch() {
  const m = failedSandbox(false, true);
  assert(request(m).ok);
  assert(deliver(m).ok);
  assert(requestSecond(m).ok);
  claimRetryWork(m);
  return m;
}

export function firstBatchReceiptSaved() {
  const m = secondWaitingBehindFirstBatch();
  prepareRetry(m);
  assert(decideRetry(m).ok);
  assert(startRetry(m).ok);
  assert(settleRetry(m).ok);
  return m;
}
