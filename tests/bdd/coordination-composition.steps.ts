import assert from 'node:assert/strict';
import { When, Then } from '@cucumber/cucumber';
import { runCompositionScenario, type CompositionScenarioResult } from '../coordination-composition-fixture.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, CompositionScenarioResult>();
const run = (world: SpecWorld) => { const value = runs.get(world); assert(value); return value; };
When('交错执行讨论成员领取结果和负责人额外请求', async function (this: SpecWorld) {
  runs.set(this, await runCompositionScenario('DiscussionBudget', '', ['Claim1', 'AdditionalRequest', 'DeniedRequest', 'Claim2', 'Return2', 'Return1', 'ClaimSummary', 'ReturnSummary', 'Handoff', 'ClaimSuccessor']));
});
Then('额外请求应在保留边界被拒绝且所有成员和负责人仍能续办', function (this: SpecWorld) {
  assert.partialDeepStrictEqual(run(this).final, { member1: 2, member2: 2, summary: 3, handoff: true, successor: true, used: 7, reserve: 0 });
});
When(/^已领取的「(.+)」请求尝试重复取得外部请求授权$/, async function (this: SpecWorld, name: string) {
  const variants: Record<string, string> = { 成员评审: 'review', 协助重试: 'retry', 宿主续办并行讨论: 'host', 工程验证修订: 'verification' };
  assert(variants[name]); runs.set(this, await runCompositionScenario('ReservedRequests', variants[name], ['FirstRequest', 'AdditionalRequest', 'DeniedRequest']));
});
Then('首次请求使用已付额度且后续请求不得耗尽保留费用', function (this: SpecWorld) {
  const result = run(this); assert.equal(result.observations[0]!.used, result.observations[1]!.used);
  assert.equal(Number(result.final.used), Number(result.observations[0]!.used) + 1); assert.equal(result.final.requests, 2);
  assert.deepEqual(result.observations.at(-1), result.observations.at(-2));
});
When(/^在「(.+)」追加复杂补充并结算旧工作$/, async function (this: SpecWorld, boundary: string) {
  const actions = boundary === '协助结果保存前' ? ['Supplement', 'Save', 'Recover', 'Flush', 'ClaimAnalysis', 'Resolve']
    : boundary === '协助结果保存后' ? ['Save', 'Supplement', 'Recover', 'Flush', 'ClaimAnalysis', 'Resolve']
      : ['Supplement', 'ReturnCheck', 'ClaimAnalysis', 'Clarify', 'Continue', 'ClaimAnalysis', 'Resolve'];
  runs.set(this, await runCompositionScenario('InputBoundary', boundary === '旧候选检查中' ? 'check' : 'help', actions));
});
Then('应先处理旧交接再解释补充且只安排一次当前负责人', function (this: SpecWorld) {
  assert.partialDeepStrictEqual(run(this).final, { consumed: true, applied: true, analysis: 3, owner: 1, evidence: false });
});
Then('未解释补充不得被旧检查发布为完成', function (this: SpecWorld) {
  assert(run(this).observations.every(value => value.published === false));
});
When(/^「(.+)」因「(.+)」结束后恢复且原效果为「(.+)」$/, async function (this: SpecWorld, origin: string, cancellation: string, effect: string) {
  const mode = ({ 目标变化: 'goal', 用户停止: 'stop', 本轮终结: 'end' } as Record<string, string>)[cancellation]; assert(mode);
  const physical = effect === '有待核对操作';
  const actions = ['Cancel', 'Reopen', ...(physical ? ['BlockedContinue', 'KnownReceipt', 'Reopen'] : []),
    ...(mode === 'goal' ? [] : ['Continue']), 'ClaimOwner', 'Invite', 'ClaimPlanner', 'Plan', 'ClaimNew1', 'ClaimNew2', 'Late1', 'Late2'];
  runs.set(this, await runCompositionScenario('CancelledDiscussion', `${origin === '并行分片' ? 'map' : 'discussion'}-${mode}-${physical ? 'physical' : 'safe'}`, actions));
});
Then('已知旧工作应退休而未知效果应先阻止继续', function (this: SpecWorld) {
  const result = run(this); assert.equal(result.final.work1, 2); assert.equal(result.final.work2, 2);
  const unknown = result.observations.find(value => value.local === 2); if (unknown) assert.equal(unknown.work1, 4);
});
Then('可信结算后两位成员应能参加新轮次且旧结果不能推进它', function (this: SpecWorld) {
  assert.partialDeepStrictEqual(run(this).final, { newStage: 3, new1: true, new2: true });
  assert.deepEqual(run(this).observations.at(-1), run(this).observations.at(-3));
});
When('成员意见经过保存恢复消费失败修复和重复送达', async function (this: SpecWorld) {
  runs.set(this, await runCompositionScenario('ReviewQueue', '', ['Claim1', 'Failure1', 'Recover', 'Flush1', 'Claim2', 'Success2', 'Flush2', 'RetryFirst', 'Claim1', 'Success1', 'Flush1', 'Late1', 'Late2']));
});
Then('评审完成成员应唯一且修复保留其他成员结果', function (this: SpecWorld) {
  assert.partialDeepStrictEqual(run(this).final, { completed1: true, completed2: true, result1: 1, result2: 1, incomplete: false });
});
Then('每次完整收集只生成一个有效负责人汇总', function (this: SpecWorld) {
  assert.partialDeepStrictEqual(run(this).final, { round: 1, syntheses: 2, liveOwner: true, retried: true });
});
When(/^相同失败达到阈值后经过「(.+)」$/, async function (this: SpecWorld, following: string) {
  const tail = following === '工具结算' ? ['Settle'] : following === '服务恢复' ? ['Recover'] : ['Stop', 'LateSignal', 'Settle'];
  runs.set(this, await runCompositionScenario('DeferredCoordination', '', ['FailureSignal', 'ChangeFingerprint', 'FailureSignal', 'Activity', 'EvidencedProgress', ...tail]));
});
Then('新进展与普通活动应保持各自含义且延期协调不会重复或丢失', function (this: SpecWorld) {
  const result = run(this); assert.equal(result.observations[4]!.failures, 2); assert.equal(result.observations[5]!.failures, 0);
  assert.equal(result.observations[4]!.deferred, true); assert.equal(result.observations[5]!.deferred, true);
  assert.equal(result.final.coordinations, result.final.stopped ? 0 : 1);
});
