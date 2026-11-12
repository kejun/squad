import { After, Before, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { ForceRoomDeletionBrowserCase } from '../force-room-deletion-browser-case.mjs';
import { ForceRoomDeletionCase } from '../force-room-deletion-case.js';

const cases = new WeakMap<SpecWorld, ForceRoomDeletionCase>();
const time = { timeout: 20_000 };
Before(time, function (this: SpecWorld, { pickle }) {
  const id = pickle.tags.find(t => /^@BT_Y16[2-6]$/.test(t.name))?.name.slice(1);
  if (id) cases.set(this, new ForceRoomDeletionCase(id));
});
After(time, async function (this: SpecWorld) { await cases.get(this)?.close(); });
for (const step of ['归档会话有未决宿主操作和独占资源锁', '归档会话的运行文件暂时不能清理',
  '归档会话的旧删除作业正在等待核对', '归档会话的客户端版本已经过期', '强制删除请求的来源或目标不合法']) {
  Given(step, time, async function (this: SpecWorld) { await cases.get(this)!.given(); });
}
for (const step of ['用户直接删除该归档会话', '服务处理这些删除请求']) {
  When(step, time, async function (this: SpecWorld) { await cases.get(this)!.act(); });
}
for (const step of ['会话数据应立即删除并从列表消失且所属锁被释放',
  '会话应保持已删除且后台清理重启后继续', '应拒绝请求并保留全部非目标数据']) {
  Then(step, time, async function (this: SpecWorld) { await cases.get(this)!.verify(); });
}
Then('其他会话和共享文件应保持完整', time, async function (this: SpecWorld) { await cases.get(this)!.preserved(); });

const browsers = new WeakMap<SpecWorld, ForceRoomDeletionBrowserCase>();
After({ timeout: 20_000 }, async function (this: SpecWorld, { result }) {
  const fixture = browsers.get(this);
  if (result?.status !== 'PASSED') fixture?.markFailed(result?.message);
  await fixture?.close();
});
Given('用户正在浏览包含未决操作的归档会话', { timeout: 45_000 }, async function (this: SpecWorld) {
  const fixture = new ForceRoomDeletionBrowserCase('BT_Y167'); browsers.set(this, fixture); await fixture.open();
});
When('用户点击该会话的删除操作', { timeout: 20_000 }, async function (this: SpecWorld) { await browsers.get(this)!.act(); });
Then('不应出现确认或核对弹窗且该会话应从列表移除', { timeout: 20_000 }, async function (this: SpecWorld) { await browsers.get(this)!.verify(); });
Then('刷新后该会话仍不存在且其他会话可以访问', { timeout: 20_000 }, async function (this: SpecWorld) { await browsers.get(this)!.verifyDeletionAfterServiceRestart(); await browsers.get(this)!.verify(); });
