import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Actor } from 'xstate';
import { disposedImportContract } from '../inspector-contract-fixture.js';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { InspectorFixture } from '../inspector-fixture.js';
import { inspectorOrigin } from '../../src/inspector.machine.js';
import type { SpecWorld } from './steps.js';
import { InspectorTabFixture } from '../inspector-tab-fixture.js';

const cases = new WeakMap<SpecWorld, { test: InspectorFixture; order: string; count: number }>();
const state = (world: SpecWorld) => { const value = cases.get(world); assert(value); return value; };
const tabs = new WeakMap<SpecWorld, { test: InspectorTabFixture; count: number; source?: InspectorTabFixture['tab']; session?: string }>();
const tab = (world: SpecWorld) => { const value = tabs.get(world); assert(value); return value; };
After(async function (this: SpecWorld) { cases.get(this)?.test.observer?.stop(); await tabs.get(this)?.test.close(); });
Given('官方Inspector的握手在页面加载事件{string}到达', function (this: SpecWorld, order: string) {
  cases.set(this, { test: new InspectorFixture(), order, count: 0 });
});
When('打开官方Inspector并在握手前后更新所选真实模型快照', function (this: SpecWorld) {
  const { test, order } = state(this);
  const start = mock.method(Actor.prototype, 'start'), send = mock.method(Actor.prototype, 'send');
  try {
  if (order === '之前') {
    // A synchronous navigation handshake arrives before open() even returns.
    test.open(true, 'fixture', test.latest());
  } else {
    assert.equal(order, '之后');
    test.open(false); test.observer!.update(test.latest()); test.handshake();
  }
  test.observer!.update(test.initial());
  assert.equal(start.mock.calls.length, 0); assert.equal(send.mock.calls.length, 0);
  } finally { start.mock.restore(); send.mock.restore(); }
});
Then('该连接的首条消息应包含真实机器定义和最新所选快照', function (this: SpecWorld) {
  state(this).test.assertRegistration();
});
Then('后续事件与快照只能关联已经注册的同一actor且不启动业务actor', function (this: SpecWorld) {
  state(this).test.assertOrdered();
});
Given('一个已经连接的官方Inspector观察通道', function (this: SpecWorld) {
  const test = new InspectorFixture(); test.open(); cases.set(this, { test, order: '', count: test.messages.length });
});
When('其他窗口或来源发送握手且官方标签页重新连接', function (this: SpecWorld) {
  const value = state(this), { test } = value;
  test.handshake(inspectorOrigin, {}); test.handshake('https://example.org'); test.handshake('null');
  assert.equal(test.messages.length, value.count);
  test.observer!.update(test.latest()); value.count = test.messages.length; test.handshake();
});
Then('只有指定标签页与官方来源的握手可以重发当前actor注册', function (this: SpecWorld) {
  const { test, count } = state(this); test.assertRegistration(test.messages[count]); test.assertOrdered();
});
When('关闭观察通道后所选快照再次变化', function (this: SpecWorld) {
  const value = state(this); value.test.observer!.stop(); assert.equal(value.test.messages.at(-1)?.type, '@statelyai.disconnected'); value.count = value.test.messages.length;
  value.test.observer!.update(value.test.initial());
  value.test.staleListener?.({ data: { type: '@statelyai.connected' }, source: value.test.source, origin: inspectorOrigin });
});
Then('不得再发送消息且真实任务快照与预算保持不变', function (this: SpecWorld) {
  if (tabs.has(this)) {
    const { test, count } = tab(this); assert.equal(test.tab.messages.length, count); test.assertRegistration(); return;
  }
  const { test, count } = state(this); assert.equal(test.messages.length, count); assert.equal(test.closedCount, 1); test.observer!.stop(); assert.equal(test.closedCount, 1); test.assertOrdered();
});

Given('调试面板选中了一个真实模型快照', async function (this: SpecWorld) {
  const test = new InspectorTabFixture(); tabs.set(this, { test, count: 0 }); await test.open();
});
When('点击官方Inspector入口并再次点击', async function (this: SpecWorld) {
  const { test } = tab(this); await test.click(); await test.navigated(); await test.handshake(); await test.click();
});
Then('应同步打开一个顶层标签页并保留官方握手所需的opener且不创建iframe', function (this: SpecWorld) {
  const { test } = tab(this); test.assertOpened(); test.assertRegistration();
});
Then('第二次点击应聚焦已有标签页而不重新导航或新建标签页', function (this: SpecWorld) {
  const { test } = tab(this); test.assertOpened(); assert.equal(test.tab.focused, 1);
});
Then('本地应说明官方401需要在Stately页面登录且本地图仍可使用', function (this: SpecWorld) {
  assert(tab(this).test.ui.text.includes('如出现401，请在Stately页面登录'));
  assert(document.querySelector('[aria-label="本次运行轨迹"]'));
});
Given('浏览器阻止官方Inspector的新标签页', async function (this: SpecWorld) {
  const test = new InspectorTabFixture(); tabs.set(this, { test, count: 0 }); await test.open(true);
});
When('点击官方Inspector入口', async function (this: SpecWorld) { await tab(this).test.click(); });
Then('应显示允许弹窗后重试的提示且不得发送观察数据', function (this: SpecWorld) {
  assert(document.querySelector('[role="alert"]')?.textContent?.includes('允许弹窗'));
  assert.equal(tab(this).test.tabs.length, 0);
});
When('浏览器允许新标签页并再次点击入口', async function (this: SpecWorld) {
  const { test } = tab(this); await test.ui.sendHelp(); test.blocked = false; await test.click(); await test.navigated();
});
Then('官方握手后应先注册最新所选快照且不启动业务actor', async function (this: SpecWorld) {
  const { test } = tab(this); await test.handshake(); test.assertRegistration(); assert.equal(test.tab.messages[0]?.snapshot?.value, 'waitingAssistance');
});
Given('一个已经连接的官方Inspector标签页', async function (this: SpecWorld) {
  const test = new InspectorTabFixture(); tabs.set(this, { test, count: 0 });
  await test.open(); await test.click(); await test.navigated(); await test.handshake();
});
When('调试面板切换到另一沙箱身份', async function (this: SpecWorld) {
  const value = tab(this); value.session = value.test.tab.messages[0]!.sessionId!; value.source = value.test.tab;
  await value.test.ui.click('新建沙箱');
});
Then('应在原标签页先注册新actor再发送其快照且不重载登录页面', function (this: SpecWorld) {
  const { test, session, source } = tab(this); assert.equal(test.tab, source); assert.equal(test.tab.navigations.length, 1);
  const registration = test.tab.messages.filter(message => message.type === '@xstate.actor').at(-1)!;
  assert.notEqual(registration.sessionId, session); test.assertRegistration();
});
When('用户关闭标签页后重新点击入口', async function (this: SpecWorld) {
  const { test } = tab(this); test.tab.closed = true; await test.click(); await test.navigated();
});
Then('应打开新的标签页并拒绝旧标签页的迟到握手', async function (this: SpecWorld) {
  const { test, source } = tab(this); assert.notEqual(test.tab, source); assert.equal(test.openCalls.length, 2);
  await test.handshake(source); assert.equal(test.tab.messages.length, 0); await test.handshake(); test.assertRegistration();
});
When('关闭调试面板后所选快照再次变化', async function (this: SpecWorld) {
  const value = tab(this); await value.test.close(); value.count = value.test.tab.messages.length;
  await value.test.handshake();
});

Then('SDK尚未加载时关闭面板也不应启动观察', disposedImportContract);
