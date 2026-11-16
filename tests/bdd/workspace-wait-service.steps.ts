import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { WorkspaceWaitAcceptance, workspaceWaitConflictMatrix } from '../workspace-wait-acceptance.js';

const cases = new WeakMap<SpecWorld, WorkspaceWaitAcceptance>();
const current = (world: SpecWorld) => { const value = cases.get(world); assert(value); return value; };
const timeout = { timeout: 25_000 };
After(timeout, async function (this: SpecWorld) { await cases.get(this)?.close(); });
Given('两个已停止旧任务的未决执行仍占用新会话命令需要的资源', timeout, async function (this: SpecWorld) {
  const fixture = new WorkspaceWaitAcceptance(); cases.set(this, fixture); await fixture.open(2);
});
When('新会话排队命令等待且用户读取当前会话', timeout, async function (this: SpecWorld) { await current(this).wait(); });
Then('当前会话应显示全部实际阻塞来源和旧操作核对入口', timeout, async function (this: SpecWorld) { await current(this).verifySources(); });
Then('兼容读取无关资源与已结算旧操作不得误列为阻塞', timeout, async function () { await workspaceWaitConflictMatrix(); });
Then('任一旧操作未结算时新命令仍不得启动或获得伪造授权', timeout, async function (this: SpecWorld) { await current(this).verifyPartialSettlement(); });

Given('当前会话的宿主命令正在等待其他会话的未决资源', timeout, async function (this: SpecWorld) {
  const fixture = new WorkspaceWaitAcceptance(); cases.set(this, fixture); await fixture.open(1); await fixture.wait();
});
When('最后一个阻塞操作经{string}解除资源占用', timeout, async function (this: SpecWorld, mode: string) { await current(this).settleLast(mode); });
Then('原排队命令应获得实际唤醒并提出自己的精确宿主授权', function (this: SpecWorld) {
  assert.equal(current(this).result?.originalTypedWaiterWoken, true); assert.equal(current(this).result?.currentApprovalVisible, true);
});
Then('只有明确批准新命令后才允许启动且不得重放旧操作', function (this: SpecWorld) {
  assert.equal(current(this).result?.approvedStarts, 1); assert.equal(current(this).result?.oldProcessStarts, 1);
});
