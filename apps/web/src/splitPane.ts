// Draggable divider between a side column and the main column (PB-024), shared by Notes and
// Calendar. The default width is set in CSS and grows with the screen; a dragged width is a
// per-device preference (ADR 0005), so it lives in browser storage. Double-click resets it.
import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

const MIN_WIDTH = 260;
const MAX_SHARE = 0.6;

function readWidth(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : undefined;
  } catch { return undefined; }
}

function writeWidth(key: string, width: number | undefined) {
  try { if (width === undefined) localStorage.removeItem(key); else localStorage.setItem(key, String(Math.round(width))); }
  catch { /* the default width still applies */ }
}

export function clampSplitWidth(width: number, containerWidth: number) {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, containerWidth * MAX_SHARE)));
}

export function useSplitPane(storageKey: string) {
  const [width, setWidth] = useState(() => readWidth(storageKey));
  const update = (next: number | undefined) => { setWidth(next); writeWidth(storageKey, next); };

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const divider = event.currentTarget;
    const container = divider.parentElement;
    if (!container) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      update(clampSplitWidth(moveEvent.clientX - bounds.left, bounds.width));
    };
    const stop = () => { divider.removeEventListener("pointermove", move); divider.removeEventListener("pointerup", stop); divider.removeEventListener("pointercancel", stop); };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
    divider.addEventListener("pointercancel", stop);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const container = event.currentTarget.parentElement;
    const current = event.currentTarget.previousElementSibling?.getBoundingClientRect().width;
    if (!container || current === undefined) return;
    event.preventDefault();
    update(clampSplitWidth(current + (event.key === "ArrowRight" ? 24 : -24), container.getBoundingClientRect().width));
  }

  return {
    style: (width === undefined ? {} : { "--split-width": `${width}px` }) as CSSProperties,
    dividerProps: {
      role: "separator", "aria-orientation": "vertical" as const, "aria-label": "Resize column (double-click to reset)", tabIndex: 0,
      title: "Drag to resize · double-click to reset", className: "split-divider",
      onPointerDown, onKeyDown, onDoubleClick: () => update(undefined)
    }
  };
}
