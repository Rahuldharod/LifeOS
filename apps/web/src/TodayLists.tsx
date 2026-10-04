// #48/#64: shared building blocks for Today's lists. Every list shows at most 7 rows before a real
// "Show N more" button (keyboard and screen readers reach it), and restricted items carry the lock badge.
import React, { useId, useState } from "react";
import { LockBadge } from "./EnvelopeBadges.js";
import { PersonName } from "./PersonName.js";
import { visibleRows } from "./todayPanels.js";

/** Rows capped by `visibleRows`, with a "Show N more" / "Show fewer" toggle when some are hidden. */
export function CappedRows<T>({ items, row }: { items: readonly T[]; row: (item: T) => React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const { rows, hidden } = visibleRows(items, expanded);
  const collapsible = visibleRows(items, false).hidden > 0;
  return <>
    <div id={`${id}-rows`}>{rows.map(row)}</div>
    {collapsible && <button type="button" className="show-more" aria-expanded={expanded} aria-controls={`${id}-rows`} onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer" : `Show ${hidden} more`}</button>}
  </>;
}

/** One live panel; the count sits in the heading as text. */
export function LivePanel<T>({ title, items, empty, row, note }: { title: string; items: readonly T[]; empty: string; row: (item: T) => React.ReactNode; note?: React.ReactNode }) {
  const id = useId();
  return <article className="live-panel" aria-labelledby={`${id}-title`}>
    <span id={`${id}-title`}>{title.toUpperCase()} · {items.length}</span>
    {note}
    {!items.length && <p className="muted">{empty}</p>}
    <CappedRows items={items} row={row} />
  </article>;
}

type TaskLike = { frontmatter: Record<string, unknown> & { id: string; title: string } };
export type WaitingGroup = { personId?: string; name: string; suffix?: string; label: string; isExternal: boolean; tasks: TaskLike[] };

/** A person (standard label, so " - ext" is styled text) followed by one row per waiting task. */
export function WaitingGroupRow({ group }: { group: WaitingGroup }) {
  return <div className="waiting-group">
    <h4><PersonName name={group.name} suffix={group.suffix} /> <small>{group.tasks.length} waiting</small></h4>
    {group.tasks.map((task) => <div className="object-row" key={task.frontmatter.id}><i /><div><b>{task.frontmatter.title}<LockBadge frontmatter={task.frontmatter} /></b></div></div>)}
  </div>;
}

/** A meeting with no material after enrichment; the button's name says which meeting it gives up on. */
export function GiveUpRow({ meeting, disabled, onGiveUp }: { meeting: { meetingId: string; title: string }; disabled: boolean; onGiveUp: (meetingId: string) => void }) {
  return <div className="object-row"><i /><div><b>{meeting.title}</b><small>No material 48 hours after the request</small></div>
    <button type="button" aria-label={`Give up waiting for material from ${meeting.title}`} disabled={disabled} onClick={() => onGiveUp(meeting.meetingId)}>Give up</button></div>;
}
