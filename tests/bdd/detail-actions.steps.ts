import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { buildDetailDocument } from '../../web/src/detail-document.js';
import {
  A_EVENT, B_EVENT, DetailActionsFixture, detailSnapshot, FOREIGN_BODY, HTML_BODY,
  OLD_BODY, OLD_SOURCE, REPORT_BODY, TRACE_DETAIL, UNLINKED_BODY, type DetailView,
} from '../detail-actions-fixture.js';
import type { SpecWorld } from './steps.js';

interface DetailState {
  fixture: DetailActionsFixture;
  view: DetailView;
  expected?: string;
  extension?: string;
  tab?: string;
  before?: string;
}
const states = new WeakMap<SpecWorld, DetailState>();
function state(world: SpecWorld) { const value = states.get(world); assert(value); return value; }
function messageView(): DetailView { return { snapshot: detailSnapshot(), target: { taskId: 'old-task', messageId: 'old-message' } }; }
async function setup(world: SpecWorld, view = messageView(), mode: DetailActionsFixture['clipboardMode'] = 'resolved') {
  const fixture = new DetailActionsFixture(view); fixture.clipboardMode = mode;
  states.set(world, { fixture, view }); await fixture.mount(); return fixture;
}
async function transfer(world: SpecWorld) {
  const f = state(world).fixture; await f.click('复制详情'); await f.click('导出详情');
  assert.equal(f.copies.length, 1); assert.equal(f.downloads.length, 1);
  assert.equal(await f.downloadText(), f.copies[0]!.text);
}
After(async function (this: SpecWorld) { const s = states.get(this); if (s) await s.fixture.close(); states.delete(this); });

Given('当前打开的是旧任务的一条消息详情且存在更新任务', async function (this: SpecWorld) { await setup(this); });
When('生成当前详情的复制和导出内容', async function (this: SpecWorld) { await transfer(this); });
Then('应包含消息全文、关联报告、来源和折叠执行记录', function (this: SpecWorld) {
  const text = state(this).fixture.copies[0]!.text;
  for (const value of [OLD_BODY, REPORT_BODY, OLD_SOURCE, A_EVENT, TRACE_DETAIL]) assert(text.includes(value), value);
});
Then('不应包含其他任务或未关联报告的正文', function (this: SpecWorld) {
  const text = state(this).fixture.copies[0]!.text;
  for (const value of [FOREIGN_BODY, UNLINKED_BODY, '新消息独有正文。']) assert(!text.includes(value), value);
});

Given('当前预览一个{string}产物', async function (this: SpecWorld, kind: string) {
  const view = messageView(); view.target = { taskId: 'old-task', artifactId: kind === 'Markdown' ? 'report' : 'html' };
  await setup(this, view); state(this).expected = kind === 'Markdown' ? REPORT_BODY : HTML_BODY;
  state(this).extension = kind === 'Markdown' ? '.md' : '.html';
});
When('复制该产物并导出文件', async function (this: SpecWorld) { await transfer(this); });
Then('复制文本和导出字节应与原产物内容一致且保留文件类型', async function (this: SpecWorld) {
  const { fixture: f, expected, extension } = state(this); assert.equal(f.copies[0]!.text, expected);
  assert.deepEqual(Buffer.from(await f.downloads[0]!.blob.arrayBuffer()), Buffer.from(expected!, 'utf8'));
  assert(f.downloads[0]!.name.endsWith(extension!));
  assert.deepEqual(f.requests, []);
});
Then('产物预览不应重复显示相同文件的下载入口', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.container.querySelectorAll('[aria-label="导出详情"]').length, 1);
  assert.equal(f.container.querySelectorAll('[aria-label^="下载 "]').length, 0);
});

