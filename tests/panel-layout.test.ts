import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_PREFERENCES, readPanelPreferences, resolvePanelLayout,
  resizePanelByKey, resizePanelFromDrag,
} from '../web/src/panel-layout.js';

describe('pure panel drag transitions', () => {
  it('[BT_P15] collapses at the 360px chat boundary while preserving the requested right edge', () => {
    const saved = Object.freeze({ ...DEFAULT_PANEL_PREFERENCES });
    for (const [requested, collapsed] of [[827, false], [828, true], [900, true]] as const) {
      const preview = resizePanelFromDrag(saved, 'right', requested, 1440, true);
      expect(preview.leftCollapsed).toBe(collapsed);
      expect(resolvePanelLayout(preview, 1440, true).right).toBe(requested);
      expect(saved).toEqual(DEFAULT_PANEL_PREFERENCES);
    }
  });

  it('[BT_P16] keeps collapse during reversal, persists it, and retains the original navigation width', () => {
    const saved = Object.freeze({ ...DEFAULT_PANEL_PREFERENCES, leftWidth: 320 });
    let preview = resizePanelFromDrag(saved, 'right', 900, 1440, true);
    preview = resizePanelFromDrag(preview, 'right', 700, 1440, true);
    expect(preview).toEqual({ leftWidth: 320, rightWidth: 700, leftCollapsed: true });
    preview = resizePanelFromDrag(preview, 'right', 1000, 1440, true);
    const restored = readPanelPreferences(JSON.stringify(preview));
    expect(restored).toEqual({ leftWidth: 320, rightWidth: 1000, leftCollapsed: true });
    expect(resolvePanelLayout({ ...restored, leftCollapsed: false }, 1440, true).left).toBe(320);
    expect(saved.leftCollapsed).toBe(false);
    expect(saved.rightWidth).toBe(352);
  });

  it('[BT_P15] keeps the chat usable across workspace sizes and oversized drag requests', () => {
    for (const viewport of [991, 1100, 1280, 1440, 1920]) {
      for (const leftWidth of [220, 252, 420]) {
        let preview = { ...DEFAULT_PANEL_PREFERENCES, leftWidth };
        for (const requested of [400, 800, 5000, 600, -100, Number.NaN]) {
          preview = resizePanelFromDrag(preview, 'right', requested, viewport, true);
          const layout = resolvePanelLayout(preview, viewport, true);
          expect(viewport - layout.left - layout.right).toBeGreaterThanOrEqual(360);
          expect(layout.right).toBeGreaterThanOrEqual(300);
          expect(layout.right).toBeLessThanOrEqual(layout.rightBounds.max);
          expect(preview.leftWidth).toBe(leftWidth);
        }
      }
    }
  });

  it('[BT_P07] [BT_P18] leaves navigation preferences unchanged outside a growing desktop right drag', () => {
    const saved = { ...DEFAULT_PANEL_PREFERENCES };
    for (const viewport of [800, 390]) {
      expect(resizePanelFromDrag(saved, 'right', 5000, viewport, true).leftCollapsed).toBe(false);
    }
    expect(resizePanelFromDrag(saved, 'left', 5000, 1440, true).leftCollapsed).toBe(false);
    expect(resizePanelFromDrag(saved, 'right', 5000, 1440, false).leftCollapsed).toBe(false);
    expect(resizePanelFromDrag(saved, 'right', Number.NaN, 1440, true).leftCollapsed).toBe(false);
    expect(resizePanelFromDrag({ ...saved, rightWidth: 828 }, 'right', 828, 1440, true).leftCollapsed).toBe(false);
    expect(resizePanelFromDrag({ ...saved, rightWidth: 828 }, 'right', 800, 1440, true).leftCollapsed).toBe(false);
    expect(resizePanelByKey(saved, 'right', 'End', 1440, true)).toEqual({ ...saved, rightWidth: 828 });
    expect(resolvePanelLayout(saved, 1100, true).left).toBe(252);
    expect(saved.leftCollapsed).toBe(false);
  });
});
