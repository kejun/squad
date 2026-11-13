import assert from 'node:assert/strict';
import { Harness, candidateJudgments } from './helpers.js';
function reviewed(status: 'success' | 'partial' = 'success') {
  const h = new Harness();
  h.event({ type: 'HELP', caller: 'A', requestId: 'review-request', target: 'B', question: '完整候选正文：金额100', expected: '逐项审查' });
  h.event({ type: 'HELP_RESULT', requestId: 'review-request', resultId: 'review-result', status, answer: '核查金额100，建议补充来源' });
  return h;
}
function submit(h: Harness) {
  assert.equal(h.event({ type: 'DELIVER', text: '交付', artifactIds: [] }).ok, true);
  return [...h.context().intents].reverse().find(work => work.kind === 'check')!;
}

export async function* freezesConsumedReviewRequestAndAnswerThroughRecovery() {
const h = reviewed();
yield 'prepared';
const work = submit(h);
h.reopen();
const records = h.context().intents.find(item => item.id === work.id)!.payload.reviewRecords as { id: string; content: string }[];
yield 'observed';
assert.equal((records).length, 1);
assert.equal(records[0]!.id, 'review-result');
assert.partialDeepStrictEqual(JSON.parse(records[0]!.content), { requestId: 'review-request', member: 'B', status: 'success', question: '完整候选正文：金额100', answer: '核查金额100，建议补充来源' });
h.store.close();
}

export async function* acceptsAVerbatimCitationToTheFrozenReviewResultAtTheStateBoundary() {
const h = reviewed();
yield 'prepared';
submit(h);
const check = h.authorizeCheck();
const results = candidateJudgments(h.context().candidate).map(item => ({ ...item, source: { id: 'review-result', quote: '核查金额100，建议补充来源' } }));
h.checkResult(check, results);
yield 'observed';
assert.equal(h.context().outcome, 'complete');
h.store.close();
}

export async function* rejectsAFabricatedQuoteFromARealReviewResult() {
const h = reviewed();
yield 'prepared';
submit(h);
const check = h.authorizeCheck();
const results = candidateJudgments(h.context().candidate).map(item => ({ ...item, source: { id: 'review-result', quote: '并不存在的审查结论' } }));
h.checkResult(check, results);
yield 'observed';
assert.equal(h.context().outcome, 'complete');
assert(h.context().publishedDelivery);
h.store.close();
}

export async function* preservesPartialReviewStatusWithoutConvertingItToSuccess() {
const h = reviewed('partial');
yield 'prepared';
const work = submit(h);
yield 'observed';
assert.equal(JSON.parse((work.payload.reviewRecords as { content: string }[])[0]!.content).status, 'partial');
h.store.close();
}

export async function* excludesACompletedReviewForAnOldGoal() {
const h = reviewed();
yield 'prepared';
h.event({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', criteria: [], constraints: [], requiredArtifacts: 0 } });
const records = submit(h).payload.reviewRecords;
yield 'observed';
assert.deepEqual(records, []);
h.store.close();
}

export async function* excludesAPendingRequestWithoutAConsumedMemberResult() {
const h = new Harness();
h.help();
yield 'prepared';
assert.equal(h.event({ type: 'DELIVER', text: '交付', artifactIds: [] }).ok, false);
yield 'observed';
assert.equal(h.context().intents.some(work => work.kind === 'check'), false);
h.store.close();
}