Given('任务详情已加载且连接中断', async function (this: SpecWorld) {
  const snapshot = detailSnapshot(); snapshot.activeTaskId = 'old-task';
  await setup(this, { snapshot, connected: false }); state(this).before = JSON.stringify(snapshot);
});
When('复制任务详情并导出Markdown', async function (this: SpecWorld) { await transfer(this); });
Then('应包含该任务的状态、额度、共享记录、来源和调度记录', function (this: SpecWorld) {
  const f = state(this).fixture, text = f.copies[0]!.text;
  for (const value of ['旧任务方案', '已完成', '旧任务已核对官方资料。', OLD_SOURCE, TRACE_DETAIL]) assert(text.includes(value));
  assert.match(text, /3\s*\/\s*300/); assert.match(text, /1\s*\/\s*30/); assert(f.downloads[0]!.name.endsWith('.md'));
});
Then('不应发送新的业务请求或改变执行预算', function (this: SpecWorld) {
  const s = state(this); assert.deepEqual(s.fixture.requests, []); assert.equal(JSON.stringify(s.view.snapshot), s.before);
});

Given('当前查看成员A的{string}且成员B也有记录和产物', async function (this: SpecWorld, tab: string) {
  const snapshot = detailSnapshot(); const f = await setup(this, { snapshot, agent: snapshot.agents.find(agent => agent.id === 'A')! });
  state(this).tab = tab; if (tab === '产物') await f.tab(tab);
});
When('生成成员详情的复制和导出内容', async function (this: SpecWorld) { await transfer(this); });
Then('只应包含成员A在该页签内的完整资料', function (this: SpecWorld) {
  const s = state(this), text = s.fixture.copies[0]!.text;
  assert(text.includes('A-model')); assert(!text.includes(B_EVENT)); assert(!text.includes(UNLINKED_BODY)); assert(!text.includes(FOREIGN_BODY));
  if (s.tab === '产物') { assert(text.includes(REPORT_BODY)); assert(text.includes(HTML_BODY)); assert(!text.includes(A_EVENT)); }
  else { assert(text.includes(A_EVENT)); assert(text.includes('A的执行原因。')); assert(!text.includes(REPORT_BODY)); }
});

Given('详情处于{string}', async function (this: SpecWorld, mode: string) {
  const view = messageView();
  if (mode === '没有快照') view.snapshot = null;
  else if (mode === '任务已不存在') view.target = { taskId: 'gone-task' };
  else if (mode === '消息已不存在') view.target = { taskId: 'old-task', messageId: 'gone-message' };
  else view.target = { taskId: 'old-task', artifactId: 'gone-artifact' };
  await setup(this, view);
});
When('检查复制和导出入口', function (this: SpecWorld) {
  const f = state(this).fixture; assert(f.button('复制详情').disabled); assert(f.button('导出详情').disabled);
});
Then('两个入口应禁用且不能回退到当前或其他任务', async function (this: SpecWorld) {
  const s = state(this), f = s.fixture; await f.click('复制详情'); await f.click('导出详情');
  assert.equal(buildDetailDocument(s.view.snapshot, { target: s.view.target }), null);
  assert.deepEqual(f.copies, []); assert.deepEqual(f.downloads, []); assert.deepEqual(f.requests, []);
});

Given('当前详情可复制但剪贴板写入仍在等待', async function (this: SpecWorld) { await setup(this, messageView(), 'pending'); });
When('连续点击复制详情', async function (this: SpecWorld) { const f = state(this).fixture; await f.click('复制详情'); await f.click('复制详情'); });
Then('只能发起一次写入且尚不能提示已复制', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.copies.length, 1); assert(!f.feedback.includes('已复制'));
  assert(f.button('复制详情').disabled); assert(!f.button('导出详情').disabled);
});
When('剪贴板确认写入完成', async function (this: SpecWorld) { await state(this).fixture.settleCopy(); });
Then('应显示可访问的已复制提示', function (this: SpecWorld) {
  const f = state(this).fixture; assert.match(f.feedback, /已复制/); assert(f.container.querySelector('[role="status"]'));
  assert(!f.button('复制详情').disabled);
});

