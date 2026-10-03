// Bottom-right corner handle that resizes the Notes editor freely (PB-024 follow-up). The default
// size comes from CSS (70% of the column, full height); a dragged size is a per-device preference
// (ADR 0005), kept in browser storage. Double-click the handle to go back to the default.
import { useState, type CSSProperties, type PointerEvent } from "react";

export type BoxSize = { width: number; height: number };

const MIN_WIDTH = 360;
const MIN_HEIGHT = 280;

/** Never narrower or shorter than the minimum, never wider than the column it sits in. */
export function clampBoxSize(size: BoxSize, maxWidth: number): BoxSize {
  return {
    width: Math.round(Math.min(Math.max(size.width, MIN_WIDTH), Math.max(MIN_WIDTH, maxWidth))),
    height: Math.round(Math.max(size.height, MIN_HEIGHT))
  };
}

function readSize(key: string): BoxSize | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<BoxSize> | null;
    return value && Number.isFinite(value.width) && Number.isFinite(value.height) ? { width: value.width!, height: value.height! } : undefined;
  } catch { return undefined; }
}

function writeSize(key: string, size: BoxSize | undefined) {
  try { if (size) localStorage.setItem(key, JSON.stringify(size)); else localStorage.removeItem(key); }
  catch { /* the default size still applies */ }
}

export function useResizableBox(storageKey: string) {
  const [size, setSize] = useState(() => readSize(storageKey));
  const update = (next: BoxSize | undefined) => { setSize(next); writeSize(storageKey, next); };

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const handle = event.currentTarget;
    const box = handle.parentElement;
    const column = box?.parentElement;
    if (!box || !column) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const start = box.getBoundingClientRect();
    const move = (moveEvent: globalThis.PointerEvent) => {
      update(clampBoxSize({ width: moveEvent.clientX - start.left, height: moveEvent.clientY - start.top }, column.clientWidth));
    };
    const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  return {
    resized: size !== undefined,
    style: (size ? { width: `${size.width}px`, height: `${size.height}px` } : {}) as CSSProperties,
    handleProps: {
      className: "resize-handle", role: "separator", "aria-label": "Resize editor (double-click to reset)",
      title: "Drag to resize · double-click to reset", onPointerDown, onDoubleClick: () => update(undefined)
    }
  };
}
