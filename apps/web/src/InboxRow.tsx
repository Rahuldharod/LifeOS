import React from "react";
import { LockBadge } from "./EnvelopeBadges.js";
import { kindClass, type InboxReview, type RowCells } from "./inboxModel.js";

const LOW_TIP = "Low confidence: the agent was unsure. Check the source and evidence before accepting.";

/** Low-confidence dot. The tooltip shows on hover and on keyboard focus; the legend above the list passes `legend` to show a plain dot. */
export function LowConfidenceDot({ legend = false }: { legend?: boolean }) {
  return legend ? <span className="inbox-low" aria-hidden>●</span> : <span className="inbox-low" role="img" tabIndex={0} aria-label="Low confidence" data-tip={LOW_TIP}>●</span>;
}

/** One queue row. The tick box and the title button are the controls; clicking anywhere else on the row also opens it. */
export function InboxRow({ review, cells, twoLine, opened, checked, onOpen, onToggleChecked }: {
  review: InboxReview; cells: RowCells; twoLine: boolean; opened: boolean; checked: boolean; onOpen: (id: string) => void; onToggleChecked: (id: string) => void;
}) {
  const id = review.frontmatter.id;
  const sub = [cells.owner, cells.due && `Due ${cells.due}`, cells.project].filter(Boolean) as string[];
  return <div className={`inbox-row${opened ? " selected" : ""}${checked ? " checked" : ""}`} onClick={() => onOpen(id)}>
    <input className="c-check" type="checkbox" aria-label={`Select proposal: ${review.frontmatter.title}`} title="Select for bulk actions (X)" checked={checked} onClick={(event) => event.stopPropagation()} onChange={() => onToggleChecked(id)} />
    <span className="c-kind"><span className={`inbox-badge ${kindClass(cells.kind)}`}>{cells.kind}</span></span>
    <span className="c-dot">{cells.low && <LowConfidenceDot />}</span>
    <div className="c-title">
      <button className="inbox-row-open" aria-label={`Open proposal: ${review.frontmatter.title}`} aria-pressed={opened} onClick={(event) => { event.stopPropagation(); onOpen(id); }}><strong>{review.frontmatter.title}</strong><LockBadge frontmatter={review.frontmatter} /></button>
      {twoLine && <span className="inbox-row-sub">{sub.length ? sub.map((part) => <span key={part}>{part}</span>) : <span>No owner, due date or project</span>}</span>}
    </div>
    {!twoLine && <>
      <span className="c-owner" title={cells.owner}>{cells.owner ?? "—"}</span>
      <span className="c-due">{cells.due ?? "—"}</span>
      <span className="c-project" title={cells.project}>{cells.project ?? "—"}</span>
    </>}
    <span className="c-time">{cells.time}</span>
  </div>;
}
