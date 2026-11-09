import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { LocalEffectsFixture, localEffectsModelGate } from '../local-effects-formal-fixture.js';
import type { SpecWorld } from './steps.js';

const fixtures = new WeakMap<SpecWorld, LocalEffectsFixture>();
const fixture = (world: SpecWorld) => { const value = fixtures.get(world); assert(value); return value; };
async function prepare(world: SpecWorld, prepared = true) {
  localEffectsModelGate(); const value = await new LocalEffectsFixture('sqlite').open(prepared); fixtures.set(world, value); return value;
}
After(async function (this: SpecWorld) { const value = fixtures.get(this); if (value) { await value.close(); fixtures.delete(this); } });
Given('已领取的本地命令只有准备日志而没有确定回执', async function (this: SpecWorld) { await prepare(this); });
When('执行宿主丢失并重复恢复该命令', async function (this: SpecWorld) {
  const value = fixture(this); await value.apply('Start'); await value.apply('Crash'); await value.apply('Reopen');
  value.reopen(); await value.apply('UnknownProbe');
});
Then('原命令不得重新领取且其他任务不得占用同一工程', async function (this: SpecWorld) {
  const value = fixture(this); await value.apply('BusyProbe'); const state = await value.state();
  assert.equal(state.op, 3); assert.equal(state.lease, 1); assert(state.pending); assert.equal(state.receipts, 0);
});
Given('本地命令已保存确定回执但任务尚未接收', async function (this: SpecWorld) {
  const value = await prepare(this); await value.apply('Start'); await value.apply('SaveReceipt');
});
When('恢复提交该回执时首次存储失败后重新提交并重复送达', async function (this: SpecWorld) {
  const value = fixture(this); await value.apply('Crash'); await value.apply('Reopen'); await value.apply('Rollback');
  await value.apply('Reopen'); await value.apply('Commit'); await value.apply('Duplicate');
});
Then('应只保存一次原结果且检查点与工程占用一起结算', async function (this: SpecWorld) {
  const value = fixture(this); const state = await value.state(); assert.equal(state.op, 4); assert.equal(state.receipts, 1);
  assert.equal(state.pending, false); assert.equal(state.lease, 0); await value.apply('Compete');
});
When('用户停止任务后宿主恢复并提交原回执', async function (this: SpecWorld) {
  const value = fixture(this); await value.apply('Stop'); await value.apply('Crash'); await value.apply('Reopen'); await value.apply('Commit');
});
Then('应释放原工程并保留停止且不得安排任务续办', async function (this: SpecWorld) {
  const value = fixture(this); const state = await value.state(); assert(state.stopped); assert.equal(state.lease, 0);
  assert.equal(value.context().candidate, null); assert.equal(value.engine.pending('original', 'task:start').filter(work => work.kind !== 'cancel').length, 0);
});
Given('已领取的本地命令尚未写入启动日志', async function (this: SpecWorld) { await prepare(this, false); });
When('恢复确认原命令未启动后重新领取并收到错误会话回执', async function (this: SpecWorld) {
  const value = fixture(this); value.reopen();
  const trusted = await value.journal.reconcile(value.operationId, value.sessionId); assert.equal(trusted?.resolution, 'notStarted');
  assert(value.send({ type: 'LOCAL_RECONCILE', intentId: value.work.id, operationId: value.operationId, sessionId: value.sessionId, ...trusted }).ok);
  value.work = value.engine.claim('original', 'task:start', value.work.id)!; assert(value.work);
  const next = value.engine.claimLocal('original', 'task:start', value.work.id, value.operationId, value.work.attempt);
  assert(next.response.ok); assert.notEqual(next.operation!.sessionId, value.sessionId); value.sessionId = next.operation!.sessionId!;
  await value.apply('WrongSession');
});
Then('应保留新领取身份和工程占用且只有匹配回执能够结算', async function (this: SpecWorld) {
  const value = fixture(this); const state = await value.state(); assert.equal(state.op, 1); assert.equal(state.lease, 1); assert(state.pending);
  await value.apply('SaveReceipt'); await value.apply('Commit'); assert.equal((await value.state()).receipts, 1);
});
