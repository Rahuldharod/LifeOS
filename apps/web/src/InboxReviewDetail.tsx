import React, { useState } from "react";
import type { LifeObject, ObjectLink, PersonLabel, ReviewEdits, ReviewEvidence } from "@lifeos/contracts";
import { LinkResolutionCard, type LinkCardActions } from "./LinkResolutionCard.js";
import { editableByTarget, reviewType, text, type InboxReview, type Outcome, type ReviewChoices } from "./inboxModel.js";

function SourceAndEvidence({ review, objectById }: { review: InboxReview; objectById: Map<string, LifeObject | ObjectLink> }) {
  const meeting = objectById.get(text(review.frontmatter.source_meeting_id));
  const sourceIds = Array.isArray(review.frontmatter.source_ids) ? review.frontmatter.source_ids.filter((id): id is string => typeof id === "string") : [];
  const evidence = Object.values(review.evidence ?? {}).flat();
  return <div className="inbox-evidence-rail" role="group" aria-label="Source and evidence">
    <section className="inbox-detail-section"><h3>Source</h3>{meeting ? <p><strong>Meeting:</strong> {meeting.frontmatter.title}</p> : review.frontmatter.source_meeting_id ? <p className="unresolved">Meeting unavailable: {String(review.frontmatter.source_meeting_id)}</p> : <p className="muted">No source meeting recorded.</p>}{sourceIds.length > 0 && <ul>{sourceIds.map((id) => <li key={id}>{objectById.get(id)?.frontmatter.title ?? `Unavailable source: ${id}`}</li>)}</ul>}</section>
    <section className="inbox-detail-section"><h3>Evidence</h3>{evidence.length ? <ul className="review-evidence">{evidence.map((entry, index) => <Evidence key={`${entry.field}-${index}`} entry={entry} />)}</ul> : <p className="muted">No field evidence recorded.</p>}</section>
  </div>;
}

function Evidence({ entry }: { entry: ReviewEvidence }) {
  return <li><em>{entry.field}</em> {entry.resolved ? <span>{entry.source_title}</span> : <span className="unresolved">Unresolved source: {entry.source_ref ?? entry.source_id}</span>}{entry.locator ? ` · ${entry.locator}` : ""}{entry.quote ? <q>{entry.quote}</q> : null}</li>;
}

export function ReviewDetail({ review, objectById, labels, choices, busy, nextId, onAccept, onReject, onSave, linkActions, onLinkCompletion }: {
  review: InboxReview; objectById: Map<string, LifeObject | ObjectLink>; labels: Map<string, PersonLabel>; choices: ReviewChoices; busy: boolean; nextId?: string;
  onAccept: () => void; onReject: () => void; onSave: (edits: ReviewEdits) => void; linkActions?: LinkCardActions; onLinkCompletion: (outcome: Outcome, nextId: string | undefined) => void;
}) {
  const proposed = (review.frontmatter.proposed_fields ?? {}) as Record<string, unknown>; const target = text(review.frontmatter.target_object_type) || "item";
  const editable = reviewType(review) === "create" ? editableByTarget[target] ?? [] : [];
  const current = (key: string) => text(key.startsWith("primary_") ? review.frontmatter[key] : proposed[key]);
  const [title, setTitle] = useState(review.frontmatter.title);
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((key) => [key, current(key)])));
  const edits: ReviewEdits = Object.fromEntries([...(title.trim() !== review.frontmatter.title.trim() ? [["title", title]] : []), ...editable.filter((key) => fields[key] !== current(key)).map((key) => [key, fields[key] || null])]);
  const select = (key: string, label: string, options: Array<{ id: string; title: string }>) => <label key={key}>{label}<select value={fields[key] ?? ""} disabled={busy} onChange={(event) => setFields({ ...fields, [key]: event.target.value })}><option value="">{key === "owner_person_id" ? "Me" : "None"}</option>{options.map((option) => <option value={option.id} key={option.id}>{option.title}</option>)}</select></label>;
  const type = reviewType(review);

  if (type === "link-resolution" && linkActions) {
    const wrapped: LinkCardActions = { onCreate: linkActions.onCreate, onLink: async (id) => { await linkActions.onLink(id); onLinkCompletion("accepted", nextId); }, onReject: async () => { await linkActions.onReject(); onLinkCompletion("rejected", nextId); } };
    return <div className="inbox-review-flow"><SourceAndEvidence review={review} objectById={objectById} /><section className="inbox-detail-section"><h3>Decision</h3><LinkResolutionCard review={review} labels={labels} busy={busy} actions={wrapped} rejectShortcut="r" /></section></div>;
  }
  const changes = proposed.changes as Array<{ field: string; current: unknown; proposed: unknown }> | undefined;
  return <div className="inbox-review-flow">
    <SourceAndEvidence review={review} objectById={objectById} />
    <section className="inbox-detail-section"><h3>{type === "update" ? "Proposed changes" : "Proposed item"}</h3>
      {type === "summary" ? <><div className="inbox-proposal-copy">{text(proposed.summary)}</div><p className="muted">To change the wording, accept it, then edit the Summary section in the meeting note.</p></> : type === "update" ? <table className="review-changes"><thead><tr><th>Field</th><th>Current</th><th>Proposed</th></tr></thead><tbody>{(changes ?? []).map((change) => <tr key={change.field}><td>{change.field}</td><td>{String(change.current ?? "(none)")}</td><td>{String(change.proposed ?? "(none)")}</td></tr>)}{proposed.append_note ? <tr><td>note</td><td>(none)</td><td>{String(proposed.append_note)}</td></tr> : null}</tbody></table> : type === "person-merge" ? <p className="inbox-proposal-copy">{review.body.replace(/^# .*\n+/, "").trim()}</p> : <>
        <label>Title<input aria-label="Proposed title" value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
        {editable.length > 0 && <div className="review-fields">{editable.includes("owner_person_id") && select("owner_person_id", "Owner", choices.people)}{editable.includes("due_on") && <label>Due<input type="date" value={fields.due_on ?? ""} disabled={busy} onChange={(event) => setFields({ ...fields, due_on: event.target.value })} /></label>}{editable.includes("priority") && select("priority", "Priority", ["High", "Medium", "Low"].map((value) => ({ id: value, title: value })))}{editable.includes("primary_project_id") && select("primary_project_id", "Project", choices.projects)}{editable.includes("primary_client_id") && select("primary_client_id", "Client", choices.clients)}{editable.includes("primary_product_id") && select("primary_product_id", "Product", choices.products)}</div>}
      </>}
      {review.body.replace(/^# .*\n+/, "").trim() && !["summary", "person-merge"].includes(type) && <p className="inbox-proposal-copy">{review.body.replace(/^# .*\n+/, "").trim()}</p>}
    </section>
    <footer className="inbox-decision-actions"><button data-shortcut="s" aria-keyshortcuts="S" disabled={busy || !Object.keys(edits).length} onClick={() => onSave(edits)}>Save edits</button><button className="primary" data-shortcut="a" aria-keyshortcuts="A" data-unsaved={Object.keys(edits).length > 0 ? "true" : undefined} disabled={busy || Object.keys(edits).length > 0} title={Object.keys(edits).length ? "Save your edits first" : undefined} onClick={onAccept}>{type === "summary" ? "Accept summary" : type === "update" ? "Apply change" : type === "person-merge" ? "Merge" : `Accept ${target}`}</button><button className="danger" data-shortcut="r" aria-keyshortcuts="R" disabled={busy} onClick={onReject}>{type === "person-merge" ? "Keep separate" : "Reject"}</button></footer>
  </div>;
}
