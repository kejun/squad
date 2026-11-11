import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { CompositionProcess } from '../web-composition-browser.js';
import type { SpecWorld } from './steps.js';

const cases = new WeakMap<SpecWorld, CompositionProcess>();
const fixture = (world: SpecWorld) => { const current = cases.get(world); assert(current); return current; };
const timeout = { timeout: 125_000 };
async function start(world: SpecWorld, scenario: string, variant = '') {
  const test = await CompositionProcess.start(scenario, variant, 'tests/service-composition-driver.mjs', ['./tests/service-composition-fault-loader.mjs', 'tsx']);
  cases.set(world, test); await test.step('prepare');
}
After(timeout, async function (this: SpecWorld) { await cases.get(this)?.close(); });
Given('真实数据库有两个待核对的本地操作且启动正等待第一条核对', timeout, async function (this: SpecWorld) { await start(this, 'BT_K03'); });
When('用户关闭服务后第一条核对返回', timeout, async function (this: SpecWorld) { await fixture(this).step('act'); });
Then('服务应完成关闭且不能发起第二条核对或新的模型请求', timeout, async function (this: SpecWorld) { await fixture(this).step('scope'); });
Given('服务已就绪且有一条尚待提交的用户消息', timeout, async function (this: SpecWorld) { await start(this, 'BT_K04'); });
When('服务提交该消息登记工作后在执行微任务之前关闭', timeout, async function (this: SpecWorld) { await fixture(this).step('act'); });
Then('已提交消息应保留且模型和工具均不得启动', timeout, async function (this: SpecWorld) { await fixture(this).step('scope'); });
Given('一个服务工作已经登记且模型响应由可控屏障保持', timeout, async function (this: SpecWorld) { await start(this, 'BT_K05'); });
When('同轮按{string}发生定时唤醒重复提交和模型完成', timeout, async function (this: SpecWorld, order: string) {
  // The public driver receives each complete order before constructing its held work.
  const test = fixture(this); await test.step('order:' + order);
});
Then('每条工作应只进入一次执行器且一次领取预算与结果交接保持一致', timeout, async function (this: SpecWorld) { await fixture(this).step('scope'); });
Given('两个房间已经登记工作而第一笔领取事务将发生真实SQLite提交故障', timeout, async function (this: SpecWorld) { await start(this, 'BT_K06'); });
When('服务处理该故障并再次接收定时唤醒和提交', timeout, async function (this: SpecWorld) { await fixture(this).step('act'); });
Then('本服务所有房间都不得启动新的模型或工具请求', timeout, async function (this: SpecWorld) { await fixture(this).step('scope'); });
Then('关闭故障实例并重新打开同一数据库后应能恢复正常执行', timeout, async function (this: SpecWorld) { await fixture(this).step('reopen'); });
Given('一个房间的执行器发生了不是模型WorkFailure的宿主故障', timeout, async function (this: SpecWorld) { await start(this, 'BT_K07'); });
When('监督检查前该房间收到补充且另一房间完成正常工作并随后到达监督时机', timeout, async function (this: SpecWorld) { await fixture(this).step('act'); });
Then('故障房间应先隔离再由真实恢复沿原处理窗口和预算继续推进且不重复未决效果', timeout, async function (this: SpecWorld) { await fixture(this).step('scope'); });
Then('重新打开同一数据库应保留已结算结果且不重复执行', timeout, async function (this: SpecWorld) { await fixture(this).step('reopen'); });
