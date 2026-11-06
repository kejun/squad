import assert from 'node:assert/strict';
import { DEFAULT_PANEL_PREFERENCES, readPanelPreferences, resolvePanelLayout, resizePanelByKey, resizePanelFromDrag } from '../web/src/panel-layout.js';

export function dragBoundaryContract(requested: number, collapsed: boolean) {
  const saved = Object.freeze({ ...DEFAULT_PANEL_PREFERENCES });
  const preview = resizePanelFromDrag(saved, 'right', requested, 1440, true);
  assert.equal(preview.leftCollapsed, collapsed); assert.equal(resolvePanelLayout(preview, 1440, true).right, requested);
  assert.deepEqual(saved, DEFAULT_PANEL_PREFERENCES);
}
export function reversedDragContract() {
  const saved = Object.freeze({ ...DEFAULT_PANEL_PREFERENCES, leftWidth: 320 });
  const expanded = resizePanelFromDrag(saved, 'right', 900, 1440, true);
  const reversed = resizePanelFromDrag(expanded, 'right', 700, 1440, true);
  const restored = readPanelPreferences(JSON.stringify(reversed));
  assert.deepEqual(restored, { leftWidth: 320, rightWidth: 700, leftCollapsed: true });
  assert.equal(resolvePanelLayout({ ...restored, leftCollapsed: false }, 1440, true).left, 320);
  assert.deepEqual(saved, { leftWidth: 320, rightWidth: 352, leftCollapsed: false });
}
export function keyboardBoundaryContract() {
  assert.deepEqual(resizePanelByKey({ ...DEFAULT_PANEL_PREFERENCES }, 'right', 'End', 1440, true), { leftWidth: 252, rightWidth: 828, leftCollapsed: false });
}
