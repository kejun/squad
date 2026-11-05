import { describe, expect, it } from 'vitest';
import { acceptanceCriteria, type CriterionCoverage, type CriterionJudgment, type DeliveryReference } from '../src/delivery-acceptance.js';
import { LocalModel } from './local-model-fixture.js';

const support: DeliveryReference = { kind: 'candidateText' };
const cover = (model: LocalModel, ref: DeliveryReference = support): CriterionCoverage[] => acceptanceCriteria(model.c).map(criterion => ({ criterionId: criterion.id, refs: [ref] }));
const judgments = (model: LocalModel): CriterionJudgment[] => acceptanceCriteria(model.c).map(criterion => ({ criterionId: criterion.id, status: 'passed' }));
function deliver(model: LocalModel, id: string, coverage: CriterionCoverage[], text = '当前候选') {
  const work = model.c.intents.find(item => item.kind === 'owner' && item.status === 'inflight')!;
  return model.send({ type: 'DELIVER', id, workId: work.id, text, artifactIds: [], coverage, fence: work, attempt: work.attempt });
}
function claim(model: LocalModel, kind: 'owner' | 'check') {
  const work = model.c.intents.find(item => item.kind === kind && item.status === 'pending')!;
  expect(model.send({ type: 'CLAIM', intentId: work.id }).ok).toBe(true);
  return model.c.intents.find(item => item.id === work.id)!;
}
function check(model: LocalModel, results: CriterionJudgment[], passed = true) {
  const work = claim(model, 'check');
  return model.send({ type: 'CHECK_RESULT', workId: work.id, fence: work, attempt: work.attempt,
    resultId: work.id, passed, gaps: [], criteriaResults: results });
}

