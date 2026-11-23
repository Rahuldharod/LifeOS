// Split / List view of the Inbox (#240): Split shows the list beside the reading pane, List gives the list the full width and
// shows an opened item in its place. A per-Mac preference like the divider width and row layout (ADR 0005).
import { useState } from "react";

export type InboxView = "split" | "list";
export const inboxViews: Array<{ view: InboxView; label: string }> = [{ view: "split", label: "Split" }, { view: "list", label: "List" }];
export const inboxViewStorageKey = "lifeos.inboxView";

export const readInboxView = (): InboxView => {
  try { return localStorage.getItem(inboxViewStorageKey) === "list" ? "list" : "split"; }
  catch { return "split"; }
};

export function useInboxView() {
  const [view, setViewState] = useState<InboxView>(readInboxView);
  const setView = (next: InboxView) => {
    setViewState(next);
    try { if (next === "split") localStorage.removeItem(inboxViewStorageKey); else localStorage.setItem(inboxViewStorageKey, next); } catch { /* the choice just is not remembered */ }
  };
  return { view, setView };
}
