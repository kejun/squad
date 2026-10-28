export type PanelSide = "left" | "right";

export interface PanelPreferences {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
}

export const PANEL_LAYOUT_STORAGE_KEY = "squad:panel-layout:v1";
export const DEFAULT_PANEL_PREFERENCES: Readonly<PanelPreferences> = {
  leftWidth: 252,
  rightWidth: 352,
  leftCollapsed: false,
};

export interface PanelBounds {
  min: number;
  max: number;
}

export interface PanelLayout {
  mobile: boolean;
  detailsOverlay: boolean;
  left: number;
  right: number;
  leftBounds: PanelBounds;
  rightBounds: PanelBounds;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function preferences(value: unknown): PanelPreferences {
  const source = value && typeof value === "object"
    ? value as Partial<PanelPreferences> : {};
  const width = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(clamp(value, min, max)) : fallback;
  return {
    leftWidth: width(source.leftWidth, 252, 220, 420),
    rightWidth: width(source.rightWidth, 352, 300, Number.MAX_SAFE_INTEGER),
    leftCollapsed: typeof source.leftCollapsed === "boolean"
      ? source.leftCollapsed : false,
  };
}

export function readPanelPreferences(raw: string | null): PanelPreferences {
  try { return preferences(raw === null ? null : JSON.parse(raw)); }
  catch { return { ...DEFAULT_PANEL_PREFERENCES }; }
}

/** Temporary viewport constraints never replace the user's saved widths. */
export function resolvePanelLayout(
  saved: PanelPreferences,
  viewportWidth: number,
  rightOpen: boolean,
): PanelLayout {
  const pref = preferences(saved);
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0
    ? viewportWidth : 1280;
  const mobile = width <= 720;
  const detailsOverlay = width <= 990;
  const overlaySpace = Math.max(0, Math.floor(width - 32));
  const leftMax = Math.floor(mobile
    ? Math.min(420, overlaySpace)
    : Math.min(420, width - 360 - (rightOpen && !detailsOverlay ? 300 : 0)));
  const leftBounds = { min: Math.min(220, leftMax), max: leftMax };
  const left = !mobile && pref.leftCollapsed
    ? 0 : clamp(pref.leftWidth, leftBounds.min, leftBounds.max);
  const rightMax = Math.floor(detailsOverlay
    ? Math.min(680, overlaySpace)
    : width - 360 - left);
  const rightBounds = { min: Math.min(300, rightMax), max: rightMax };
  return {
    mobile,
    detailsOverlay,
    left,
    right: clamp(pref.rightWidth, rightBounds.min, rightBounds.max),
    leftBounds,
    rightBounds,
  };
}

export function resizePanel(
  saved: PanelPreferences,
  side: PanelSide,
  requestedWidth: number,
  viewportWidth: number,
  rightOpen: boolean,
): PanelPreferences {
  const pref = preferences(saved);
  const layout = resolvePanelLayout(pref, viewportWidth, rightOpen);
  const bounds = side === "left" ? layout.leftBounds : layout.rightBounds;
  const fallback = side === "left" ? layout.left : layout.right;
  const width = Math.round(clamp(
    Number.isFinite(requestedWidth) ? requestedWidth : fallback,
    bounds.min,
    bounds.max,
  ));
  return { ...pref, [side === "left" ? "leftWidth" : "rightWidth"]: width };
}

export function resizePanelByKey(
  saved: PanelPreferences,
  side: PanelSide,
  key: string,
  viewportWidth: number,
  rightOpen: boolean,
  shiftKey = false,
): PanelPreferences | undefined {
  const layout = resolvePanelLayout(saved, viewportWidth, rightOpen);
  const bounds = side === "left" ? layout.leftBounds : layout.rightBounds;
  const current = side === "left" ? layout.left : layout.right;
  const step = shiftKey ? 50 : 10;
  let width: number;
  if (key === "Home") width = bounds.min;
  else if (key === "End") width = bounds.max;
  else if (key === "ArrowLeft") width = current + (side === "left" ? -step : step);
  else if (key === "ArrowRight") width = current + (side === "left" ? step : -step);
  else return undefined;
  return resizePanel(saved, side, width, viewportWidth, rightOpen);
}
