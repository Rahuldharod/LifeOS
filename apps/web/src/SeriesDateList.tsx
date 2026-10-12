/**
 * A compact list of occurrence dates (#184). Each button hands its Note id back to the Series view, which opens
 * that entry and scrolls it into view. Shown only when there is more than one earlier Note to move between.
 */
export function SeriesDateList({ items, onJump }: { items: { noteId: string; label: string }[]; onJump: (noteId: string) => void }) {
  if (items.length < 2) return null;
  return <nav className="series-date-list" aria-label="Jump to an occurrence">
    {items.map((item) => <button type="button" key={item.noteId} onClick={() => onJump(item.noteId)}>{item.label}</button>)}
  </nav>;
}
