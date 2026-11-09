import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { candidateJudgments, Harness } from './helpers.js';

/** Pure real-XState scenario prerequisite; no adapter, HTTP, timer, or file I/O. */
export function verifyModelResponseFailureGate() {
  const owner = new Harness();
  const work = owner.claim('owner');
  assert(owner.event({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok);
  assert(owner.event({ type: 'WORK_FAILED', intentId: work.id, attempt: work.attempt, fence: work,
    reason: 'MODEL_RESPONSE_TOO_LARGE', transient: false }).ok);
  assert.equal(owner.view().phase, 'waitingHuman');
  assert.equal(owner.context().candidate, null);
  assert.equal(owner.context().usage.retries, 0);
  assert.equal(owner.engine.pending(owner.room, owner.task).length, 0);

  const check = new Harness();
  const author = check.claim('owner');
  assert(check.event({ type: 'DELIVER', workId: author.id, text: '完整候选', artifactIds: [] }).ok);
  const review = check.authorizeCheck();
  assert(check.event({ type: 'WORK_FAILED', intentId: review.id, attempt: review.attempt, fence: review,
    reason: 'MODEL_RESPONSE_TOO_LARGE', transient: false }).ok);
  assert.equal(check.view().phase, 'ended');
  assert.equal(check.context().outcome, 'partial');
  assert.equal(check.context().usage.retries, 0);
  assert.equal(check.context().publishedDelivery, undefined);
  assert.equal(check.engine.pending(check.room, check.task).length, 0);
  assert.equal(check.event({ type: 'CHECK_RESULT', resultId: 'late-check', workId: review.id, attempt: review.attempt, fence: review,
    candidateRevision: check.context().candidate!.revision!, criteriaResults: candidateJudgments(check.context().candidate) }).ok, false);

  const stopped = new Harness();
  const active = stopped.claim('owner');
  assert(stopped.event({ type: 'CONSUME', intentId: active.id, attempt: active.attempt, fence: active }).ok);
  assert(stopped.event({ type: 'STOP' }).ok);
  assert.equal(stopped.event({ type: 'DELIVER', workId: active.id, attempt: active.attempt, fence: active,
    text: '不得发布的迟到结果', artifactIds: [] }).ok, false);
  assert.equal(stopped.context().candidate, null);
  return { owner: 'waitingHuman/no retry', check: 'ended/partial/no publication/no retry', stop: 'late result rejected' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifyModelResponseFailureGate()));
