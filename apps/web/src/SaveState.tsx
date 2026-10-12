import React from "react";

/**
 * The save status line under a note editor, with the one-shot "Keep disk version" undo. Shared by the Notes
 * view, the Calendar meeting workspace and the Series view so every editor says the same thing.
 */
export function SaveState({ dirty, autoSaving, pending = false, undoAvailable, undoDisabled, onUndo }: {
  dirty: boolean;
  autoSaving: boolean;
  /** An open draft with no file behind it yet (a calendar event with no note). */
  pending?: boolean;
  undoAvailable: boolean;
  undoDisabled: boolean;
  onUndo: () => void;
}) {
  const text = pending && !dirty ? "Not saved yet · nothing is written until you edit"
    : dirty ? autoSaving ? "Saving to Markdown…" : "Cached locally · autosave pending"
    : "Saved to Markdown";
  return <div className="save-state" role="status"><i className={dirty ? "dirty" : "saved"} />{text}{undoAvailable && <button disabled={undoDisabled} onClick={onUndo}>Undo "Keep disk version"</button>}</div>;
}
