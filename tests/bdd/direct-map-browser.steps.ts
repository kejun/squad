import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { DirectMapDeliveryBrowserCase } from '../direct-map-delivery-browser-case.mjs';
const browsers = new WeakMap<SpecWorld, DirectMapDeliveryBrowserCase>();
const timeout = { timeout: 30_000 };
After(timeout, async function (this: SpecWorld, { result }) {
  const fixture = browsers.get(this);
  if (result?.status !== 'PASSED') fixture?.markFailed(result?.message);
  await fixture?.close();
});
Given('真实网页的八个子Agent会返回七个失败和一个成功', timeout, async function (this: SpecWorld) {
  const fixture = new DirectMapDeliveryBrowserCase(); browsers.set(this, fixture); await fixture.open();
});
When('用户提交汇总可用内容并列出失败项的任务', timeout, async function (this: SpecWorld) { await browsers.get(this)!.act(); });
Then('网页应展示普通交付结果且不再执行补救申报', timeout, async function (this: SpecWorld) { await browsers.get(this)!.verify(); });
Then('成功分片不应重跑且失败正文和文件不应被当作交付', timeout, async function (this: SpecWorld) { await browsers.get(this)!.verify(); });
