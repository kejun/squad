import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PanelFixture } from './panel-fixture.js';
import { PANEL_LAYOUT_STORAGE_KEY } from '../web/src/panel-layout.js';
import { assertTypographyFloor } from './typography-audit.js';

const open: PanelFixture[] = [];
async function fixture() { const value = new PanelFixture(); open.push(value); return value.mount(); }
afterEach(async () => { for (const value of open.splice(0).reverse()) await value.close(); });

describe('workspace panel interactions', () => {
  it('[BT_P01] [BT_P08] previews a captured drag without saving it before pointer-up', async () => {
    const f = await fixture(), handle = f.separator('left');
    const before = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    await f.startDrag('left'); await f.moveDrag(80);
    expect(f.widthOf('left')).toBe(332);
    expect(handle.hasPointerCapture(1)).toBe(true);
    expect(f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY)).toBe(before);
    await f.endDrag(80);
    expect(f.preferences()?.leftWidth).toBe(332);
    expect(handle.hasPointerCapture(1)).toBe(false);
    expect(f.requests).toEqual([]);
  });

  it('[BT_P08] cancels on window blur and restores previous global cursor and selection styles', async () => {
    const f = await fixture(), root = f.window.document.documentElement, handle = f.separator('left');
    root.style.cursor = 'wait'; root.style.userSelect = 'text';
    const before = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    await f.startDrag('left'); await f.moveDrag(80);
    await act(async () => { f.window.dispatchEvent(new f.window.Event('blur')); });
    expect(f.widthOf('left')).toBe(252);
    expect(root.style.cursor).toBe('wait'); expect(root.style.userSelect).toBe('text');
    expect(root.dataset.panelResizing).toBeUndefined();
    expect(handle.hasPointerCapture(1)).toBe(false);
    expect(f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY)).toBe(before);
  });

  it('[BT_P04] [BT_P08] cancels an in-progress drag when the viewport changes without overwriting the saved width', async () => {
    const f = await fixture(), handle = f.separator('left');
    const before = f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    await f.startDrag('left'); await f.moveDrag(100); await f.viewport(800);
    expect(f.widthOf('left')).toBe(252);
    expect(handle.hasPointerCapture(1)).toBe(false);
    expect(f.window.document.documentElement.dataset.panelResizing).toBeUndefined();
    await f.endDrag(100);
    expect(f.storage.getItem(PANEL_LAYOUT_STORAGE_KEY)).toBe(before);
  });

  it('[BT_P07] [BT_P08] lets a keyboard adjustment replace an unfinished drag rather than being overwritten by its later pointer-up', async () => {
    const f = await fixture();
    await f.startDrag('left'); await f.moveDrag(80);
    await f.key('left', 'ArrowRight', true);
    expect(f.widthOf('left')).toBe(302);
    await f.endDrag(80);
    expect(f.widthOf('left')).toBe(302);
    expect(f.preferences()?.leftWidth).toBe(302);
    expect(f.window.document.documentElement.dataset.panelResizing).toBeUndefined();
  });

  it('[BT_P03] [BT_P07] returns focus to a usable header control when Enter removes the focused separator', async () => {
    const f = await fixture();
    await f.key('left', 'Enter');
    expect(f.query('.workspace').style.getPropertyValue('--sidebar-width')).toBe('0px');
    expect(f.window.document.activeElement).toBe(f.label('展开导航'));
    await f.openDetails(); await f.key('right', 'Enter');
    expect(f.container.querySelector('#workspace-details')).toBeNull();
    expect(f.window.document.activeElement).toBe(f.label('查看任务详情'));
    expect(f.requests).toEqual([]);
  });

  it('[BT_P10] audits the text floor across every stylesheet, including native smaller-text defaults', () => {
    const audited = assertTypographyFloor();
    expect(audited.files).toBeGreaterThan(0); expect(audited.declarations).toBeGreaterThan(0);
  });
});
