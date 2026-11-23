import React from "react";
import { OverlayDialog } from "./OverlayDialog.js";

/** Every Inbox key, in one list: the sheet shows it and the tests check it. */
export const inboxShortcuts: Array<{ keys: string; what: string }> = [
  { keys: "↑ ↓ or J K", what: "Move focus (the reading pane stays on the open item)" },
  { keys: "Enter or click", what: "Open the focused item" },
  { keys: "A", what: "Accept the focused item, or all ticked items" },
  { keys: "R", what: "Reject the focused item, or all ticked items" },
  { keys: "S", what: "Save edits on the open item" },
  { keys: "X", what: "Tick or untick the focused item" },
  { keys: "Shift + X or Shift + click", what: "Tick a range from the last ticked item" },
  { keys: "Esc", what: "Clear the ticks; in List view, go back to the list" },
  { keys: "1 – 6", what: "Switch tab" },
  { keys: "V", what: "Switch between Split and List view" },
  { keys: "?", what: "Show this sheet" }
];

export function InboxShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <OverlayDialog open={open} label="Inbox keyboard shortcuts" className="inbox-shortcuts" onClose={onClose}>
    <h3>Keyboard shortcuts</h3>
    <table><tbody>{inboxShortcuts.map(({ keys, what }) => <tr key={keys}><th scope="row"><kbd>{keys}</kbd></th><td>{what}</td></tr>)}</tbody></table>
    <p className="muted">Keys never fire while you type in a field. Press Esc to leave the field first.</p>
    <button data-overlay-autofocus onClick={onClose}>Close</button>
  </OverlayDialog>;
}
