import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { PanelFixture } from '../panel-fixture.js';
import { assertTypographyFloor } from '../typography-audit.js';
import { PANEL_LAYOUT_STORAGE_KEY, type PanelSide } from '../../web/src/panel-layout.js';
import type { SpecWorld } from './steps.js';

interface PanelState {
  fixture: PanelFixture; side?: PanelSide; baseline?: { left: number; right: number };
  key?: string; saved?: string | null; typography?: ReturnType<typeof assertTypographyFloor>;
}
const states = new WeakMap<SpecWorld, PanelState>();
const sideOf = (name: string): PanelSide => name === '左侧' ? 'left' : 'right';
function state(world: SpecWorld) { const value = states.get(world); assert(value); return value; }
async function setup(world: SpecWorld, width = 1440, raw?: string, denied = false, availableWidth = width) {
  const fixture = new PanelFixture(width, raw, denied, availableWidth);
  states.set(world, { fixture });
  await fixture.mount(); return fixture;
}
function assertTopbarBrand(f: PanelFixture, visible: boolean) {
  const brand = f.container.querySelector('.chat-header .topbar-brand');
  if (!visible) { assert(!brand, '导航展开时顶栏不应渲染品牌图形'); return; }
  assert(brand);
  assert(f.query('.chat-header').firstElementChild === brand, '品牌图形必须位于顶栏首位');
  const img = f.query('.chat-header .topbar-brand img');
  assert.equal(img.getAttribute('src'), '/logo.svg'); assert.equal(img.getAttribute('alt'), 'Squad');
  for (const element of [img, brand]) {
    const style = f.window.getComputedStyle(element as never);
    assert.notEqual(style.display, 'none'); assert.notEqual(style.visibility, 'hidden');
  }
}
After(async function (this: SpecWorld) { const value = states.get(this); if (value) await value.fixture.close(); states.delete(this); });

Given('宽度为{int}的工作区中左右面板均展开', async function (this: SpecWorld, width: number) {
  const f = await setup(this, width); await f.openDetails();
  state(this).baseline = { left: f.widthOf('left'), right: f.widthOf('right') };
});
When('将{string}面板的分隔条向右拖动{int}像素并松开', async function (this: SpecWorld, name: string, dx: number) {
  const s = state(this); s.side = sideOf(name); await s.fixture.drag(s.side, dx);
});
Then('{string}面板应变为{string}像素且另一个面板宽度不变', function (this: SpecWorld, name: string, width: string) {
  const s = state(this), side = sideOf(name), other = side === 'left' ? 'right' : 'left';
  assert.equal(s.fixture.widthOf(side), Number(width));
  assert.equal(s.fixture.widthOf(other), s.baseline![other]);
  assert.equal(s.fixture.query('.workspace').style.getPropertyValue(side === 'left' ? '--sidebar-width' : '--details-width'), `${Number(width)}px`);
});
Then('拖拽不应发送业务请求', function (this: SpecWorld) { assert.deepEqual(state(this).fixture.requests, []); });

When('将{string}面板宽度请求调整为{int}像素', async function (this: SpecWorld, name: string, width: number) {
  const s = state(this); s.side = sideOf(name); await s.fixture.requestWidth(s.side, width);
});
Then('面板应保持在允许范围内且聊天区至少有360像素', function (this: SpecWorld) {
  const s = state(this), f = s.fixture, handle = f.separator(s.side!);
  const width = f.widthOf(s.side!);
  assert(width >= Number(handle.getAttribute('aria-valuemin')));
  assert(width <= Number(handle.getAttribute('aria-valuemax')));
  assert(f.viewportWidth - f.widthOf('left') - f.widthOf('right') >= 360);
});

