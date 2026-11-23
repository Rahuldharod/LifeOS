// The shared bounded divider between a list pane and its detail (PB-024, #154). Each workspace has its own clamp
// (workspaceLayout.ts); a dragged width is a per-device preference (ADR 0005), stored per workspace in browser
// storage and clamped again on read, so an old or hand-edited value can never break the layout. Double-click resets.
import { useCallback, useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { clampListWidth, detailReserve, listClamps, type ListWorkspace } from "./workspaceLayout.js";

/** Earlier releases used these keys for Notes and Calendar; keep them so a remembered width survives. */
export const splitStorageKey = (workspace: ListWorkspace) => workspace === "notes" ? "lifeos.notesSplitWidth" : `lifeos.split.${workspace}`;

export function readStoredWidth(workspace: ListWorkspace) {
  try {
    const raw = localStorage.getItem(splitStorageKey(workspace));
    const value = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const { min, max = Number.POSITIVE_INFINITY } = listClamps[workspace];
    return Math.round(Math.min(Math.max(value, min), max));
  } catch { return undefined; }
}

function writeWidth(workspace: ListWorkspace, width: number | undefined) {
  try { if (width === undefined) localStorage.removeItem(splitStorageKey(workspace)); else localStorage.setItem(splitStorageKey(workspace), String(Math.round(width))); }
  catch { /* the default width still applies */ }
}

const STEP = 24;

/** `onDoubleClick` replaces the default reset (the Inbox goes to its List view; Enter still resets the width). */
export function useSplitPane(workspace: ListWorkspace, options: { onDoubleClick?: () => void } = {}) {
  const [width, setWidth] = useState(() => readStoredWidth(workspace));
  const update = (next: number | undefined) => { setWidth(next); writeWidth(workspace, next); };
  const { min, max } = listClamps[workspace];
  const { onDoubleClick } = options;
  // The default width comes from CSS, so announce the width the list actually has, not a guess.
  const [divider, setDivider] = useState<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState<number>();
  useEffect(() => {
    const list = divider?.previousElementSibling;
    if (!list || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setRendered(Math.round(list.getBoundingClientRect().width)));
    observer.observe(list);
    return () => observer.disconnect();
  }, [divider]);
  const ref = useCallback((element: HTMLDivElement | null) => setDivider(element), []);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const divider = event.currentTarget;
    const container = divider.parentElement;
    if (!container || event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      update(clampListWidth(moveEvent.clientX - bounds.left, workspace, bounds.width));
    };
    const stop = () => { divider.removeEventListener("pointermove", move); divider.removeEventListener("pointerup", stop); divider.removeEventListener("pointercancel", stop); };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
    divider.addEventListener("pointercancel", stop);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const container = event.currentTarget.parentElement;
    const current = event.currentTarget.previousElementSibling?.getBoundingClientRect().width;
    if (!container || current === undefined) return;
    const containerWidth = container.getBoundingClientRect().width;
    const next = event.key === "ArrowLeft" ? current - STEP : event.key === "ArrowRight" ? current + STEP : event.key === "Home" ? min : event.key === "End" ? (max ?? containerWidth) : undefined;
    if (event.key === "Enter" || event.key === "Escape") { event.preventDefault(); update(undefined); return; }
    if (next === undefined) return;
    event.preventDefault();
    update(clampListWidth(next, workspace, containerWidth));
  }

  return {
    style: { "--list-min": `${min}px`, "--list-max": max === undefined ? "100000px" : `${max}px`, "--detail-reserve": `${detailReserve(workspace)}px`, ...(width === undefined ? {} : { "--split-width": `${width}px` }) } as CSSProperties,
    dividerProps: {
      role: "separator", "aria-orientation": "vertical" as const, "aria-label": onDoubleClick ? "Resize list (Enter to reset, double-click for List view)" : "Resize list (double-click or Enter to reset)", tabIndex: 0,
      ref, "aria-valuemin": min, ...(max === undefined ? {} : { "aria-valuemax": max }), "aria-valuenow": width ?? rendered ?? min,
      title: onDoubleClick ? "Drag to resize · double-click for List view" : "Drag to resize · double-click to reset", className: "split-divider",
      onPointerDown, onKeyDown, onDoubleClick: onDoubleClick ?? (() => update(undefined))
    }
  };
}
