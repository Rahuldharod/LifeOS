import React from "react";
import { LockBadge } from "./EnvelopeBadges.js";
import { kindClass, needsChoice, type InboxReview, type Outcome, type RowCells } from "./inboxModel.js";

const LOW_TIP = "Low confidence: the agent was unsure. Check the source and evidence before accepting.";

/** Low-confidence dot. The tooltip shows on hover and on keyboard focus; the legend above the list passes `legend` to show a plain dot. */
export function LowConfidenceDot({ legend = false }: { legend?: boolean }) {
  return legend ? <span className="inbox-low" aria-hidden>●</span> : <span className="inbox-low" role="img" tabIndex={0} aria-label="Low confidence" data-tip={LOW_TIP}>●</span>;
}

/** One queue row. The tick box and the title button are the controls; clicking anywhere else on the row also opens it. */
export function InboxRow({ review, cells, twoLine, opened, focused, checked, actionsDisabled, onOpen, onFocusRow, onToggleChecked, onDecide }: {
  review: InboxReview; cells: RowCells; twoLine: boolean; opened: boolean; focused: boolean; checked: boolean; actionsDisabled: boolean;
  onOpen: (id: string) => void; onFocusRow: (id: string) => void; onToggleChecked: (id: string, range?: boolean) => void; onDecide: (id: string, outcome: Outcome) => void;
}) {
  const id = review.frontmatter.id;
  const sub = [cells.owner, cells.due && `Due ${cells.due}`, cells.project, cells.client, cells.product].filter(Boolean) as string[];
  /** Shift+click ticks a range instead of opening (text selection is switched off for it). */
  const click = (event: React.MouseEvent) => { event.stopPropagation(); if (event.shiftKey) onToggleChecked(id, true); else onOpen(id); };
  return <div data-review-id={id} className={`inbox-row${opened ? " selected" : ""}${focused ? " focused" : ""}${checked ? " checked" : ""}`} onClick={click} onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}>
    <input className="c-check" type="checkbox" aria-label={`Select proposal: ${review.frontmatter.title}`} title="Select for bulk actions (X)" checked={checked} onClick={(event) => { event.stopPropagation(); onFocusRow(id); onToggleChecked(id, event.shiftKey); }} onChange={() => undefined} />
    <span className="c-kind"><span className={`inbox-badge ${kindClass(cells.kind)}`}>{cells.kind}</span></span>
    <span className="c-dot">{cells.low && <LowConfidenceDot />}</span>
    <div className="c-title">
      <button className="inbox-row-open" aria-label={`Open proposal: ${review.frontmatter.title}`} aria-pressed={opened} onFocus={() => onFocusRow(id)} onClick={click}><strong>{review.frontmatter.title}</strong><LockBadge frontmatter={review.frontmatter} /></button>
      {twoLine && <span className="inbox-row-sub">{sub.length ? sub.map((part) => <span key={part}>{part}</span>) : <span>No owner, due date, project, client or product</span>}</span>}
    </div>
    {!twoLine && <>
      <span className="c-owner" title={cells.owner}>{cells.owner ?? "—"}</span>
      <span className="c-due">{cells.due ?? "—"}</span>
      <span className="c-project" title={cells.project}>{cells.project ?? "—"}</span>
      <span className="c-client" title={cells.client}>{cells.client ?? "—"}</span>
      <span className="c-product" title={cells.product}>{cells.product ?? "—"}</span>
    </>}
    {/* Own reserved column, so the buttons never cover the title or other cells. Clicks here must not open or tick the row. */}
    <span className="c-actions" role="group" aria-label={`Actions: ${review.frontmatter.title}`} onClick={(event) => event.stopPropagation()}>
      <button className="inbox-row-action accept" aria-label={`Accept proposal: ${review.frontmatter.title}`} title={needsChoice(review) ? "Link and merge proposals need a choice: open it to decide" : "Accept (A)"} disabled={actionsDisabled || needsChoice(review)} onClick={() => onDecide(id, "accepted")}>✓</button>
      <button className="inbox-row-action reject" aria-label={`Reject proposal: ${review.frontmatter.title}`} title="Reject (R)" disabled={actionsDisabled} onClick={() => onDecide(id, "rejected")}>✕</button>
      <button className="inbox-row-action open" aria-label={`Open in reading pane: ${review.frontmatter.title}`} title="Open (Enter)" onClick={() => onOpen(id)}>↗</button>
    </span>
  </div>;
}
