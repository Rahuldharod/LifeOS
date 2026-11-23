import { useEffect, useRef } from "react";
import { inboxTabs, interactiveTarget, typingTarget, type InboxTab, type Outcome } from "./inboxModel.js";

/** What each Inbox key does. Each action returns true when it did something, so the key's browser default (scrolling, typing) is cancelled only then. */
export type InboxKeyActions = {
  setTab: (tab: InboxTab) => void;
  /** ↑/↓ and J/K. */
  moveFocus: (direction: -1 | 1) => boolean;
  /** Enter on the Focused item. */
  openFocused: () => boolean;
  /** X (one item) and Shift+X (a range from the last anchor). */
  toggleFocused: (range: boolean) => boolean;
  /** A and R: the Focused item, or every ticked item. */
  decide: (outcome: Outcome) => boolean;
  /** S: the Open item's Save edits. */
  save: () => boolean;
  /** Esc: go back to the list from an item shown full width (List view), else clear the ticks. */
  clearSelection: () => boolean;
  /** V: switch between Split and List view. */
  toggleView: () => boolean;
  showHelp: () => void;
};

/** Inbox keys. None fire while typing in a field or inside a dialog; Esc leaving a field is `escapeLeavesField.ts`. */
export function useInboxKeys(actions: InboxKeyActions) {
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(typingTarget)) return;
    const key = event.key; const lower = key.toLowerCase();
    const done = (handled: boolean) => { if (handled) event.preventDefault(); };
    if (key === "?") { event.preventDefault(); actions.showHelp(); return; }
    if (key === "Escape") { done(actions.clearSelection()); return; }
    if (key === "ArrowUp" || key === "ArrowDown" || lower === "j" || lower === "k") { // holding the key keeps moving
      if (!event.shiftKey) done(actions.moveFocus(key === "ArrowUp" || lower === "k" ? -1 : 1));
      return;
    }
    if (key === "Enter") { if (!target?.closest(interactiveTarget)) done(actions.openFocused()); return; }
    if (event.repeat) return; // holding A must not accept item after item
    if (/^[1-6]$/.test(key)) { event.preventDefault(); actions.setTab(inboxTabs[Number(key) - 1]!); return; } // AZERTY digits need Shift
    if (lower === "x") { done(actions.toggleFocused(event.shiftKey)); return; }
    if (event.shiftKey) return;
    if (lower === "a") done(actions.decide("accepted"));
    else if (lower === "r") done(actions.decide("rejected"));
    else if (lower === "s") done(actions.save());
    else if (lower === "v") done(actions.toggleView());
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      keys.current(event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
