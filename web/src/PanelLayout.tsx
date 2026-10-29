import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DEFAULT_PANEL_PREFERENCES,
  PANEL_LAYOUT_STORAGE_KEY,
  readPanelPreferences,
  resizePanelFromDrag,
  resizePanelByKey,
  resolvePanelLayout,
  type PanelBounds,
  type PanelPreferences,
  type PanelSide,
} from "./panel-layout";

function storedPreferences(): PanelPreferences {
  try {
    return readPanelPreferences(window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY));
  } catch { return { ...DEFAULT_PANEL_PREFERENCES }; }
}

export function usePanelLayout(rightOpen: boolean) {
  const container = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState(storedPreferences);
  const [preview, setPreview] = useState<PanelPreferences | null>(null);
  // Pointer events can arrive before React renders the previous preview.
  const previewRef = useRef<PanelPreferences | null>(null);
  const [navigationChanges, setNavigationChanges] = useState(0);
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth || 1280);
  const effective = preview ?? saved;
  const layout = resolvePanelLayout(effective, width, rightOpen);
  const cancel = useCallback(() => {
    previewRef.current = null;
    setPreview(null);
  }, []);

  useEffect(() => {
    const element = container.current;
    const measure = () => {
      const measured = element?.getBoundingClientRect().width || window.innerWidth;
      if (measured > 0) setWidth(measured);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (element) observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(saved)); }
    catch { /* Browser preferences must not block the workspace. */ }
  }, [saved]);
  useEffect(cancel, [width, rightOpen, saved.leftCollapsed, cancel]);

  const resize = (side: PanelSide, requestedWidth: number, commit: boolean) => {
    const next = resizePanelFromDrag(previewRef.current ?? saved, side, requestedWidth, width, rightOpen);
    if (commit) {
      setSaved(next);
      cancel();
    } else {
      previewRef.current = next;
      setPreview(next);
    }
  };
  const resizeByKey = (side: PanelSide, key: string, shiftKey: boolean) => {
    const next = resizePanelByKey(saved, side, key, width, rightOpen, shiftKey);
    if (!next) return false;
    setSaved(next);
    cancel();
    return true;
  };
  const toggleLeft = () => {
    const leftCollapsed = !(previewRef.current ?? saved).leftCollapsed;
    cancel();
    setSaved((previous) => ({ ...previous, leftCollapsed }));
    // The manual choice may equal the saved value while an automatic preview is active.
    setNavigationChanges((previous) => previous + 1);
  };
  return {
    container,
    layout,
    leftCollapsed: effective.leftCollapsed,
    resetKey: `${width}:${rightOpen}:${saved.leftCollapsed}:${navigationChanges}`,
    style: {
      "--sidebar-width": `${layout.left}px`,
      "--details-width": `${layout.right}px`,
    } as CSSProperties,
    resize,
    resizeByKey,
    cancel,
    toggleLeft,
  };
}

export interface PanelSeparatorProps {
  side: PanelSide;
  value: number;
  bounds: PanelBounds;
  controls: string;
  resetKey: string;
  onResize: (width: number, commit: boolean) => void;
  onCancel: () => void;
  onKeyResize: (key: string, shiftKey: boolean) => boolean;
  onToggle: () => void;
}

/** A drag changes only a preview until pointer-up commits the preference. */
export function PanelSeparator(props: PanelSeparatorProps) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    width: number;
    cleanup: () => void;
  } | null>(null);
  const finish = useCallback((commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    active.cleanup();
    setDragging(false);
    if (commit) callbacks.current.onResize(active.width, true);
    else callbacks.current.onCancel();
  }, []);
  useEffect(() => () => finish(false), [finish, props.resetKey]);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = document.documentElement;
    if (event.button !== 0 || drag.current || root.dataset.panelResizing) return;
    event.preventDefault();
    event.currentTarget.focus();
    const target = event.currentTarget;
    const { pointerId, clientX } = event;
    const startWidth = props.value;
    const direction = props.side === "left" ? 1 : -1;
    const previousCursor = root.style.cursor;
    const previousSelection = root.style.userSelect;
    root.style.cursor = "col-resize";
    root.style.userSelect = "none";
    root.dataset.panelResizing = props.side;
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId || !drag.current) return;
      next.preventDefault();
      drag.current.width = startWidth + (next.clientX - clientX) * direction;
      callbacks.current.onResize(drag.current.width, false);
    };
    const up = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId || !drag.current) return;
      drag.current.width = startWidth + (next.clientX - clientX) * direction;
      finish(true);
    };
    const cancel = (next: globalThis.PointerEvent) => {
      if (next.pointerId === pointerId) finish(false);
    };
    const blur = () => finish(false);
    const escape = (next: globalThis.KeyboardEvent) => {
      if (next.key === "Escape") finish(false);
    };
    drag.current = {
      pointerId,
      width: startWidth,
      cleanup: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", blur);
        window.removeEventListener("keydown", escape, true);
        root.style.cursor = previousCursor;
        root.style.userSelect = previousSelection;
        delete root.dataset.panelResizing;
        try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); }
        catch { /* A removed handle may already have lost its capture. */ }
      },
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape, true);
    try { target.setPointerCapture(pointerId); }
    catch { /* Window listeners also cover environments without pointer capture. */ }
    setDragging(true);
  };

  return <div
    className={`panel-separator panel-separator-${props.side}${dragging ? " is-dragging" : ""}`}
    role="separator"
    tabIndex={0}
    aria-label={props.side === "left" ? "调整导航宽度" : "调整详情宽度"}
    aria-orientation="vertical"
    aria-controls={props.controls}
    aria-valuemin={props.bounds.min}
    aria-valuemax={props.bounds.max}
    aria-valuenow={props.value}
    aria-valuetext={`${Math.round(props.value)}px`}
    onPointerDown={start}
    onLostPointerCapture={() => finish(false)}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(false);
        props.onToggle();
      } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        finish(false);
        if (props.onKeyResize(event.key, event.shiftKey)) event.preventDefault();
      }
    }}
  />;
}
