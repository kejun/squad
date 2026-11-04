import assert from 'node:assert/strict';
import { DEFAULT_PANEL_PREFERENCES, resolvePanelLayout, resizePanelFromDrag } from '../web/src/panel-layout.js';

/** Bounded transition sweep; keep enumeration out of individual unit test bodies. */
export function simulatePanelDrags() {
  let transitions = 0;
  for (const viewport of [991, 1100, 1280, 1440, 1920]) {
    for (const leftWidth of [220, 252, 420]) {
      let preview = { ...DEFAULT_PANEL_PREFERENCES, leftWidth };
      for (const requested of [400, 800, 5000, 600, -100, Number.NaN]) {
        preview = resizePanelFromDrag(preview, 'right', requested, viewport, true);
        const layout = resolvePanelLayout(preview, viewport, true);
        const label = `viewport=${viewport}, left=${leftWidth}, requested=${requested}`;
        assert(viewport - layout.left - layout.right >= 360, label);
        assert(layout.right >= 300 && layout.right <= layout.rightBounds.max, label);
        assert.equal(preview.leftWidth, leftWidth, label);
        transitions++;
      }
    }
  }
  return { transitions };
}
