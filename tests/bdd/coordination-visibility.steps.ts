import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { CoordinationVisibilityAcceptance } from '../coordination-visibility-acceptance.js';
const fixtures = new WeakMap<SpecWorld, CoordinationVisibilityAcceptance>();
const current = (world: SpecWorld) => { const fixture = fixtures.get(world); assert(fixture); return fixture; };
const timeout = { timeout: 20_000 };
After(timeout, async function (this: SpecWorld) { await fixtures.get(this)?.close(); });
Given('多个会话同时包含执行中排队待授权未决核对和已结束的任务', timeout, async function (this: SpecWorld) {
  const fixture = new CoordinationVisibilityAcceptance(); fixtures.set(this, fixture); await fixture.open();
});
When('协调模型请求经历{string}', timeout, async function (this: SpecWorld, boundary: string) { await current(this).exercise(boundary); });
Then('协调输入应包含所有会话任务成员及实际启动资源依赖授权核对和窗口状态', function (this: SpecWorld) { current(this).verifyGlobal(); });
Then('最新状态应在下一次请求可见且观察不得批准解锁或改变任何任务', function (this: SpecWorld) { current(this).verifyReadonly(); });
