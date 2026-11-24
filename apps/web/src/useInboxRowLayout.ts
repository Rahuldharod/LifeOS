// Row layout of the Inbox list: Auto, 1 line or 2 lines (#237). The choice is a per-Mac preference like the divider width (ADR 0005).
// Auto shows one line with columns once the list pane is wide enough, otherwise two lines, and follows the pane as it is resized.
import { useEffect, useState, type RefObject } from "react";

export type RowLayoutMode = "auto" | "one" | "two";
export const rowLayoutModes: Array<{ mode: RowLayoutMode; label: string }> = [{ mode: "auto", label: "Auto" }, { mode: "one", label: "1 line" }, { mode: "two", label: "2 lines" }];
/** Auto shows one line with columns when the list pane is at least this wide. */
export const ONE_LINE_MIN_WIDTH = 940;
export const rowLayoutStorageKey = "lifeos.inboxRowLayout";

export const readRowLayout = (): RowLayoutMode => {
  try { const value = localStorage.getItem(rowLayoutStorageKey); return value === "one" || value === "two" ? value : "auto"; }
  catch { return "auto"; }
};
export const twoLines = (mode: RowLayoutMode, paneWidth: number | undefined) => mode === "two" || (mode === "auto" && paneWidth !== undefined && paneWidth < ONE_LINE_MIN_WIDTH);

export function useInboxRowLayout(paneRef: RefObject<HTMLElement | null>, hidden: boolean) {
  const [mode, setModeState] = useState<RowLayoutMode>(readRowLayout);
  const [paneWidth, setPaneWidth] = useState<number>();
  const setMode = (next: RowLayoutMode) => {
    setModeState(next);
    try { if (next === "auto") localStorage.removeItem(rowLayoutStorageKey); else localStorage.setItem(rowLayoutStorageKey, next); } catch { /* the choice just is not remembered */ }
  };
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver !== "function") return;
    // A hidden pane (narrow screen with a proposal open) measures 0; keep the last real width.
    const measure = () => { const width = Math.round(pane.getBoundingClientRect().width); if (width > 0) setPaneWidth(width); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [paneRef, hidden]);
  return { mode, setMode, twoLine: twoLines(mode, paneWidth) };
}
