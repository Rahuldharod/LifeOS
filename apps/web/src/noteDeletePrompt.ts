import type { LifeObject } from "@lifeos/contracts";

/** The shared-note scope is explicit before the recoverable tombstone action. */
export function noteDeletePrompt(note: LifeObject, dirty: boolean) {
  const series = typeof note.frontmatter.recurrence_series_id === "string"
    ? "\n\nThis affects the whole recurring series, including every occurrence section."
    : "";
  const unsaved = dirty ? "\n\nUnsaved changes in this note will be lost." : "";
  return `Delete "${note.frontmatter.title}"?\n\nIt disappears from LifeOS. The Markdown file is kept and marked as deleted.${series}${unsaved}`;
}