describe('versioned delivery acceptance model', () => {
  it('[BT_F14] retains direct requirements omitted by a validated input interpretation', () => {
    const model = new LocalModel(input => { input.goal.constraints = ['保留每一条用户硬约束']; });

    const criteria = acceptanceCriteria(model.c);

    expect(criteria).toContainEqual(expect.objectContaining({ text: '保留每一条用户硬约束', goalVersion: 1, sources: [{ kind: 'goal', id: 'M' }, { kind: 'input', id: 'M' }] }));
  });

  it('[BT_F14] records missing coverage and schedules only one owner repair across duplicate delivery', () => {
    const model = new LocalModel();
    const coverage = cover(model).slice(0, 1);
    const missing = acceptanceCriteria(model.c)[1]!.id;

    expect(deliver(model, 'delivery-1', coverage).ok).toBe(true);
    const duplicate = model.send({ type: 'DELIVER', id: 'delivery-1', text: '当前候选', artifactIds: [], coverage });

    expect(model.snapshot.value).toBe('running');
    expect(model.c.deliveryGaps).toEqual([expect.objectContaining({ criterionId: missing, kind: 'missing_requirement' })]);
    expect(model.c.intents.filter(item => item.kind === 'owner' && item.status === 'pending')).toHaveLength(1);
    expect(model.c.intents.some(item => item.kind === 'check')).toBe(false);
    expect(duplicate.code).toBe('DUPLICATE_RESULT');
  });

  it('[BT_F14] cannot use a failed receipt as coverage for evidence acquisition', () => {
    const model = new LocalModel();
    expect(model.request().ok).toBe(true);
    expect(model.claim().ok).toBe(true);
    expect(model.started().ok).toBe(true);
    expect(model.result({ result: { ok: false, code: 'EXIT_NONZERO', data: { stdout: 'partial', truncated: false } } }).ok).toBe(true);

    expect(deliver(model, 'failed-evidence', cover(model, { kind: 'evidence', id: 'op1' })).ok).toBe(true);

    expect(model.c.deliveryGaps).toContainEqual(expect.objectContaining({ kind: 'missing_evidence', refs: [{ kind: 'evidence', id: 'op1' }] }));
    expect(model.c.intents.some(item => item.kind === 'check')).toBe(false);
  });

  it('[BT_F14] settles the candidate and unmet requirement when repair is out of budget', () => {
    const model = new LocalModel(input => { input.config.limits.ordinary = 1; });

    expect(deliver(model, 'out-of-budget', []).ok).toBe(true);

    expect(model.snapshot.value).toBe('ended');
    expect(model.c.outcome).toBe('partial');
    expect(model.c.candidate?.text).toBe('当前候选');
    expect(model.c.deliveryGaps).toHaveLength(2);
    expect(model.c.intents.some(item => item.kind === 'check' || item.status === 'pending')).toBe(false);
  });

  it('[BT_F15] refuses a positive overall judgment that omits a required criterion', () => {
    const model = new LocalModel();
    expect(deliver(model, 'candidate', cover(model)).ok).toBe(true);

    expect(check(model, judgments(model).slice(0, 1)).ok).toBe(true);

    expect(model.c.outcome).toBeNull();
    expect(model.c.deliveryGaps).toEqual([expect.objectContaining({
      criterionId: acceptanceCriteria(model.c)[1]!.id, candidateRevision: model.c.candidate!.acceptance!.revision,
    })]);
    expect(model.snapshot.value).toBe('running');
  });

  it('[BT_F16] preserves the input handoff when a negative check arrives after an update', () => {
    const model = new LocalModel();
    expect(deliver(model, 'candidate', cover(model)).ok).toBe(true);
    const work = claim(model, 'check');
    expect(model.send({ type: 'USER_INPUT', text: '补充新的限制' }).ok).toBe(true);

    expect(model.send({ type: 'CHECK_RESULT', workId: work.id, fence: work, attempt: work.attempt, resultId: work.id,
      passed: false, gaps: ['仍需核实'], criteriaResults: [] }).ok).toBe(true);

    expect(model.c.outcome).toBeNull();
    expect(model.c.inputs.every(input => input.applied)).toBe(true);
    expect(model.c.intents.filter(item => item.status === 'pending' && item.kind === 'owner')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ reason: 'Apply latest user input' }) }),
    ]);
  });

  it('[BT_F15] only publishes a positive judgment on every required criterion', () => {
    const model = new LocalModel();
    expect(deliver(model, 'candidate', cover(model)).ok).toBe(true);

    expect(check(model, judgments(model)).ok).toBe(true);

    expect(model.c.outcome).toBe('complete');
    expect(model.c.deliveryAssessments?.[0]?.judgments).toEqual(judgments(model));
  });

  it('[BT_F16] requires an earlier passing criterion after a different criterion is repaired', () => {
    const model = new LocalModel();
    const criteria = acceptanceCriteria(model.c);
    expect(deliver(model, 'candidate', cover(model)).ok).toBe(true);
    expect(check(model, [{ criterionId: criteria[0]!.id, status: 'gap', reason: '已完成的说法没有依据' },
      { criterionId: criteria[1]!.id, status: 'passed' }], false).ok).toBe(true);
    claim(model, 'owner');

    expect(deliver(model, 'updated', cover(model).slice(0, 1), '补了第一项但遗漏另一项').ok).toBe(true);

    expect(model.c.outcome).toBeNull();
    expect(model.c.deliveryGaps).toEqual([expect.objectContaining({ criterionId: criteria[1]!.id, kind: 'missing_requirement' })]);
    expect(model.c.usage.checks).toBe(1);
  });

  it('[BT_F14] stops a new submission with the same unresolved candidate from creating another repair', () => {
    const model = new LocalModel();
    expect(deliver(model, 'original', []).ok).toBe(true);
    claim(model, 'owner');

    expect(deliver(model, 'unchanged', []).ok).toBe(true);

    expect(model.c.outcome).toBe('partial');
    expect(model.c.intents.filter(item => item.kind === 'owner')).toHaveLength(2);
  });
});
