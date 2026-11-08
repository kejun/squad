import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { DiscussionRecoveryFixture } from '../discussion-recovery-fixture.js';
import {
  prepareDiscussionRecoveryModel, recoverDiscussionModel, inviteRecoveredMembersModel,
  historicalCancelledDiscussionModelGate, uncertainDiscussionModelGate, reconciledDiscussionModelGate,
  removedDiscussionMemberModelGate, type DiscussionRecoveryCase, type RecoveryChange, type RecoveryWork, type PhysicalStage,
} from '../map-model-gate-fixture.js';
import type { SpecWorld } from './steps.js';

interface State { fixture: DiscussionRecoveryFixture; model?: DiscussionRecoveryCase }
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { const value = states.get(world); assert(value); return value; };
After(function (this: SpecWorld) { const value = states.get(this); if (value) { value.fixture.close(); states.delete(this); } });

Given('两个{string}成员已领取工作后发生{string}', async function (this: SpecWorld, kind: RecoveryWork, change: RecoveryChange) {
  const model = prepareDiscussionRecoveryModel(kind, change);
  const fixture = new DiscussionRecoveryFixture(kind, change); states.set(this, { fixture, model });
  await fixture.prepare(); fixture.cancel();
});
When('服务恢复两次并继续当前目标后再次邀请原成员讨论', async function (this: SpecWorld) {
  const value = state(this);
  if (value.model) { recoverDiscussionModel(value.model); inviteRecoveredMembersModel(value.model); }
  await value.fixture.recoverAndInvite();
});
Then('两名成员都应可参与新讨论且旧模型工作不会重新派发', function (this: SpecWorld) { state(this).fixture.assertMembersReturned(); });
Then('旧结果仍应被拒绝且不得触发旧归并或改变新轮次', function (this: SpecWorld) { state(this).fixture.assertLateResultsRejected(); });

Given('已取消分片的本地命令处于{string}且效果尚未核对', async function (this: SpecWorld, stage: PhysicalStage) {
  uncertainDiscussionModelGate(stage);
  const fixture = new DiscussionRecoveryFixture(); states.set(this, { fixture });
  await fixture.preparePhysical(stage); fixture.cancel();
});
When('服务恢复两次并处理取消请求', async function (this: SpecWorld) { await state(this).fixture.recoverPhysical(); });
Then('该成员及工程占用应保留且不能重新执行旧命令或发起新归并', function (this: SpecWorld) { state(this).fixture.assertPhysicalRetained(); });

Given('历史快照中的取消轮次仍留下待领的安全模型工作', async function (this: SpecWorld) {
  historicalCancelledDiscussionModelGate();
  const fixture = new DiscussionRecoveryFixture(); states.set(this, { fixture });
  await fixture.prepare(); fixture.cancel(); fixture.historicalPending();
});

Given('同一目标的讨论已结束但成员命令仍待核对', async function (this: SpecWorld) {
  reconciledDiscussionModelGate();
  const fixture = new DiscussionRecoveryFixture(); states.set(this, { fixture });
  await fixture.preparePhysical('已退出但效果未知'); fixture.finishCurrentGoal();
});
When('宿主提交匹配会话的已知结算回执', function (this: SpecWorld) { state(this).fixture.reconcile(); });
Then('应释放该成员及工程占用并保持旧轮次结束且不重新排队', function (this: SpecWorld) { state(this).fixture.assertReconciled(); });

Given('已取消分片的原成员已不在当前团队中', async function (this: SpecWorld) {
  removedDiscussionMemberModelGate();
  const fixture = new DiscussionRecoveryFixture(); states.set(this, { fixture });
  await fixture.prepare(); fixture.cancel();
});
When('按当前团队配置恢复任务', function (this: SpecWorld) { state(this).fixture.recoverWithoutMember(); });
Then('应退休旧安全工作并让当前负责人继续且不恢复旧成员权限', async function (this: SpecWorld) { await state(this).fixture.assertRemovedMemberRetired(); });
