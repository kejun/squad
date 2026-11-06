import assert from 'node:assert/strict';
import { initialTask, persistTask, restoreTask, stepTask, taskPhase, type TaskSnapshot } from '../src/task.machine.js';
import type { ArtifactDraft, Intent, TaskEvent } from '../src/types.js';
import type { CriterionJudgment } from '../src/delivery-acceptance.js';
import { configuration, type EventBody } from './helpers.js';

const original = { name: 'report.md', content: 'original content' };

function task() {
  const config = configuration();
  return initialTask({
    taskId: 'version-task', owner: 'A', config: { ...config, inputAnalysis: { enabled: false } },
    goal: { text: 'Write a report', criteria: [], constraints: [], requiredArtifacts: 1 },
    at: 0, message: { id: 'M1', taskId: 'version-task', at: 0, text: 'Write a report', author: 'user', kind: 'user' },
  });
}

function send(state: TaskSnapshot, event: EventBody) {
  const at = state.context.trace.length + 1;
  return stepTask(state, { id: `event-${at}`, at, ...event } as TaskEvent);
}

function claim(state: TaskSnapshot, kind: Intent['kind']) {
  const work = state.context.intents.find(item => item.status === 'pending' && item.kind === kind)!;
  const next = send(state, { type: 'CLAIM', intentId: work.id });
  assert.equal(next.context.reply.ok, true);
  return { next, work: next.context.intents.find(item => item.id === work.id)! };
}

function deliver(state: TaskSnapshot, ...drafts: ArtifactDraft[]) {
  const { next, work } = claim(state, 'owner');
  return send(next, { type: 'DELIVER', workId: work.id, text: 'Report summary', artifactIds: [], artifacts: drafts });
}

function check(state: TaskSnapshot, passed = true) {
  const { next, work } = claim(state, 'check');
  const candidate = next.context.candidate!;
  const consumed = send(next, { type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt });
  assert.equal(consumed.context.reply.ok, true);
  const criteriaResults: CriterionJudgment[] = candidate.acceptance!.criteria.map(item => passed
    ? { criterionId: item.id, status: 'passed' }
    : { criterionId: item.id, status: 'failed', reason: 'revise' });
  const output = { type: 'CHECK_RESULT' as const, workId: work.id, fence: work, attempt: work.attempt,
    candidateRevision: candidate.revision!, resultId: `result:${work.id}`, criteriaResults };
  return { next: send(consumed, output), output };
}

export function replacementVersionModelGate() {
const published = check(deliver(task(), original)).next;
const previous = published.context.artifacts[0]!;
const candidate = deliver(send(published, { type: 'CONTINUE' }), { name: 'renamed.md', content: 'revised', replacesArtifactId: previous.id });
assert.deepEqual(candidate.context.publishedDelivery?.artifactIds, [previous.id]);
assert.partialDeepStrictEqual(candidate.context.artifacts[1], { documentId: previous.documentId, revision: 2, replacesArtifactId: previous.id });
const revised = check(candidate).next;
assert.deepEqual(revised.context.publishedDelivery?.artifactIds, [candidate.context.artifacts[1]!.id]);
assert.deepEqual(revised.context.messages.find(message => message.kind === 'final')?.artifactIds, [previous.id]);
assert.deepEqual(revised.context.artifacts[0], previous);
}

export function sameNameVersionModelGate() {
const published = check(deliver(task(), original, { ...original, content: 'another report' })).next;

assert.deepEqual(published.context.publishedDelivery?.artifactIds, published.context.artifacts.map(artifact => artifact.id));
assert.equal(new Set(published.context.artifacts.map(artifact => artifact.documentId)).size, 2);
}

export function staleVersionModelGate() {
const first = deliver(task(), original);
const artifactId = first.context.artifacts[0]!.id;
const old = check(first, false);
const second = deliver(old.next, { ...original, content: 'revision', replacesArtifactId: artifactId });
const rejectedCheck = send(second, { ...old.output, resultId: 'late-check',
      criteriaResults: old.output.criteriaResults.map(item => ({ criterionId: item.criterionId, status: 'passed' })) });
assert.equal(rejectedCheck.context.reply.ok, false);
assert.equal(taskPhase(rejectedCheck), 'checking');
assert.equal(rejectedCheck.context.publishedDelivery, undefined);
const failed = check(rejectedCheck, false).next;
assert.equal(failed.context.outcome, 'partial');
const pending = send(failed, { type: 'CONTINUE' });
const stale = deliver(pending, { ...original, content: 'stale revision', replacesArtifactId: artifactId });
assert.equal(stale.context.reply.ok, false);
assert.equal(stale.context.candidate?.revision, second.context.candidate?.revision);
assert.deepEqual(stale.context.artifacts, second.context.artifacts);
}

export function unboundVersionModelGate() {
const first = deliver(task(), original);
const failed = check(first, false).next;
const current = deliver(failed, { ...original, content: 'new independent draft' });
const late = send(current, { type: 'CHECK_RESULT', resultId: 'unbound-late', criteriaResults: [] });
assert.equal(late.context.reply.code, 'CHECK_WORK_REQUIRED');
assert.equal(late.context.publishedDelivery, undefined);
assert.equal(taskPhase(late), 'checking');
}

export function legacyVersionModelGate() {
const completed = check(deliver(task(), original, { ...original, content: 'second report' })).next;
const legacy = structuredClone(persistTask(completed)) as { context: TaskSnapshot['context'] };
delete legacy.context.publishedDelivery;
legacy.context.artifacts.forEach(artifact => { delete artifact.documentId; delete artifact.revision; });
const [first, other] = legacy.context.artifacts;
const next = deliver(send(restoreTask(legacy), { type: 'CONTINUE' }), { ...original, content: 'updated', replacesArtifactId: first!.id });

assert.deepEqual(next.context.publishedDelivery?.artifactIds, [first!.id, other!.id]);
assert.partialDeepStrictEqual(next.context.artifacts[2], { documentId: first!.id, revision: 2, replacesArtifactId: first!.id });
assert.deepEqual(next.context.artifacts.slice(0, 2), [first, other]);
}
