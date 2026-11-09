import assert from 'node:assert/strict';
import { MapModel } from './map-model-gate-fixture.js';
import { persistTask, restoreTask } from '../src/task.machine.js';
import type { CheckReviewSource } from '../src/delivery-acceptance.js';

export function completedMapModel() {
  const model = new MapModel(); model.interpret();
  const first = model.claim(model.pending('assistance')[0]!);
  const second = model.claim(model.pending('assistance')[0]!);
  assert(model.send({ type: 'DISCUSSION_RESULT', discussionId: first.discussionId!, workId: first.id,
    fence: first, text: '甲来源完整证据', status: 'success', artifacts: [{ name: 'alpha.md', content: '甲附件原文' }] }).ok);
  assert(model.answer(second).ok);
  assert(model.answer(model.claim(model.pending('discussionSummary')[0]!)).ok);
  return model;
}
export function submitMapDelivery(model: MapModel) {
  const owner = model.claim(model.pending('owner')[0]!);
  assert(model.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '完整归并报告', artifactIds: [] }).ok);
  return model.pending('check')[0]!;
}
export function mapDeliveryModelGate() {
  const model = completedMapModel(), work = submitMapDelivery(model);
  const records = work.payload.reviewRecords as CheckReviewSource[];
  assert.equal(records.length, 2, 'Both saved map results must reach the fixed delivery check');
  const first = JSON.parse(records[0]!.content);
  assert.partialDeepStrictEqual(first, { member: 'B', status: 'success', partition: { id: 'alpha', objective: '研究甲来源', expectedOutput: '甲证据' },
    question: '研究甲来源', expected: '甲证据', answer: '甲来源完整证据', artifacts: [{ name: 'alpha.md', content: '甲附件原文' }] });
  assert(records[0]!.stdout!.includes('甲来源完整证据'));
  assert(records[0]!.stdout!.includes('甲附件原文'));
  const frozen = structuredClone(records);
  model.snapshot = restoreTask(persistTask(model.snapshot));
  assert.deepEqual(model.pending('check')[0]!.payload.reviewRecords, frozen);
  const check = model.claim(model.pending('check')[0]!);
  assert(model.send({ type: 'CONSUME', intentId: check.id, fence: check, attempt: check.attempt }).ok);
  const criteriaResults = model.context.candidate!.acceptance!.criteria.map(item => ({ criterionId: item.id, status: 'passed' as const,
    source: { id: records[0]!.id, quote: '甲来源完整证据' } }));
  assert(model.send({ type: 'CHECK_RESULT', workId: check.id, attempt: check.attempt, fence: check,
    resultId: 'map-check-result', candidateRevision: model.context.candidate!.revision!, criteriaResults }).ok);
  assert.equal(model.context.outcome, 'complete');
}
export function oldMapDeliveryModelGate() {
  const model = completedMapModel();
  assert(model.send({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
  const work = submitMapDelivery(model);
  assert.deepEqual(work.payload.reviewRecords, []);
}
