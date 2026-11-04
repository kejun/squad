import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { PanelFixture } from '../panel-fixture.js';
import { PANEL_LAYOUT_STORAGE_KEY, type PanelSide } from '../../web/src/panel-layout.js';
import type { SpecWorld } from './steps.js';

interface PanelState {
  fixture: PanelFixture; side?: PanelSide; baseline?: { left: number; right: number };
  key?: string; saved?: string | null; requestedWidth?: number; previewWidth?: number;
  dragStartWidth?: number; dragHandle?: HTMLElement;
}
const states = new WeakMap<SpecWorld, PanelState>();
const sideOf = (name: string): PanelSide => { assert(['左侧', '右侧'].includes(name)); return name === '左侧' ? 'left' : 'right'; };
// Concrete visual samples belong to the fixture, not the behavioural specification.
function layoutWidth(name: string) {
  const widths: Record<string, number> = { 宽屏: 1440, 紧凑桌面: 1100, 标准桌面: 1280, 超宽屏: 1920, 详情覆盖: 800, 移动: 390 };
  assert(Object.hasOwn(widths, name)); return widths[name]!;
}
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
  const img = f.query('.chat-header .topbar-brand img');
  assert.equal(img.getAttribute('src'), '/logo.svg'); assert.equal(img.getAttribute('alt'), 'Squad');
  for (const element of [img, brand]) {
    const style = f.window.getComputedStyle(element as never);
    assert.notEqual(style.display, 'none'); assert.notEqual(style.visibility, 'hidden');
  }
}
After(async function (this: SpecWorld) { const value = states.get(this); if (value) await value.fixture.close(); states.delete(this); });

Given('工作区处于{string}布局且左右面板均展开', async function (this: SpecWorld, layout: string) {
  const f = await setup(this, layoutWidth(layout)); await f.openDetails();
  state(this).baseline = { left: f.widthOf('left'), right: f.widthOf('right') };
});
When('将{string}面板的分隔条向右拖动并松开', async function (this: SpecWorld, name: string) {
  const dx = 80;
  const s = state(this); s.side = sideOf(name); await s.fixture.drag(s.side, dx);
});
Then('{string}面板宽度应随拖动改变且另一个面板宽度不变', function (this: SpecWorld, name: string) {
  const width = name === '左侧' ? 332 : 300;
  const s = state(this), side = sideOf(name), other = side === 'left' ? 'right' : 'left';
  assert.equal(s.fixture.widthOf(side), Number(width));
  assert.equal(s.fixture.widthOf(other), s.baseline![other]);
  assert.equal(s.fixture.query('.workspace').style.getPropertyValue(side === 'left' ? '--sidebar-width' : '--details-width'), `${Number(width)}px`);
});
Then('布局操作不应发送业务请求', function (this: SpecWorld) { assert.deepEqual(state(this).fixture.requests, []); });

When('将{string}面板宽度请求调整为{string}', async function (this: SpecWorld, name: string, range: string) {
  assert(['低于下限', '超过上限'].includes(range));
  const width = range === '低于下限' ? 20 : 5000; state(this).requestedWidth = width;
  const s = state(this); s.side = sideOf(name); await s.fixture.requestWidth(s.side, width);
});
Then('面板应停在对应边界且聊天区仍可操作', function (this: SpecWorld) {
  const s = state(this), f = s.fixture, handle = f.separator(s.side!);
  const width = f.widthOf(s.side!);
  assert.equal(width, Number(handle.getAttribute(s.requestedWidth === 20 ? 'aria-valuemin' : 'aria-valuemax')));
  assert(width >= Number(handle.getAttribute('aria-valuemin')));
  assert(width <= Number(handle.getAttribute('aria-valuemax')));
  const left = Number.parseFloat(f.query('.workspace').style.getPropertyValue('--sidebar-width'));
  assert(f.availableWidth - left - f.widthOf('right') >= 360);
});

Given('左侧导航已自定义宽度且右侧详情展开', async function (this: SpecWorld) {
  const f = await setup(this, 1440); await f.openDetails(); await f.requestWidth('left', 320); await f.enterDraft('未发送的草稿');
});
When('收起左侧导航', async function (this: SpecWorld) { await state(this).fixture.click('收起导航'); });
Then('左侧应释放空间且仍有展开入口', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.query('.workspace').style.getPropertyValue('--sidebar-width'), '0px');
  assert.equal(f.label('展开导航').getAttribute('aria-expanded'), 'false');
  assert(!f.container.querySelector('[aria-label="调整导航宽度"]'));
});
When('重新展开左侧导航', async function (this: SpecWorld) { await state(this).fixture.click('展开导航'); });
Then('左侧应恢复自定义宽度且当前群聊与草稿不变', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.widthOf('left'), 320); assert.equal(f.roomId, 'first'); assert.equal(f.draft, '未发送的草稿');
  assert.equal(f.label('收起导航').getAttribute('aria-expanded'), 'true');
});

