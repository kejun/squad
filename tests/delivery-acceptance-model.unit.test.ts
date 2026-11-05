import { describe, expect, it } from 'vitest';
import { acceptanceCriteria, deliveryJudgments, type CriterionJudgment } from '../src/delivery-acceptance.js';
import type { Intent } from '../src/types.js';
import { LocalModel } from './local-model-fixture.js';

function submit(model: LocalModel, work = model.work, id = 'candidate', text = '当前候选') {
  return model.send({ type: 'DELIVER', id, workId: work.id, text, artifactIds: [], fence: work, attempt: work.attempt });
}

function claim(model: LocalModel, kind: 'owner' | 'check') {
  const work = model.c.intents.find(item => item.kind === kind && item.status === 'pending')!;
  expect(model.send({ type: 'CLAIM', intentId: work.id }).ok).toBe(true);
  return model.c.intents.find(item => item.id === work.id)!;
}

function requestCheck(model: LocalModel) {
  const work = claim(model, 'check');
  expect(model.send({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt }).ok).toBe(true);
  return work;
}

function accept(model: LocalModel): CriterionJudgment[] {
  return model.c.candidate!.acceptance!.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed' }));
}

function report(model: LocalModel, work: Intent, criteriaResults?: CriterionJudgment[], resultId = `${work.id}:${work.attempt}`) {
  return model.send({ type: 'CHECK_RESULT', workId: work.id, fence: work, attempt: work.attempt, resultId,
    candidateRevision: model.c.candidate!.revision, criteriaResults });
}

const pendingOwner = (model: LocalModel) => model.c.intents.filter(work => work.kind === 'owner' && work.status === 'pending');

