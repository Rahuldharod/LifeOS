// PB-028: one layout for every note editor (Notes and the Calendar meeting note). The frame takes
// 70% of its column, fills the visible column height and scrolls inside; text keeps the readable
// line length set in styles.css. Its corner handle resizes it, and the size is one per-device
// preference (ADR 0005) shared by every page, so resizing in Notes also applies in Calendar.
import React, { type ReactNode } from "react";
import { useResizableBox } from "./resizableBox.js";

/** Browser-storage key of the shared editor size. */
export const EDITOR_SIZE_KEY = "lifeos.editorSize";
/** Keys used before PB-028; a size found there is moved to EDITOR_SIZE_KEY once. */
export const LEGACY_EDITOR_SIZE_KEYS = ["lifeos.notesEditorSize"] as const;

export function EditorFrame({ className, children }: { className?: string; children: ReactNode }) {
  const box = useResizableBox(EDITOR_SIZE_KEY, LEGACY_EDITOR_SIZE_KEYS);
  const classes = ["editor-card", "editor-frame", box.resized ? "resized" : "", className ?? ""].filter(Boolean).join(" ");
  return <article className={classes} style={box.style}>
    {children}
    <div {...box.handleProps} />
  </article>;
}
