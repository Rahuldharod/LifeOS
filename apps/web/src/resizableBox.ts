// Bottom-right corner handle that resizes a note editor freely (PB-024 follow-up, PB-028). The default
// size comes from CSS (70% of the column, full height); a dragged size is a per-device preference
// (ADR 0005), kept in browser storage. Double-click the handle to go back to the default.
import { useState, type CSSProperties, type PointerEvent } from "react";

export type BoxSize = { width: number; height: number };

const MIN_WIDTH = 360;
const MIN_HEIGHT = 280;

/** Per-box limits. Without `maxHeight` the height is free to grow (the Notes editor scrolls inside its column). */
export type BoxLimits = { minWidth?: number; minHeight?: number; maxHeight?: number };

/** Never narrower or shorter than the minimum, never wider than the column it sits in (nor taller than `maxHeight`). */
export function clampBoxSize(size: BoxSize, maxWidth: number, limits: BoxLimits = {}): BoxSize {
  const minWidth = limits.minWidth ?? MIN_WIDTH;
  const minHeight = limits.minHeight ?? MIN_HEIGHT;
  const height = Math.max(size.height, minHeight);
  return {
    width: Math.round(Math.min(Math.max(size.width, minWidth), Math.max(minWidth, maxWidth))),
    height: Math.round(limits.maxHeight === undefined ? height : Math.min(height, Math.max(minHeight, limits.maxHeight)))
  };
}

/** How a box is anchored and limited: a popup is centred and must stay inside the window; the editor is neither. */
export type ResizableBoxOptions = BoxLimits & { centered?: boolean; fitWindow?: boolean };

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

/**
 * The remembered size under `key`. When nothing is stored there yet, a size kept under an older key
 * is moved across (copied to `key`, then removed), so renaming a key never loses the user's size.
 */
export function readRememberedSize(key: string, legacyKeys: readonly string[] = []): BoxSize | undefined {
  const current = readSize(key);
  if (current) return current;
  for (const legacyKey of legacyKeys) {
    const legacy = readSize(legacyKey);
    if (!legacy) continue;
    writeSize(key, legacy);
    try { localStorage.removeItem(legacyKey); } catch { /* the copy under the new key is what counts */ }
    return legacy;
  }
  return undefined;
}

export function useResizableBox(storageKey: string, legacyKeys: readonly string[] = [], options: ResizableBoxOptions = {}) {
  const [size, setSize] = useState(() => readRememberedSize(storageKey, legacyKeys));
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
      // A centred box grows on both sides, so the pointer sits half the width from its centre.
      const width = options.centered ? 2 * (moveEvent.clientX - (start.left + start.width / 2)) : moveEvent.clientX - start.left;
      update(clampBoxSize({ width, height: moveEvent.clientY - start.top }, column.clientWidth, {
        ...options, ...(options.fitWindow ? { maxHeight: column.clientHeight - start.top } : {})
      }));
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