Given('左侧导航已调整为320像素且右侧详情展开', async function (this: SpecWorld) {
  const f = await setup(this, 1440); await f.openDetails(); await f.requestWidth('left', 320); await f.enterDraft('未发送的草稿');
});
When('在标题栏收起左侧导航', async function (this: SpecWorld) { await state(this).fixture.click('收起导航'); });
Then('左侧不应占据布局列且标题栏保留展开入口', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.query('.workspace').style.getPropertyValue('--sidebar-width'), '0px');
  assert.equal(f.label('展开导航').getAttribute('aria-expanded'), 'false');
  assert(!f.container.querySelector('[aria-label="调整导航宽度"]'));
});
When('在标题栏重新展开左侧导航', async function (this: SpecWorld) { await state(this).fixture.click('展开导航'); });
Then('左侧应恢复320像素且当前群聊与草稿不变', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.widthOf('left'), 320); assert.equal(f.roomId, 'first'); assert.equal(f.draft, '未发送的草稿');
  assert.equal(f.label('收起导航').getAttribute('aria-expanded'), 'true');
});

Given('用户已保存左侧320像素右侧480像素且左侧收起的偏好', async function (this: SpecWorld) {
  const f = await setup(this, 1440, JSON.stringify({ leftWidth: 320, rightWidth: 480, leftCollapsed: true })); await f.openDetails();
});
When('重新载入布局并关闭再打开右侧详情', async function (this: SpecWorld) {
  const s = state(this), raw = s.fixture.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  await s.fixture.close(); const f = await setup(this, 1440, raw!);
  await f.openDetails(); await f.click('收起详情'); assert(!f.container.querySelector('#workspace-details')); await f.openDetails();
});
Then('左侧仍收起且右侧恢复480像素', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.query('.workspace').style.getPropertyValue('--sidebar-width'), '0px'); assert.equal(f.widthOf('right'), 480);
});
Then('临时缩小窗口再恢复不应覆盖保存的宽度', async function (this: SpecWorld) {
  const f = state(this).fixture, before = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  await f.viewport(390); assert(f.widthOf('right') <= 358);
  assert.equal(f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY), before);
  await f.viewport(1440); assert.equal(f.widthOf('right'), 480); assert.equal(f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY), before);
});

Given('布局偏好存储为{string}', async function (this: SpecWorld, mode: string) {
  const raw = mode === '损坏内容' ? '{ broken' : mode === '越界数值' ? JSON.stringify({ leftWidth: -5000, rightWidth: 5000, leftCollapsed: 'bad' }) : undefined;
  await setup(this, 1440, raw, mode === '禁止读写');
});
When('打开工作区并调整面板', async function (this: SpecWorld) { const f = state(this).fixture; await f.openDetails(); await f.requestWidth('left', 300); });
Then('应使用有效默认值或当前内存偏好且不抛出错误', function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.widthOf('left'), 300); assert(Number.isFinite(f.widthOf('right'))); assert.deepEqual(f.requests, []);
});

