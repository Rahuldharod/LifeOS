import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Keyboard and scroll continuity for list/detail workspaces (#154):
 * - opening a record from the list moves focus to the detail heading, so the context change is announced;
 * - closing it (narrow Back, Cancel) restores the list's scroll position and focus to the originating row.
 * Records opened by a direct link or automatic selection never steal focus.
 * Panes are marked `data-pane="list"` and `data-pane="detail"` inside the element that receives `ref`.
 */
export function useListDetailReturn(selectedKey: string | undefined) {
  const root = useRef<HTMLElement | null>(null);
  const memory = useRef<{ scrollTop: number; row?: HTMLElement; label?: string; fromList: boolean; at: number; openedFromList: boolean }>({ scrollTop: 0, fromList: false, at: 0, openedFromList: false });
  const previous = useRef(selectedKey);
  const cleanup = useRef<() => void>(undefined);

  const ref = useCallback((element: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = undefined;
    root.current = element;
    if (!element) return;
    const list = () => element.querySelector<HTMLElement>("[data-pane='list']");
    const remember = (event: Event) => {
      const pane = list();
      if (!pane || !(event.target instanceof Element) || !pane.contains(event.target)) return;
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      // Only activating a row counts; typing in the list's search box or toggling a checkbox does not.
      const row = event.target.closest<HTMLElement>("button, a, [role='option']");
      if (!row) return;
      memory.current = { ...memory.current, scrollTop: pane.scrollTop, row, label: row.getAttribute("aria-label") ?? undefined, fromList: true, at: Date.now() };
    };
    const scroll = (event: Event) => { if (event.target === list()) memory.current.scrollTop = (event.target as HTMLElement).scrollTop; };
    element.addEventListener("click", remember, true);
    element.addEventListener("keydown", remember, true);
    element.addEventListener("scroll", scroll, true);
    cleanup.current = () => { element.removeEventListener("click", remember, true); element.removeEventListener("keydown", remember, true); element.removeEventListener("scroll", scroll, true); };
  }, []);

  useLayoutEffect(() => {
    const before = previous.current; previous.current = selectedKey;
    if (before === selectedKey || !root.current) return;
    const saved = memory.current;
    const userInitiated = saved.fromList && Date.now() - saved.at < 1_500;
    if (selectedKey) {
      saved.openedFromList = userInitiated;
      if (!userInitiated) return;
      saved.fromList = false;
      const detail = root.current.querySelector<HTMLElement>("[data-pane='detail']");
      if (!detail) return;
      const focusHeading = () => {
        const heading = detail.querySelector<HTMLElement>("[data-detail-heading]") ?? detail.querySelector<HTMLElement>("h1, h2, h3");
        if (!heading) return false;
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
        return true;
      };
      if (focusHeading()) return;
      // Some details load their record first; focus the heading as soon as it appears, unless the user moved on.
      const observer = new MutationObserver(() => { if (focusHeading()) observer.disconnect(); });
      observer.observe(detail, { childList: true, subtree: true });
      const timeout = window.setTimeout(() => observer.disconnect(), 3_000);
      return () => { observer.disconnect(); window.clearTimeout(timeout); };
    }
    // Only a detail opened from this list returns there; a direct link or search result leaves focus alone.
    if (!saved.openedFromList) return;
    saved.openedFromList = false;
    const list = root.current.querySelector<HTMLElement>("[data-pane='list']");
    if (!list) return;
    list.scrollTop = saved.scrollTop;
    const row = saved.row?.isConnected ? saved.row : saved.label ? [...list.querySelectorAll<HTMLElement>("[aria-label]")].find((candidate) => candidate.getAttribute("aria-label") === saved.label) : undefined;
    row?.focus({ preventScroll: true });
  }, [selectedKey]);

  return ref;
}
