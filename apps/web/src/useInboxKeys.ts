import { useEffect, useRef, type RefObject } from "react";
import { inboxTabs, typingTarget, type InboxTab } from "./inboxModel.js";

/** Inbox keys: ↑/↓ move, 1–6 switch tab, X ticks the open item, A/R/S press the open item's buttons that carry `data-shortcut`. */
export function useInboxKeys({ detailRef, step, setTab, toggleOpenChecked }: {
  detailRef: RefObject<HTMLElement | null>; step: (direction: -1 | 1) => boolean; setTab: (tab: InboxTab) => void;
  /** Ticks the open item; returns false when no open item is in the list. */
  toggleOpenChecked: () => boolean;
}) {
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    const target = event.target as HTMLElement | null;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']")) return;
      if (step(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
      return;
    }
    if (event.repeat || target?.closest(typingTarget)) return; // holding A must not accept item after item
    const key = event.key.toLowerCase();
    const tabIndex = Number(key) - 1;
    if (/^[1-6]$/.test(key)) { event.preventDefault(); setTab(inboxTabs[tabIndex]!); return; }
    if (key === "x") { if (toggleOpenChecked()) event.preventDefault(); return; }
    if (key !== "a" && key !== "r" && key !== "s") return;
    const control = detailRef.current?.querySelector<HTMLButtonElement>(`button[data-shortcut='${key}']`);
    if (!control || control.disabled) return;
    event.preventDefault(); control.click();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      keys.current(event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
