import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_PREFERENCES, readPanelPreferences, resolvePanelLayout,
  resizePanelByKey, resizePanelFromDrag, type PanelSide,
} from '../web/src/panel-layout.js';

describe('pure panel drag transitions', () => {
  it.each([
    { requested: 827, collapsed: false },
    { requested: 828, collapsed: true },
    { requested: 900, collapsed: true },
  ])('[BT_P15] sets navigation collapse to $collapsed at right width $requested', ({ requested, collapsed }) => {
    const saved = Object.freeze({ ...DEFAULT_PANEL_PREFERENCES });

    const preview = resizePanelFromDrag(saved, 'right', requested, 1440, true);

    expect(preview.leftCollapsed).toBe(collapsed);
    expect(resolvePanelLayout(preview, 1440, true).right).toBe(requested);
    expect(saved).toEqual(DEFAULT_PANEL_PREFERENCES);
  });

  it('[BT_P16] restores automatic collapse and the original navigation width after reversing a drag', () => {
    const saved = Object.freeze({ ...DEFAULT_PANEL_PREFERENCES, leftWidth: 320 });
    const expanded = resizePanelFromDrag(saved, 'right', 900, 1440, true);

    const reversed = resizePanelFromDrag(expanded, 'right', 700, 1440, true);
    const restored = readPanelPreferences(JSON.stringify(reversed));

    expect(restored).toEqual({ leftWidth: 320, rightWidth: 700, leftCollapsed: true });
    expect(resolvePanelLayout({ ...restored, leftCollapsed: false }, 1440, true).left).toBe(320);
    expect(saved).toEqual({ leftWidth: 320, rightWidth: 352, leftCollapsed: false });
  });

  it.each([
    { name: 'tablet', side: 'right', requested: 5000, viewport: 800, open: true, rightWidth: 352 },
    { name: 'mobile', side: 'right', requested: 5000, viewport: 390, open: true, rightWidth: 352 },
    { name: 'left drag', side: 'left', requested: 5000, viewport: 1440, open: true, rightWidth: 352 },
    { name: 'closed details', side: 'right', requested: 5000, viewport: 1440, open: false, rightWidth: 352 },
    { name: 'invalid width', side: 'right', requested: Number.NaN, viewport: 1440, open: true, rightWidth: 352 },
    { name: 'unchanged width', side: 'right', requested: 828, viewport: 1440, open: true, rightWidth: 828 },
    { name: 'shrinking width', side: 'right', requested: 800, viewport: 1440, open: true, rightWidth: 828 },
  ])('[BT_P07] [BT_P18] preserves navigation visibility for $name', ({ side, requested, viewport, open, rightWidth }) => {
    const saved = Object.freeze({ ...DEFAULT_PANEL_PREFERENCES, rightWidth });

    const preview = resizePanelFromDrag(saved, side as PanelSide, requested, viewport, open);

    expect(preview.leftCollapsed).toBe(false);
    expect(saved.leftCollapsed).toBe(false);
  });

  it('[BT_P07] expands to the keyboard boundary without triggering drag collapse', () => {
    const saved = { ...DEFAULT_PANEL_PREFERENCES };

    const resized = resizePanelByKey(saved, 'right', 'End', 1440, true);

    expect(resized).toEqual({ leftWidth: 252, rightWidth: 828, leftCollapsed: false });
  });
});
