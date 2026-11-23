import React, { type Ref } from "react";
import type { LifeObject, ObjectLink, PersonLabel, ReviewEdits } from "@lifeos/contracts";
import { LockBadge } from "./EnvelopeBadges.js";
import type { LinkCardActions } from "./LinkResolutionCard.js";
import { ReviewDetail } from "./InboxReviewDetail.js";
import { proposalLabel, type InboxReview, type Outcome, type ReviewChoices } from "./inboxModel.js";

/** The reading pane: record header, previous/next, banners, and the proposal with its evidence and decision buttons. */
export function InboxReadingPane({ paneRef, selected, hidden, position, total, previousId, followingId, readOnly, actionError, objectById, labels, choices, itemBusy, nextId, linkActions,
  onBack, onStep, onAccept, onReject, onSave, onLinkCompletion }: {
  paneRef: Ref<HTMLElement>; selected?: InboxReview; hidden: boolean; position: number; total: number; previousId?: string; followingId?: string; readOnly: boolean; actionError: string;
  objectById: Map<string, LifeObject | ObjectLink>; labels: Map<string, PersonLabel>; choices: ReviewChoices; itemBusy: boolean; nextId?: string; linkActions?: LinkCardActions;
  onBack: () => void; onStep: (direction: -1 | 1) => void; onAccept: () => void; onReject: () => void; onSave: (edits: ReviewEdits) => void; onLinkCompletion: (outcome: Outcome, nextId: string | undefined) => void;
}) {
  return <section ref={paneRef} className="inbox-detail" data-pane="detail" aria-label="Review detail" hidden={hidden}>
    {!selected ? <div className="inbox-state"><h3>Select a proposal</h3><p>Choose a row to review its source, evidence and proposed change.</p></div> : <>
      <header className="inbox-record-header"><button className="narrow-back" aria-label="Back to review queue" onClick={onBack}>Back</button><div><span>{proposalLabel(selected)}</span><h2 data-detail-heading tabIndex={-1}>{selected.frontmatter.title}</h2><div className="inbox-record-meta"><LockBadge frontmatter={selected.frontmatter} /><small>{String(selected.frontmatter.confidence_label ?? "Unrated")} confidence</small></div></div>
        <nav className="inbox-step" aria-label="Move between proposals">{position >= 0 && <small>{position + 1} of {total}</small>}<button aria-label="Previous proposal" title="Previous proposal" disabled={!previousId} onClick={() => onStep(-1)}>↑ Previous</button><button aria-label="Next proposal" title="Next proposal" disabled={!followingId} onClick={() => onStep(1)}>↓ Next</button></nav></header>
      {readOnly && <p className="inbox-read-only">Read-only on this Mac. Click “Use LifeOS here” before accepting, editing or rejecting proposals.</p>}
      {actionError && <p className="review-error" role="alert">{actionError}</p>}
      <ReviewDetail key={`${selected.frontmatter.id}:${selected.contentHash}`} review={selected} objectById={objectById} labels={labels} choices={choices} busy={itemBusy || readOnly} onAccept={onAccept} onReject={onReject} onSave={onSave} linkActions={linkActions} onLinkCompletion={onLinkCompletion} nextId={nextId} />
    </>}
  </section>;
}