Given('用户已保存两侧自定义宽度和导航收起偏好', async function (this: SpecWorld) {
  const f = await setup(this, 1440, JSON.stringify({ leftWidth: 320, rightWidth: 480, leftCollapsed: true })); await f.openDetails();
});
When('重新载入布局并关闭再打开右侧详情', async function (this: SpecWorld) {
  const s = state(this), raw = s.fixture.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  await s.fixture.close(); const f = await setup(this, 1440, raw!);
  await f.openDetails(); await f.click('收起详情'); assert(!f.container.querySelector('#workspace-details')); await f.openDetails();
});
Then('左侧仍收起且右侧恢复自定义宽度', function (this: SpecWorld) {
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

Given('工作区处于{string}布局且{string}面板展开', async function (this: SpecWorld, layout: string, name: string) {
  const f = await setup(this, layoutWidth(layout)); state(this).side = sideOf(name);
  if (name === '右侧') await f.openDetails(); else await f.openNavigation();
});
Then('面板应适应可用空间且聊天入口仍可访问', function (this: SpecWorld) {
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
Then('应结束拖拽并恢复正常指针与文字选择', function (this: SpecWorld) {
  const f = state(this).fixture, root = f.window.document.documentElement;
  assert.equal(root.dataset.panelResizing, undefined); assert.equal(root.style.cursor, ''); assert.equal(root.style.userSelect, '');
  assert(!f.container.querySelector('.panel-separator.is-dragging'));
  if (state(this).dragHandle) assert(!state(this).dragHandle!.hasPointerCapture(1));
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

Given('工作区可用空间因视窗内其他占用刚好进入{string}范围', async function (this: SpecWorld, mode: string) {
  assert(['详情覆盖', '移动抽屉'].includes(mode));
  const [viewport, available] = mode === '详情覆盖' ? [1000, 985] : [730, 715];
  await setup(this, viewport!, undefined, false, available!);
});
When('展开详情并检查导航与详情展示模式', async function (this: SpecWorld) { await state(this).fixture.openDetails(); });
Then('布局应按工作区可用空间采用{string}且操作入口可用', function (this: SpecWorld, mode: string) {
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

Given('工作区处于{string}布局且左侧导航{string}且详情展开', async function (this: SpecWorld, layout: string, navigation: string) {
  const width = layoutWidth(layout);
  assert(['展开', '收起'].includes(navigation));
  const f = await setup(this, width); await f.openDetails();
  if (width > 720 && navigation === '收起') await f.click('收起导航');
  if (width <= 720 && navigation === '展开') await f.openNavigation();
});
function assertChatUsable(f: PanelFixture) {
  const left = Number.parseFloat(f.query('.workspace').style.getPropertyValue('--sidebar-width'));
  assert(f.availableWidth - left - f.widthOf('right') >= 360);
  assert(f.label('群聊消息输入框'));
}
Then('详情应利用导航状态允许的最大空间且聊天区仍可操作', function (this: SpecWorld) {
  const f = state(this).fixture, width = f.availableWidth - 360;
  assert.equal(f.widthOf('right'), width);
  assert.equal(Number(f.separator('right').getAttribute('aria-valuemax')), width);
  assert.equal(f.query('.workspace').style.getPropertyValue('--details-width'), `${width}px`);
  assertChatUsable(f);
});
Then('聊天区仍可操作', function (this: SpecWorld) { assertChatUsable(state(this).fixture); });
When('将详情加宽到当前可用上限', async function (this: SpecWorld) {
  const f = state(this).fixture; await f.requestWidth('right', f.availableWidth - 360);
});
Then('详情应恢复保存的宽度', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.preferences()?.rightWidth, 1080); assert.equal(f.widthOf('right'), 1080);
  assert.equal(Number(f.separator('right').getAttribute('aria-valuemax')), 1080);
});
Then('详情应临时缩窄以保留聊天空间且保存偏好不变', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.widthOf('right'), 828); assert.equal(f.preferences()?.rightWidth, 1080);
  assertChatUsable(f);
});
Then('详情应适应当前可用空间且保存偏好不变', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.widthOf('right'), 358); assert.equal(f.preferences()?.rightWidth, 1080);
  assert.equal(Number(f.separator('right').getAttribute('aria-valuemax')), 358);
});
When('重新加载已保存的布局', async function (this: SpecWorld) {
  const f = state(this).fixture, raw = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY), width = f.availableWidth;
  await f.close(); const reloaded = await setup(this, width, raw!); await reloaded.openDetails();
});
When('临时切换到{string}布局', async function (this: SpecWorld, layout: string) {
  await state(this).fixture.viewport(layoutWidth(layout));
});
When('关闭详情后查看工作区顶栏', async function (this: SpecWorld) { await state(this).fixture.click('收起详情'); });
Then('顶栏品牌标识应{string}', function (this: SpecWorld, expected: string) {
  assert(['隐藏', '可识别'].includes(expected));
  assertTopbarBrand(state(this).fixture, expected === '可识别');
});
Then('群聊标题和导航详情入口仍可用', async function (this: SpecWorld) {
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

When('开始拖拽右栏到{string}', async function (this: SpecWorld, boundary: string) {
  const widths: Record<string, number> = { 聊天区下限之前: 827, 恰好触及聊天区下限: 828, 越过聊天区下限: 900 };
  assert(Object.hasOwn(widths, boundary)); const width = widths[boundary]!; state(this).previewWidth = width;
  const s = state(this), f = s.fixture;
  s.saved = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  s.dragStartWidth = f.widthOf('right'); s.dragHandle = f.separator('right');
  await f.startDrag('right'); await f.moveDrag(s.dragStartWidth - width);
});
Then('预览导航应{string}且详情应跟随拖动', function (this: SpecWorld, navigation: string) {
  const width = state(this).previewWidth!;
  const f = state(this).fixture, collapsed = navigation === '收起';
  assert(['展开', '收起'].includes(navigation));
  assert.equal(f.query('.navigation-toggle').getAttribute('aria-expanded'), String(!collapsed));
  assert.equal(f.query('#workspace-navigation').hasAttribute('hidden'), collapsed);
  assert.equal(f.query('.workspace').style.getPropertyValue('--sidebar-width'), collapsed ? '0px' : '252px');
  assert.equal(f.widthOf('right'), width); assertTopbarBrand(f, collapsed);
});
Then('松手前仍可继续拖拽且尚未保存偏好', function (this: SpecWorld) {
  const s = state(this);
  assert(s.dragHandle!.hasPointerCapture(1));
  assert.equal(s.fixture.window.document.documentElement.dataset.panelResizing, 'right');
  assert.equal(s.fixture.storage.getItem(PANEL_LAYOUT_STORAGE_KEY), s.saved);
});
When('反向缩窄右栏', async function (this: SpecWorld) {
  const width = 700;
  const s = state(this); await s.fixture.moveDrag(s.dragStartWidth! - width);
});
When('再次加宽右栏并松手', async function (this: SpecWorld) {
  const width = 1000;
  const s = state(this), dx = s.dragStartWidth! - width;
  await s.fixture.moveDrag(dx); await s.fixture.endDrag(dx);
});
Then('导航收起与详情宽度应保存且重载后保持', async function (this: SpecWorld) {
  const width = 1000;
  const f = state(this).fixture, raw = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
  assert.equal(f.preferences()?.leftCollapsed, true); assert.equal(f.preferences()?.rightWidth, width);
  assert.equal(f.widthOf('right'), width); assert.deepEqual(f.requests, []);
  await f.close(); const restored = await setup(this, 1440, raw!); await restored.openDetails();
  assert.equal(restored.preferences()?.leftCollapsed, true); assert.equal(restored.widthOf('right'), width);
});
Then('导航应恢复原宽度且详情保存偏好不变', function (this: SpecWorld) {
  const width = 1000;
  const f = state(this).fixture;
  assert.equal(f.widthOf('left'), 252); assert.equal(f.preferences()?.rightWidth, width);
  assert.equal(f.widthOf('right'), 828); assertTopbarBrand(f, false);
});
When('自动收起预览发生{string}', async function (this: SpecWorld, mode: string) {
  const f = state(this).fixture;
  if (mode === '窗口变窄') await f.viewport(1100);
  else if (mode === '关闭详情') await f.click('收起详情');
  else { assert(['按下Escape', '取消指针', '窗口失焦'].includes(mode)); await f.cancel(mode); }
});
Then('自动收起预览应撤销且保存偏好不变', function (this: SpecWorld) {
  const s = state(this), f = s.fixture;
  assert.equal(f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY), s.saved);
  assert.equal(f.query('.workspace').style.getPropertyValue('--sidebar-width'), '252px');
  assert.equal(f.query('.navigation-toggle').getAttribute('aria-expanded'), 'true');
  if (f.container.querySelector('#workspace-details')) assert.equal(f.widthOf('right'), 352);
  assertTopbarBrand(f, false); assert.deepEqual(f.requests, []);
});
Then('桌面导航展开偏好应保持不变', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.preferences()?.leftCollapsed, false); assert.deepEqual(f.requests, []);
});
When('迟到的右栏拖拽松手事件到达', async function (this: SpecWorld) {
  const s = state(this); await s.fixture.endDrag(s.dragStartWidth! - 900);
});

Given('工作区已打开详情', async function (this: SpecWorld) {
  const f = await setup(this); await f.openDetails();
});
Then('导航应保持收起且详情应跟随反向拖动', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.query('.navigation-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(f.widthOf('right'), 700); assertTopbarBrand(f, true);
});
When('查看连接状态并从导航查看方案师', async function (this: SpecWorld) {
  const f = state(this).fixture;
  assert(f.query('.chat-header .connection-label').textContent?.includes('已连接'));
  await f.click('查看方案师的执行过程');
});
Then('页面不应重复展示成员入口且成员详情仍可使用', function (this: SpecWorld) {
  const f = state(this).fixture;
  assert.equal(f.container.querySelector('.team-bar, .team-avatar-stack, .stack-avatar-button'), null);
  assert.equal(f.query('.agent-profile h2').textContent, '方案师');
  for (const label of ['复制详情', '导出详情', '关闭详情']) assert(f.label(label));
});
