import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { WebCompositionBrowser } from '../web-composition-browser.js';
import { InspectorGenerationFixture } from '../inspector-generation-fixture.js';
import { verifyWebCompositionModels } from '../web-composition-model-gate.js';
import type { SpecWorld } from './steps.js';

const browsers = new WeakMap<SpecWorld, WebCompositionBrowser>();
const inspectors = new WeakMap<SpecWorld, InspectorGenerationFixture>();
const browser = (world: SpecWorld) => { const fixture = browsers.get(world); assert(fixture); return fixture; };
const inspector = (world: SpecWorld) => { const fixture = inspectors.get(world); assert(fixture); return fixture; };
const timeout = { timeout: 125_000 };
After(timeout, async function (this: SpecWorld) { inspectors.get(this)?.close(); await browsers.get(this)?.close(); });
Given('两个真实群聊中原群的{string}消息已提交但网页没有收到回执', timeout, async function (this: SpecWorld, kind: string) {
  verifyWebCompositionModels();
  const fixture = await WebCompositionBrowser.start('BT_U20', kind); browsers.set(this, fixture); await fixture.step('prepare');
});
When('用户在另一群成功发送后返回原群重试保留的消息', timeout, async function (this: SpecWorld) { await browser(this).step('interleave'); });
Then('原群重试应保持同一请求标识与完整载荷', timeout, async function (this: SpecWorld) { await browser(this).step('identity'); });
Then('原群只应保存一次该消息并且另一群消息与草稿保持隔离', timeout, async function (this: SpecWorld) { await browser(this).step('persisted'); });
Given('原群的真实快照请求已发出且其{string}响应尚未交付', timeout, async function (this: SpecWorld, result: string) {
  verifyWebCompositionModels();
  const fixture = await WebCompositionBrowser.start('BT_U21', result); browsers.set(this, fixture);
  await fixture.step('prepare');
});
When('用户切换到另一群并在旧快照完成后继续接收当前群快照', timeout, async function (this: SpecWorld) { await browser(this).step('interleave'); });
Then('页面应继续显示当前群的消息与连接状态且不能混入旧群内容', timeout, async function (this: SpecWorld) { await browser(this).step('current'); });
Given('第一代官方观察窗口尚在装载时已关闭并打开第二代窗口', function (this: SpecWorld) {
  verifyWebCompositionModels(); const fixture = new InspectorGenerationFixture(); inspectors.set(this, fixture); fixture.prepare();
});
When('两代观察装载按{string}完成且旧代{string}', async function (this: SpecWorld, order: string, result: string) { await inspector(this).complete(order, result); });
Then('只有当前窗口可以导航和注册最新身份且旧代不得发送或覆盖当前状态', function (this: SpecWorld) { inspector(this).assertCurrent(); });
Then('关闭观察控制器后所有监听应释放且迟到握手不能再发送快照', function (this: SpecWorld) { inspector(this).close(); });