Given('工作区宽度为{int}像素且{string}面板展开', async function (this: SpecWorld, width: number, name: string) {
  const f = await setup(this, width); state(this).side = sideOf(name);
  if (name === '右侧') await f.openDetails(); else await f.openNavigation();
});
Then('面板尺寸和展示模式应适应该窗口且聊天区可用', function (this: SpecWorld) {
  const s = state(this), f = s.fixture;
  assert(f.widthOf(s.side!) <= f.viewportWidth - (f.viewportWidth <= 990 ? 32 : 360));
  if (f.viewportWidth <= 720 && s.side === 'left') {
    assert.equal(f.query('.navigation-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(f.window.getComputedStyle(f.query('#workspace-navigation') as never).position, 'fixed');
  } else if (f.viewportWidth <= 990 && s.side === 'right') {
    assert.equal(f.window.getComputedStyle(f.query('#workspace-details') as never).position, 'fixed');
  }
  assert(f.container.querySelector('.chat-main')); assert(f.label('群聊消息输入框'));
});

When('聚焦{string}分隔条并按下{string}', async function (this: SpecWorld, name: string, key: string) {
  const s = state(this); s.side = sideOf(name); s.key = key; await s.fixture.key(s.side, key);
});
Then('面板应按键盘方向或边界调整并更新可访问尺寸', function (this: SpecWorld) {
  const s = state(this), f = s.fixture, side = s.side!, handle = f.separator(side), before = s.baseline![side];
  const expected = s.key === 'Home' ? Number(handle.getAttribute('aria-valuemin')) : s.key === 'End' ? Number(handle.getAttribute('aria-valuemax'))
    : before + (s.key === 'ArrowLeft' ? (side === 'left' ? -10 : 10) : side === 'left' ? 10 : -10);
  assert.equal(f.widthOf(side), expected);
  assert.equal(handle.getAttribute('aria-orientation'), 'vertical'); assert.equal(handle.getAttribute('aria-valuetext'), `${expected}px`);
  assert.equal(handle.getAttribute('aria-controls'), side === 'left' ? 'workspace-navigation' : 'workspace-details');
});

Given('用户正在拖拽一个面板分隔条', async function (this: SpecWorld) {
  const f = await setup(this, 1440); state(this).saved = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  await f.startDrag('left'); await f.moveDrag(80); assert.equal(f.widthOf('left'), 332);
});
When('拖拽发生{string}', async function (this: SpecWorld, mode: string) { await state(this).fixture.cancel(mode); });
Then('应停止调整并清理捕获和全局拖拽样式', function (this: SpecWorld) {
  const f = state(this).fixture, root = f.window.document.documentElement;
  assert.equal(root.dataset.panelResizing, undefined); assert.equal(root.style.cursor, ''); assert.equal(root.style.userSelect, '');
  assert(!f.container.querySelector('.panel-separator.is-dragging'));
});
Then('未提交的拖拽不应覆盖已保存偏好', function (this: SpecWorld) {
  const s = state(this); assert.equal(s.fixture.storage.getItem(PANEL_LAYOUT_STORAGE_KEY), s.saved);
});

Given('桌面左侧导航已收起', async function (this: SpecWorld) { const f = await setup(this, 1440); await f.click('收起导航'); });
When('在窄屏打开导航并选择一个群聊', async function (this: SpecWorld) {
  const f = state(this).fixture; await f.viewport(390); await f.openNavigation(); await f.chooseRoom('另一个群聊');
});
Then('移动导航应关闭且桌面收起偏好保持不变', async function (this: SpecWorld) {
  const f = state(this).fixture; assert.equal(f.roomId, 'second'); assert.equal(f.preferences()?.leftCollapsed, true);
  assert(!f.query('#workspace-navigation').classList.contains('is-open'));
  await f.viewport(1440); assert.equal(f.query('.workspace').style.getPropertyValue('--sidebar-width'), '0px');
  assert.equal(f.label('展开导航').getAttribute('aria-expanded'), 'false');
});

Given('页面包含导航、消息、输入框、状态、详情、代码和脚注文字', function (this: SpecWorld) { /* The stylesheet audit covers all regions and breakpoints, not a single DOM snapshot. */ });
When('检查默认样式及各响应式断点的字号规则', function (this: SpecWorld) {
  const result = assertTypographyFloor(); assert(result.files > 0); assert(result.declarations > 0);
});
Then('可见文字字号不得小于14像素且下标脚注不得被默认缩小', function () { assertTypographyFloor(); });
Then('小字号不应通过整体缩放重新出现', function () { assertTypographyFloor(); });

Given('浏览器视窗为{int}像素而工作区可用宽度为{int}像素', async function (this: SpecWorld, viewport: number, available: number) {
  await setup(this, viewport, undefined, false, available);
});
When('展开详情并检查导航与详情展示模式', async function (this: SpecWorld) { await state(this).fixture.openDetails(); });
Then('布局应按工作区可用宽度采用{string}而不混用视窗断点', function (this: SpecWorld, mode: string) {
  const f = state(this).fixture, win = f.window;
  const style = (selector: string) => win.getComputedStyle(f.query(selector) as never);
  // DOM checks verify the chosen mode and pane semantics; pixel grid geometry is verified in Chromium.
  assert.equal(style('#workspace-details').position, 'fixed');
  assert(f.query('.workspace').classList.contains('is-details-overlay'));
  if (mode === '详情覆盖') {
    assert(!f.query('.workspace').classList.contains('is-mobile-layout'));
    assert.equal(style('#workspace-navigation').position, 'relative');
    assert(f.availableWidth - f.widthOf('left') >= 360);
  } else {
    assert(f.query('.workspace').classList.contains('is-mobile-layout'));
    assert.equal(style('#workspace-navigation').position, 'fixed');
    assert.equal(style('#workspace-navigation').visibility, 'hidden');
    assert.equal(style('#workspace-navigation .room-button').visibility, 'hidden');
    assert.equal(f.query('.navigation-toggle').getAttribute('aria-expanded'), 'false');
    assert(!f.container.querySelector('#workspace-navigation .panel-separator'));
    assert(f.availableWidth >= 360);
  }
});

Given('宽度为{int}的工作区中左侧导航{string}且详情展开', async function (this: SpecWorld, width: number, navigation: string) {
  assert(['展开', '收起'].includes(navigation));
  const f = await setup(this, width); await f.openDetails();
  if (width > 720 && navigation === '收起') await f.click('收起导航');
  if (width <= 720 && navigation === '展开') await f.openNavigation();
});
Then('右侧详情宽度应为{int}像素且拖拽上限为{int}像素', function (this: SpecWorld, width: number, max: number) {
  const f = state(this).fixture;
  assert.equal(f.widthOf('right'), width);
  assert.equal(Number(f.separator('right').getAttribute('aria-valuemax')), max);
  assert.equal(f.query('.workspace').style.getPropertyValue('--details-width'), `${width}px`);
});
Then('聊天区应至少保留360像素', function (this: SpecWorld) {
  const f = state(this).fixture;
  const left = Number.parseFloat(f.query('.workspace').style.getPropertyValue('--sidebar-width'));
  assert(f.availableWidth - left - f.widthOf('right') >= 360);
});
When('重新加载已保存的布局', async function (this: SpecWorld) {
  const f = state(this).fixture, raw = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY), width = f.availableWidth;
  await f.close(); const reloaded = await setup(this, width, raw!); await reloaded.openDetails();
});
Then('右侧保存偏好仍为{int}像素', function (this: SpecWorld, width: number) {
  assert.equal(state(this).fixture.preferences()?.rightWidth, width);
});
When('临时将工作区宽度改为{int}像素', async function (this: SpecWorld, width: number) {
  await state(this).fixture.viewport(width);
});
When('关闭详情后查看工作区顶栏', async function (this: SpecWorld) { await state(this).fixture.click('收起详情'); });
Then('顶栏品牌图形应{string}', function (this: SpecWorld, expected: string) {
  assert(['隐藏', '显示在首位'].includes(expected));
  assertTopbarBrand(state(this).fixture, expected === '显示在首位');
});
Then('顶栏群聊标题和导航详情入口仍可用', async function (this: SpecWorld) {
  const f = state(this).fixture, navigation = f.query('.navigation-toggle');
  assert.equal(f.query('.chat-title h1').textContent, '当前群聊');
  const wasExpanded = navigation.getAttribute('aria-expanded');
  await f.click(navigation.getAttribute('aria-label')!);
  assert.notEqual(navigation.getAttribute('aria-expanded'), wasExpanded);
  assertTopbarBrand(f, wasExpanded === 'true');
  await f.click(navigation.getAttribute('aria-label')!);
  assertTopbarBrand(f, wasExpanded !== 'true');
  await f.openDetails(); assert(f.container.querySelector('#workspace-details'));
  await f.click('收起详情'); assert(!f.container.querySelector('#workspace-details'));
  assert.deepEqual(f.requests, []);
});