Given('当前详情可用但剪贴板{string}', async function (this: SpecWorld, mode: string) {
  await setup(this, messageView(), mode === 'API不可用' ? 'unavailable' : 'rejected');
});
When('点击复制详情', async function (this: SpecWorld) { await state(this).fixture.click('复制详情'); });
Then('应显示简短失败提示而不声称已复制', function (this: SpecWorld) {
  const f = state(this).fixture; assert.match(f.feedback, /复制失败/); assert(!f.feedback.includes('已复制')); assert(f.container.querySelector('[role="alert"]'));
});
Then('仍可导出相同详情文件', async function (this: SpecWorld) {
  const f = state(this).fixture; assert(!f.button('导出详情').disabled); await f.click('导出详情');
  assert((await f.downloadText()).includes(OLD_BODY)); assert.deepEqual(f.requests, []);
});

Given('详情即将发生{string}且复制请求已发出但尚未完成', async function (this: SpecWorld, mode: string) {
  const view = messageView();
  if (mode === '页签切换') { view.agent = view.snapshot!.agents.find(agent => agent.id === 'A')!; delete view.target; }
  const f = await setup(this, view, 'pending'); await f.click('复制详情'); assert.equal(f.copies.length, 1);
});
When('详情发生{string}后旧请求返回', async function (this: SpecWorld, mode: string) {
  const s = state(this), f = s.fixture;
  if (mode === '消息切换') {
    s.view = { snapshot: s.view.snapshot, target: { taskId: 'new-task', messageId: 'new-message' } }; await f.update(s.view);
  } else if (mode === '页签切换') await f.tab('产物');
  else if (mode === '内容更新') {
    const snapshot = structuredClone(s.view.snapshot!); snapshot.messages[0]!.detailText += '\n新版本正文。';
    s.view = { ...s.view, snapshot }; await f.update(s.view);
  } else await f.click('关闭详情');
  if (mode !== '关闭详情') assert(!f.button('复制详情').disabled, 'A changed view must not stay blocked by the old copy');
  await f.settleCopy(mode !== '页签切换');
});
Then('当前视图不应显示旧请求的成功或失败提示', function (this: SpecWorld) {
  const f = state(this).fixture; assert(!f.feedback.includes('已复制')); assert(!f.feedback.includes('复制失败')); assert.deepEqual(f.requests, []);
});

Given('当前详情的标题含文件名不支持的字符', async function (this: SpecWorld) {
  const view = messageView(); view.snapshot!.tasks[0]!.goal = '../路径\\方案:<>?*\u0000\n';
  await setup(this, view); state(this).expected = buildDetailDocument(view.snapshot, { target: view.target })!.content;
});
When('导出当前详情', async function (this: SpecWorld) { await state(this).fixture.click('导出详情'); });
Then('应下载UTF8文件且名称不含路径或控制字符', async function (this: SpecWorld) {
  const { fixture: f, expected } = state(this); assert.equal(f.downloads.length, 1);
  const download = f.downloads[0]!; assert(!/[\x00-\x1f\x7f<>:"/\\|?*]/.test(download.name)); assert(download.name.endsWith('.md'));
  assert.deepEqual(Buffer.from(await download.blob.arrayBuffer()), Buffer.from(expected!, 'utf8'));
});
Then('应移除临时下载节点并回收对象URL', async function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.window.document.querySelectorAll('a[download]').length, 0);
  await f.waitForRevoke(); assert(f.revoked.includes(f.downloads[0]!.url));
});

Given('当前详情可用但浏览器创建下载失败', async function (this: SpecWorld) { const f = await setup(this); f.failDownload = true; });
When('点击导出详情', async function (this: SpecWorld) { await state(this).fixture.click('导出详情'); });
Then('应提示导出失败且不发送业务请求', function (this: SpecWorld) {
  const f = state(this).fixture; assert.match(f.feedback, /导出失败/); assert(!f.feedback.includes('已开始导出'));
  assert.deepEqual(f.requests, []); assert.deepEqual(f.downloads, []);
});
When('浏览器恢复后再次点击导出详情', async function (this: SpecWorld) { const f = state(this).fixture; f.failDownload = false; await f.click('导出详情'); });
Then('应发起当前详情的文件下载', async function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.downloads.length, 1); assert((await f.downloadText()).includes(OLD_BODY)); assert.match(f.feedback, /已开始导出/);
});
