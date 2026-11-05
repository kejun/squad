import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { acceptanceCriteria, type CriterionCoverage, type CriterionJudgment, type DeliveryReference } from '../../src/delivery-acceptance.js';
import { OpenAICompatibleAdapter, WorkRunner } from '../../src/index.js';
import { Harness, type EventBody } from '../helpers.js';
import { regenerationConfig, modelResponse } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

type Delivery = Extract<EventBody, { type: 'DELIVER' }>;
type Case = { delivery?: Delivery; missingCriterion?: string };
const cases = new WeakMap<SpecWorld, Case>();
const state = (world: SpecWorld) => {
  let value = cases.get(world);
  if (!value) { value = {}; cases.set(world, value); }
  return value;
};
const textRef: DeliveryReference = { kind: 'candidateText' };
function coverage(world: SpecWorld, ref = textRef): CriterionCoverage[] {
  return acceptanceCriteria(world.h.context()).map(criterion => ({ criterionId: criterion.id, refs: [ref] }));
}
function completeOwner(world: SpecWorld, text: string, refs = coverage(world)) {
  const owner = world.h.claim('owner');
  assert(world.h.event({ type: 'DELIVER', text, artifactIds: [], workId: owner.id, fence: owner, coverage: refs }).ok);
}
function rejectCriterion(world: SpecWorld) {
  const check = world.h.claim('check');
  const criteria = acceptanceCriteria(world.h.context());
  const results: CriterionJudgment[] = criteria.map((criterion, index) => index === 0
    ? { criterionId: criterion.id, status: 'gap', reason: '原报告第一段把计划写成完成', kind: 'content_error', refs: [textRef] }
    : { criterionId: criterion.id, status: 'passed' });
  assert(world.h.event({ type: 'CHECK_RESULT', resultId: check.id, workId: check.id, fence: check, passed: false, gaps: [], criteriaResults: results }).ok);
  return criteria;
}
Given('任务有必需验收项且负责人提交的候选{string}', function (this: SpecWorld, problem: string) {
  this.h = new Harness();
  const work = this.h.claim('owner');
  let refs = coverage(this);
  const criterionId = refs[0]!.criterionId;
  if (problem.includes('遗漏')) refs = refs.slice(1);
  else if (problem.includes('已失效')) refs[0] = { criterionId, refs: [{ kind: 'artifact', id: '失效文件' }] };
  else {
    const action = { type: 'runCli' as const, executable: 'node', args: ['read-data.js'] };
    const operation = this.h.engine.requestLocal(this.h.room, this.h.task, work.id, work.attempt, action, [], 'test-workspace');
    const claimed = this.h.engine.claimLocal(this.h.room, this.h.task, work.id, operation.id, work.attempt);
    assert(claimed.response.ok && claimed.operation?.sessionId);
    const identity = { intentId: work.id, operationId: operation.id, sessionId: claimed.operation.sessionId };
    assert(this.h.event({ type: 'LOCAL_STARTED', ...identity }).ok);
    assert(this.h.event({ type: 'LOCAL_RESULT', ...identity, result: { ok: false, code: 'EXIT_NONZERO', data: { stdout: '缺少正文', truncated: false } }, settled: true, effectsKnown: true }).ok);
    refs[0] = { criterionId, refs: [{ kind: 'evidence', id: operation.id }] };
  }
  state(this).delivery = { type: 'DELIVER', id: 'structured-delivery', text: '候选已有可用内容', artifactIds: [], workId: work.id, fence: work, coverage: refs };
  state(this).missingCriterion = criterionId;
});
When('系统处理候选并收到相同提交的重复通知', function (this: SpecWorld) {
  const event = state(this).delivery!;
  assert(this.h.event(event).ok);
  this.h.event(event);
});
Then('应记录该验收项及当前候选的具体缺口', function (this: SpecWorld) {
  assert(this.h.context().deliveryGaps?.some(gap => gap.criterionId === state(this).missingCriterion
    && gap.candidateRevision === this.h.context().candidate?.acceptance?.revision && gap.reason));
});
Then('应保留已有成果并在有额度时只安排一次负责人修订', function (this: SpecWorld) {
  assert.equal(this.h.context().candidate?.text, '候选已有可用内容');
  assert.deepEqual(this.h.engine.pending(this.h.room, this.h.task).map(work => work.kind), ['owner']);
});
Then('应在覆盖完整后才安排独立检查', function (this: SpecWorld) {
  assert.equal(this.h.context().usage.checks, 0);
  completeOwner(this, '补齐验收覆盖后的新候选');
  assert.deepEqual(this.h.engine.pending(this.h.room, this.h.task).map(work => work.kind), ['check']);
});
Given('当前候选覆盖全部必需验收项且已进入独立检查', function (this: SpecWorld) {
  this.h = new Harness(regenerationConfig());
  completeOwner(this, '候选形式完整');
});
When('检查员给出总体通过但{string}', async function (this: SpecWorld, problem: string) {
  const criteria = acceptanceCriteria(this.h.context());
  const criterionId = criteria[0]!.id;
  const results: CriterionJudgment[] = criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed' }));
  if (problem.includes('遗漏')) results.shift();
  else results[0] = { criterionId, status: problem.includes('无法') ? 'unknown' : 'gap', reason: problem };
  state(this).missingCriterion = criterionId;
  const adapter = new OpenAICompatibleAdapter(this.h.config, { clock: () => this.h.now, transport: async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    assert.match(payload.messages[0]!.content, /criteriaResults/);
    assert(payload.messages[1]!.content.includes(criterionId));
    return modelResponse({ type: 'check', passed: true, gaps: [], criteriaResults: results });
  } });
  assert(await new WorkRunner(this.h.engine, adapter, () => this.h.now).runOne(this.h.room, this.h.task));
});
Then('该候选不得发布', function (this: SpecWorld) {
  assert.equal(this.h.context().outcome, null);
  assert(!this.h.context().messages.some(message => message.kind === 'final'));
});
Then('用户应能看到尚未验收的要求和关联候选版本', function (this: SpecWorld) {
  const c = this.h.context();
  assert(c.deliveryGaps?.some(gap => gap.criterionId === state(this).missingCriterion && gap.candidateRevision === c.candidate?.acceptance?.revision));
  assert(c.reason);
});
Given('已检查的候选发现一项内容错误且其他必需验收项曾通过', function (this: SpecWorld) {
  this.h = new Harness();
  completeOwner(this, '计划写成了完成');
  const criteria = rejectCriterion(this);
  state(this).missingCriterion = criteria[1]!.id;
});
When('负责人修复该错误但新候选遗漏了另一项原有要求', function (this: SpecWorld) {
  completeOwner(this, '修正为仍在计划阶段', coverage(this).filter(item => item.criterionId !== state(this).missingCriterion));
});
Then('该要求仍应保留在验收清单中', function (this: SpecWorld) {
  assert(this.h.context().candidate?.acceptance?.criteria.some(criterion => criterion.id === state(this).missingCriterion));
  assert(this.h.context().deliveryGaps?.some(gap => gap.criterionId === state(this).missingCriterion));
});
Then('新候选需要补齐并重新独立检查才可发布', function (this: SpecWorld) {
  assert.equal(this.h.context().outcome, null);
  completeOwner(this, '修复内容错误并恢复原有要求');
  const work = this.h.claim('check');
  const results: CriterionJudgment[] = acceptanceCriteria(this.h.context()).map(criterion => ({ criterionId: criterion.id, status: 'passed' }));
  assert(this.h.event({ type: 'CHECK_RESULT', workId: work.id, fence: work, resultId: work.id, passed: true, gaps: [], criteriaResults: results }).ok);
  assert.equal(this.h.context().outcome, 'complete');
});
