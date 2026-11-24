import React from "react";
import { OverlayDialog } from "./OverlayDialog.js";

/** Every Inbox key, in one list: the sheet shows it and the tests check it. */
export const inboxShortcuts: Array<{ keys: string; what: string }> = [
  { keys: "↑ ↓", what: "Move focus (the reading pane stays on the open item)" },
  { keys: "Enter or click", what: "Open the focused item" },
  { keys: "A", what: "Accept the focused item, or all ticked items" },
  { keys: "R", what: "Reject the focused item, or all ticked items" },
  { keys: "F / O", what: "In Split view, when the focused row isn't the open item, A or R asks: F applies to the Focused row, O to the Open item, Esc cancels" },
  { keys: "Z", what: "Undo the last Accept or Reject while its message shows (8 seconds)" },
  { keys: "S", what: "Save edits on the open item" },
  { keys: "X", what: "Tick or untick the focused item" },
  { keys: "Shift + X or Shift + click", what: "Tick a range from the last ticked item" },
  { keys: "Esc", what: "Clear the ticks; with an item covering the list (List view, narrow window), go back to the list" },
  { keys: "O", what: "Set Owner on the ticked items, or the focused one" },
  { keys: "D", what: "Set Due date" },
  { keys: "I", what: "Set Priority" },
  { keys: "J", what: "Set Project" },
  { keys: "C", what: "Set Client" },
  { keys: "P", what: "Set Product" },
  { keys: "1 – 6", what: "Switch tab" },
  { keys: "V", what: "Switch between Split and List view" },
  { keys: "G then I", what: "Go to the Inbox list; from an open item, back to its row" },
  { keys: "G then T C K N", what: "Go to Today, Calendar, Tasks, Notes" },
  { keys: "G then D O L", what: "Go to Decisions, Open points, Knowledge" },
  { keys: "G then Y S", what: "Go to System, Settings" },
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
