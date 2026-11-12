import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { WindowStdinUICase } from '../window-stdin-ui-case.mjs';

const cases = new WeakMap<object, WindowStdinUICase>();
const options = { timeout: 45_000 };
const current = (world: object) => { const fixture = cases.get(world); assert(fixture); return fixture; };
After(options, async function ({ result }) {
  const fixture = cases.get(this);
  if (result?.status !== 'PASSED') fixture?.markFailed(result?.message);
  await fixture?.close();
});
Given('当前任务的处理窗口已到期并保留可见成果', options, async function () {
  const fixture = new WindowStdinUICase('BT_Y149'); cases.set(this, fixture); await fixture.open();
});
When('用户关闭到期提示并重新载入当前会话', options, async function () { await current(this).closeAndReload(); });
Then('网页应显示WINDOW_EXPIRED且原窗口及待处理决定保持不变', options, async function () { await current(this).verifyExpired(); });
When('用户按默认时长明确授权新的处理窗口', options, async function () { await current(this).authorizeWindow(); });
Then('应通过当前人类门保存三小时续窗并保留已有成果及已用额度', options, async function () { await current(this).verifyAuthorizedWindow(); });
Given('当前成员申请读取工作区文件作为标准输入的宿主命令', options, async function () {
  const fixture = new WindowStdinUICase('BT_Y150'); cases.set(this, fixture); await fixture.open();
});
When('网页展示该命令的具体宿主授权', options, async function () { await current(this).showApproval(); });
Then('用户应看见输入相对路径字节数和内容指纹且文件正文不进入授权说明', options, async function () { await current(this).verifyInputPlan(); });
Then('未明确批准前进程不得启动且拒绝后不得将输入送入命令', options, async function () { await current(this).rejectInput(); });
