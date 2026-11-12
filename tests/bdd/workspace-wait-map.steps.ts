import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { WorkspaceWaitMapAcceptance } from '../workspace-wait-map-acceptance.js';

const fixtures = new WeakMap<SpecWorld, WorkspaceWaitMapAcceptance>();
const fixture = (world: SpecWorld) => { const value = fixtures.get(world); assert(value); return value; };
const timeout = { timeout: 20000 };
After(timeout, async function (this: SpecWorld) { await fixtures.get(this)?.close(); fixtures.delete(this); });
Given('八份资料已排成八个分片且四名成员并行读取前四份', timeout, async function (this: SpecWorld) {
  const current = new WorkspaceWaitMapAcceptance(); fixtures.set(this, current); await current.open();
});
Given('网页只取得登录欢迎页而没有正文且一个读取失败后接续第五份', timeout, async function (this: SpecWorld) {
  await fixture(this).readLoginPagesAndAdvanceFifth();
});
When('四名成员改用宿主命令且均被已停止旧任务的未决资源阻塞', timeout, async function (this: SpecWorld) {
  await fixture(this).blockAllFourFallbacks();
});
Then('当前会话应在原窗口到期前显示资源等待及精确旧操作核对入口', timeout, function (this: SpecWorld) {
  fixture(this).assertPromptBeforeDeadline();
});
Then('排队命令不得被当作有效执行或待批准且未取正文不得算读取成功', timeout, function (this: SpecWorld) {
  fixture(this).assertNoFalseExecutionOrSource();
});
Then('监督检查不得隐去此阻塞或派出重复读取来冒充进展', timeout, function (this: SpecWorld) {
  fixture(this).assertSupervisionKeepsVisibleWait();
});

Then('原窗口到期等待续窗期间仍应保留实际旧操作核对入口', timeout, function (this: SpecWorld) {
  fixture(this).assertExpiredResourceRecovery();
});
