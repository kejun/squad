import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { AutomaticWindowExpiryFixture } from '../automatic-window-expiry-fixture.js';

const fixtures = new WeakMap<object, AutomaticWindowExpiryFixture>();
const current = (world: object) => { const fixture = fixtures.get(world); assert(fixture); return fixture; };
After({ tags: '@BT_Y154' }, function () { fixtures.get(this)?.close(); });
Given('{string}中的任务正在等待{string}且原窗口尚未到期', function (storage: string, problem: string) {
  fixtures.set(this, new AutomaticWindowExpiryFixture(storage, problem));
});
When('宿主时钟到达硬期限并自动唤醒且随后重启', function () { current(this).advanceAndRecover(); });
Then('应仅记录一次WINDOW_EXPIRED并保留原门身份与已用预算', function () { current(this).assertObserved(); });
Then('已记录到期且没有清理责任时不应再次按旧截止时间唤醒', function () {
  const fixture = current(this); fixture.assertObserved(); assert.equal(fixture.h.engine.nextWake(fixture.h.room), null);
});
Then('有效续窗应恢复新期限监督且不兼容配置不能借续窗获准执行', function () { current(this).assertRenewalWake(); });