describe('bounded delivery acceptance model', () => {
  it('[BT_F14] retains direct requirements omitted by a validated input interpretation', () => {
    const model = new LocalModel(input => { input.goal.constraints = ['保留每一条用户硬约束']; });

    const criteria = acceptanceCriteria(model.c);

    expect(criteria).toContainEqual(expect.objectContaining({ text: '保留每一条用户硬约束', goalVersion: 1, sources: [{ kind: 'goal', id: 'M' }, { kind: 'input', id: 'M' }] }));
  });

  it('[BT_F15] publishes the candidate after one independent all-pass request', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const work = requestCheck(model);
    const results = accept(model);

    expect(report(model, work, results).ok).toBe(true);

    expect(model.c.outcome).toBe('complete');
    expect(model.c.publishedDelivery?.revision).toBe(model.c.candidate?.revision);
    expect(deliveryJudgments(model.c, model.c.candidate?.revision)).toEqual(results);
    expect(model.c.usage.checks).toBe(1);
  });

  it('[BT_F15] keeps the current check alive when a result has no attempt identity', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const work = requestCheck(model);

    const rejected = model.send({ type: 'CHECK_RESULT', workId: work.id, fence: work, candidateRevision: model.c.candidate!.revision,
      resultId: 'unbound', criteriaResults: accept(model) });

    expect(rejected.code).toBe('CHECK_WORK_REQUIRED');
    expect(report(model, work, accept(model)).ok).toBe(true);
    expect(model.c.outcome).toBe('complete');
  });

  it('[BT_M12] settles a claimed check without a model receipt as incomplete', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const work = claim(model, 'check');

    expect(model.send({ type: 'SETTLE', intentId: work.id, attempt: work.attempt }).ok).toBe(true);

    expect(model.snapshot.value).toBe('ended');
    expect(model.c.outcome).toBe('partial');
    expect(model.c.candidate?.deliveryIssue?.code).toBe('CHECK_NOT_COMPLETED');
    expect(model.c.usage.checks).toBe(0);
  });

  it('[BT_F14] lets a missing artifact consume the only automatic correction opportunity', () => {
    const model = new LocalModel(input => { input.goal.requiredArtifacts = 1; });
    expect(submit(model).ok).toBe(true);
    const repair = claim(model, 'owner');

    expect(submit(model, repair, 'unrepaired').ok).toBe(true);

    expect(model.c.outcome).toBe('partial');
    expect(model.c.candidate?.deliveryIssue?.code).toBe('MISSING_ARTIFACTS');
    expect(model.c.deliveryCycle?.revisionUsed).toBe(true);
    expect(model.c.usage.checks).toBe(0);
    expect(pendingOwner(model)).toEqual([]);
  });

  it('[BT_F14] settles missing artifacts without spending a correction when there is no check budget', () => {
    const model = new LocalModel(input => { input.goal.requiredArtifacts = 1; input.config.limits.checks = 0; });

    expect(submit(model).ok).toBe(true);

    expect(model.c.outcome).toBe('partial');
    expect(model.c.candidate?.deliveryIssue?.code).toBe('MISSING_ARTIFACTS');
    expect(pendingOwner(model)).toEqual([]);
  });

  it('[BT_F15] treats a missing criterion as a check failure, without scheduling author work', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const check = requestCheck(model);

    expect(report(model, check, accept(model).slice(0, 1)).ok).toBe(true);

    expect(model.snapshot.value).toBe('checking');
    expect(model.c.intents.find(item => item.id === check.id)?.status).toBe('pending');
    expect(model.c.deliveryCycle).toMatchObject({ requests: 1, retry: { status: 'reserved' }, revisionUsed: false });
    expect(pendingOwner(model)).toEqual([]);
  });

  it('[BT_F15] treats a quotation attributed to the wrong source as a technical failure', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const check = requestCheck(model);
    const [first, ...rest] = accept(model);

    expect(report(model, check, [{ ...first!, source: { id: 'wrong-source', quote: '原话' } }, ...rest]).ok).toBe(true);

    expect(model.c.deliveryCycle?.retry?.status).toBe('reserved');
    expect(deliveryJudgments(model.c, model.c.candidate?.revision)).toEqual([]);
    expect(model.c.outcome).toBeNull();
    expect(pendingOwner(model)).toEqual([]);
  });

  it('[BT_F15] settles an unverified finding without automatically rewriting the candidate', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const check = requestCheck(model);
    const [first, ...rest] = accept(model);

    expect(report(model, check, [{ ...first!, status: 'unverified', reason: '没有可核实的原资料' }, ...rest]).ok).toBe(true);

    expect(model.c.outcome).toBe('partial');
    expect(deliveryJudgments(model.c, model.c.candidate?.revision)?.[0]).toMatchObject({ status: 'unverified' });
    expect(pendingOwner(model)).toEqual([]);
  });

  it('[BT_F16] rechecks earlier passing requirements and settles a new regression after the only correction', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const first = requestCheck(model);
    const [a, b] = accept(model);
    expect(report(model, first, [{ ...a!, status: 'failed', reason: '把计划写成已完成' }, b!]).ok).toBe(true);
    const repair = claim(model, 'owner');
    expect(submit(model, repair, 'revised', '修订候选')).toMatchObject({ ok: true });
    const review = requestCheck(model);

    expect(report(model, review, [a!, { ...b!, status: 'failed', reason: '修订遗漏此前内容' }]).ok).toBe(true);

    expect(model.c.outcome).toBe('partial');
    expect(deliveryJudgments(model.c, model.c.candidate?.revision)?.[1]).toMatchObject({ reason: '修订遗漏此前内容' });
    expect(model.c.usage.checks).toBe(2);
    expect(pendingOwner(model)).toEqual([]);
  });

  it('[BT_F16] preserves an accepted user supplement before releasing the checked candidate', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const check = requestCheck(model);
    expect(model.send({ type: 'USER_INPUT', text: '补充新的限制' }).ok).toBe(true);

    expect(report(model, check, accept(model)).ok).toBe(true);

    expect(model.c.outcome).toBeNull();
    expect(model.c.inputs.every(input => input.applied)).toBe(true);
    expect(pendingOwner(model)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: 'Apply latest user input' }) })]);
  });

  it('[BT_F16] retains the finding when the remaining check budget cannot reserve a review', () => {
    const model = new LocalModel(input => { input.config.limits.checks = 1; });
    expect(submit(model).ok).toBe(true);
    const check = requestCheck(model);
    const [first, ...rest] = accept(model);

    expect(report(model, check, [{ ...first!, status: 'failed', reason: '缺少必需内容' }, ...rest]).ok).toBe(true);

    expect(model.c.outcome).toBe('partial');
    expect(deliveryJudgments(model.c, model.c.candidate?.revision)?.[0]?.reason).toBe('缺少必需内容');
    expect(pendingOwner(model)).toEqual([]);
  });

  it('[BT_M12] shares one technical retry across the first check, repair, and review', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const first = requestCheck(model);
    expect(report(model, first).ok).toBe(true);
    const retry = requestCheck(model);
    const [a, b] = accept(model);
    expect(report(model, retry, [{ ...a!, status: 'failed', reason: '需要修订' }, b!]).ok).toBe(true);
    const repair = claim(model, 'owner');
    expect(submit(model, repair, 'revised').ok).toBe(true);
    const review = requestCheck(model);

    expect(model.send({ type: 'WORK_FAILED', intentId: review.id, attempt: review.attempt, transient: true, reason: 'network timeout' }).ok).toBe(true);

    expect(model.snapshot.value).toBe('ended');
    expect(model.c.outcome).toBe('partial');
    expect(model.c.deliveryCycle).toMatchObject({ requests: 3, retry: { status: 'used' }, revisionUsed: true });
    expect(model.c.usage).toMatchObject({ checks: 3, retries: 1 });
  });

  it('[BT_M12] makes an authorized request survive recovery without restoring the technical retry', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const original = requestCheck(model);
    expect(model.send({ type: 'RECOVER', config: model.c.config }).ok).toBe(true);
    const replay = requestCheck(model);

    expect(model.send({ type: 'RECOVER', config: model.c.config }).ok).toBe(true);

    expect(replay.id).toBe(original.id);
    expect(model.c.outcome).toBe('partial');
    expect(model.c.usage).toMatchObject({ checks: 2, retries: 1 });
  });

  it('[BT_F16] spends no third ordinary check when trusted supplements interrupt two checked candidates', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const first = requestCheck(model);
    expect(model.send({ type: 'USER_INPUT', text: '补充第一项要求' }).ok).toBe(true);
    expect(report(model, first, accept(model)).ok).toBe(true);
    expect(submit(model, claim(model, 'owner'), 'second').ok).toBe(true);
    const second = requestCheck(model);
    expect(model.send({ type: 'USER_INPUT', text: '补充第二项要求' }).ok).toBe(true);
    expect(report(model, second, accept(model)).ok).toBe(true);

    expect(submit(model, claim(model, 'owner'), 'third').ok).toBe(true);

    expect(model.c.outcome).toBe('partial');
    expect(model.c.candidate?.deliveryIssue?.code).toBe('CHECK_BUDGET_EXHAUSTED');
    expect(model.c.usage.checks).toBe(2);
  });

  it('[BT_M12] rejects a repeated invalid check result without settling the retry permit', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const original = requestCheck(model);
    expect(report(model, original).ok).toBe(true);

    expect(report(model, original).ok).toBe(false);

    const replay = requestCheck(model);
    expect(report(model, replay, accept(model)).ok).toBe(true);
    expect(model.c.outcome).toBe('complete');
    expect(model.c.usage).toMatchObject({ checks: 2, retries: 1 });
  });

  it('[BT_M12] rejects a repeated transient failure without settling the retry permit', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const original = requestCheck(model);
    const failure = { type: 'WORK_FAILED', id: 'network:1', intentId: original.id, attempt: original.attempt, transient: true, reason: 'network timeout' };
    expect(model.send(failure).ok).toBe(true);

    expect(model.send(failure).ok).toBe(false);

    expect(model.c.outcome).toBeNull();
    expect(model.c.intents.find(work => work.id === original.id)?.status).toBe('pending');
    expect(model.c.usage).toMatchObject({ checks: 1, retries: 1 });
  });

  it('[BT_F16] applies a trusted supplement after restart even when the interrupted check has no retry left', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const first = requestCheck(model);
    expect(report(model, first).ok).toBe(true);
    requestCheck(model);
    expect(model.send({ type: 'USER_INPUT', text: '补充交付要求' }).ok).toBe(true);

    expect(model.send({ type: 'RECOVER', config: model.c.config }).ok).toBe(true);

    expect(model.snapshot.value).toBe('running');
    expect(model.c.outcome).toBeNull();
    expect(model.c.inputs[0]?.applied).toBe(true);
    expect(model.c.usage).toMatchObject({ checks: 2, retries: 1 });
    expect(pendingOwner(model)).toHaveLength(1);
  });

  it('[BT_F10] rejects a result arriving after the user stopped the task', () => {
    const model = new LocalModel();
    expect(submit(model).ok).toBe(true);
    const check = requestCheck(model);
    expect(model.send({ type: 'STOP', text: '停止' }).ok).toBe(true);

    expect(report(model, check, accept(model)).ok).toBe(false);

    expect(model.c.outcome).toBe('stopped');
    expect(model.c.publishedDelivery).toBeUndefined();
    expect(model.c.usage.checks).toBe(1);
  });
});
