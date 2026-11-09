import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { BrowserContract } from '../browser-contract-fixture.js';
import type { SpecWorld } from './steps.js';

const browsers = new WeakMap<SpecWorld, BrowserContract>();
const driver = (world: SpecWorld) => { const value = browsers.get(world); assert(value); return value; };
async function start(world: SpecWorld, scenario: string, command?: string) {
  const browser = await BrowserContract.start(scenario);
  browsers.set(world, browser);
  if (command) await browser.step(command);
}
const timeout = { timeout: 125_000 };
After(timeout, async function (this: SpecWorld) { await browsers.get(this)?.close(); });
Given('已启动有效配置的应用', timeout, async function (this: SpecWorld) { await start(this, 'BT_U01'); });
When('用户打开群聊', timeout, async function (this: SpecWorld) { await driver(this).step('openRoom'); });
Then('应能新建和切换群、输入消息、使用点名补全和停止当前工作', timeout, async function (this: SpecWorld) { await driver(this).step('basics'); });
Then('执行时输入框应提示"补充当前工作"', timeout, async function (this: SpecWorld) { await driver(this).step('placeholder'); });
Then('不应要求进入设置、任务看板或审批页面才能完成协作', timeout, async function (this: SpecWorld) { await driver(this).step('singlePage'); });
Then('执行中补充与等待回复原因应可见且停止后能在原任务继续', timeout, async function (this: SpecWorld) { await driver(this).step('inputAndContinue'); });
Then('协助失败后应能从原求助入口重试并交回原负责人', timeout, async function (this: SpecWorld) { await driver(this).step('retryFromHelp'); });
Given('当前任务经历接单、执行和等待协助', timeout, async function (this: SpecWorld) { await start(this, 'BT_U02', 'prepareState'); });
When('页面接收这些状态变化', timeout, async function (this: SpecWorld) { await driver(this).step('receiveStates'); });
Then('应更新同一任务的状态行', timeout, async function (this: SpecWorld) { await driver(this).step('sameRow'); });
Then('时间线只应保留实际发言、求助、回复和必要协调提示', timeout, async function (this: SpecWorld) { await driver(this).step('timeline'); });
Then('原始工具明细默认应折叠', timeout, async function (this: SpecWorld) { await driver(this).step('collapsed'); });
Given('{string}已有工具调用、输出、错误与产物记录', timeout, async function (this: SpecWorld, agent: string) { assert.equal(agent, 'A'); await start(this, 'BT_U03', 'prepareDetails'); });
When('用户点击任务状态或{string}的过程入口', timeout, async function (this: SpecWorld, agent: string) { assert.equal(agent, 'A'); await driver(this).step('openDetails'); });
Then('应能在同一详情区域切换查看任务摘要或成员执行记录', timeout, async function (this: SpecWorld) { await driver(this).step('sharedDetails'); });
Then('记录应包含来源关联与简短调度理由', timeout, async function (this: SpecWorld) { await driver(this).step('detailSources'); });
Then('不应把模型隐藏推理列为必需可见字段', timeout, async function (this: SpecWorld) { await driver(this).step('noHiddenReasoning'); });
Then('任务和成员入口应能查看同一产物的来源与版本', timeout, async function (this: SpecWorld) { await driver(this).step('artifactVersion'); });
Given('后端宿主已经关机或休眠', timeout, async function (this: SpecWorld) { await start(this, 'BT_U09', 'prepareOffline'); });
When('用户查看仍然打开的页面', timeout, async function (this: SpecWorld) { await driver(this).step('observeOffline'); });
Then('页面应如实显示连接不可用', timeout, async function (this: SpecWorld) { await driver(this).step('disconnected'); });
Then('不应显示宿主离线期间新产生的执行进展', timeout, async function (this: SpecWorld) { await driver(this).step('noOfflineProgress'); });
Then('活动任务刷新和宿主重连应恢复同一任务及已保存记录', timeout, async function (this: SpecWorld) { await driver(this).step('reconnect'); });
Then('发送回执丢失后重试不应重复保存消息或派发任务', timeout, async function (this: SpecWorld) { await driver(this).step('lostReceiptRetry'); });
