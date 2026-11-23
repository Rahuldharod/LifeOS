import React from "react";
import { LockBadge } from "./EnvelopeBadges.js";
import { dateInTimeZone } from "./zonedTime.js";
import { proposalLabel, type InboxReview } from "./inboxModel.js";

/** One queue row: a tick box for bulk actions and a button that opens the proposal. */
export function InboxRow({ review, opened, checked, displayTimeZone, onOpen, onToggleChecked }: {
  review: InboxReview; opened: boolean; checked: boolean; displayTimeZone: string; onOpen: (id: string) => void; onToggleChecked: (id: string) => void;
}) {
  const id = review.frontmatter.id;
  return <div className={`inbox-row${opened ? " selected" : ""}${checked ? " checked" : ""}`}>
    <input type="checkbox" aria-label={`Select proposal: ${review.frontmatter.title}`} title="Select for bulk actions (X)" checked={checked} onChange={() => onToggleChecked(id)} />
    <button className="inbox-row-open" aria-label={`Open proposal: ${review.frontmatter.title}`} aria-pressed={opened} onClick={() => onOpen(id)}><span><strong>{review.frontmatter.title}</strong><small>{proposalLabel(review)} · {dateInTimeZone(new Date(review.frontmatter.created_at), displayTimeZone)}</small></span><LockBadge frontmatter={review.frontmatter} /></button>
  </div>;
}
