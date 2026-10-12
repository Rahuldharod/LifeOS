import type { SeriesViewEarlier } from "@lifeos/contracts";

/** The DOM id of one Series view entry, shared by the entry and the jump list. */
export const seriesEntryDomId = (entry: SeriesViewEarlier) => `series-entry-${entry.note.frontmatter.id}`;

/**
 * A compact list of occurrence dates (#184). Each button hands the entry back to the Series view, which opens it
 * and scrolls it into view. Shown only when there is more than one earlier Note to move between.
 */
export function SeriesDateList({ entries, labelOf, onJump }: { entries: SeriesViewEarlier[]; labelOf: (entry: SeriesViewEarlier) => string; onJump: (entry: SeriesViewEarlier) => void }) {
  if (entries.length < 2) return null;
  return <nav className="series-date-list" aria-label="Jump to an occurrence">
    {entries.map((entry) => <button type="button" key={entry.note.frontmatter.id} onClick={() => onJump(entry)}>{labelOf(entry)}</button>)}
  </nav>;
}
