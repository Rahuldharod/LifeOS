import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LifeObject, ObjectLink, PersonLabel, ReviewEdits, ReviewEvidence } from "@lifeos/contracts";
import { LockBadge } from "./EnvelopeBadges.js";
import { LinkResolutionCard, type LinkCardActions } from "./LinkResolutionCard.js";
import { WorkspaceFilterBar } from "./WorkspacePatterns.js";
import { addCalendarDays, dateInTimeZone, zonedMidnight } from "./zonedTime.js";
import { useSplitPane } from "./splitPane.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";
import "./InboxWorkspace.css";

export type ReviewChoices = Record<"people" | "projects" | "clients" | "products", Array<{ id: string; title: string }>>;
export type InboxReview = LifeObject & { evidence?: Record<string, ReviewEvidence[]> };
type Outcome = "accepted" | "rejected";
type ActionResult = boolean | void;
type CreatedPeriod = "" | "today" | "7d" | "30d";
type ProposalCategory = "Tasks" | "Decisions" | "Open points" | "Updates";
const proposalCategories: ProposalCategory[] = ["Tasks", "Decisions", "Open points", "Updates"];

const editableByTarget: Record<string, string[]> = {
  task: ["owner_person_id", "due_on", "priority", "primary_project_id", "primary_client_id", "primary_product_id"],
  decision: ["primary_project_id", "primary_client_id", "primary_product_id"],
  "open-point": ["owner_person_id", "primary_project_id", "primary_client_id", "primary_product_id"]
};
const text = (value: unknown) => typeof value === "string" ? value : "";
const reviewType = (review: InboxReview) => text(review.frontmatter.review_type) || "create";
const proposalLabel = (review: InboxReview) => reviewType(review) === "create" ? `Create ${text(review.frontmatter.target_object_type) || "item"}` : reviewType(review).replaceAll("-", " ");
const proposalCategory = (review: InboxReview): ProposalCategory => {
  if (reviewType(review) !== "create") return "Updates";
  if (review.frontmatter.target_object_type === "task") return "Tasks";
  if (review.frontmatter.target_object_type === "decision") return "Decisions";
  if (review.frontmatter.target_object_type === "open-point") return "Open points";
  return "Updates";
};

const createdWindow = (period: CreatedPeriod, now: Date, timeZone: string) => {
  if (!period) return undefined;
  const today = dateInTimeZone(now, timeZone);
  const startDay = period === "today" ? today : addCalendarDays(today, -(period === "7d" ? 6 : 29));
  return { from: zonedMidnight(startDay, timeZone).getTime(), to: zonedMidnight(addCalendarDays(today, 1), timeZone).getTime() };
};

export function InboxWorkspace({ reviews, objects, labels, choices, selectedId, loading = false, error, busy, readOnly, displayTimeZone, now = new Date(), onOpen, onBack, onAccept, onReject, onSave, linkActionsFor }: {
  reviews: InboxReview[]; objects: Array<LifeObject | ObjectLink>; labels: Map<string, PersonLabel>; choices: ReviewChoices;
  selectedId?: string; loading?: boolean; error?: string; busy: boolean; readOnly: boolean; displayTimeZone: string; now?: Date;
  onOpen?: (id: string, options?: { replace?: boolean }) => void; onBack?: () => void;
  onAccept: (review: InboxReview) => Promise<ActionResult>; onReject: (review: InboxReview) => Promise<ActionResult>; onSave: (review: InboxReview, edits: ReviewEdits) => Promise<ActionResult>;
  linkActionsFor?: (reviewId: string) => LinkCardActions;
}) {
  const narrow = useNarrowWorkspace();
  const [openedId, setOpenedId] = useState<string | undefined>(() => selectedId ?? (narrow ? undefined : reviews[0]?.frontmatter.id));
  const split = useSplitPane("inbox");
  const [query, setQuery] = useState(""); const [type, setType] = useState(""); const [advanced, setAdvanced] = useState(false);
  const [meetingId, setMeetingId] = useState(""); const [period, setPeriod] = useState<CreatedPeriod>("");
  const [deciding, setDeciding] = useState<InboxReview>(); const [notification, setNotification] = useState(""); const [actionError, setActionError] = useState("");
  const [activeId, setActiveId] = useState<string>(); const active = useRef(new Set<string>()); const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const openedRef = useRef(openedId); openedRef.current = openedId;
  useEffect(() => { if (selectedId !== undefined) setOpenedId(selectedId); }, [selectedId]);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const objectById = useMemo(() => new Map(objects.map((object) => [String(object.frontmatter.id), object])), [objects]);
  const meetings = useMemo(() => objects.filter((object) => object.frontmatter.type === "meeting"), [objects]);
  const window = createdWindow(period, now, displayTimeZone);
  const visible = reviews.filter((review) => {
    const search = `${review.frontmatter.title} ${review.body} ${reviewType(review)} ${review.frontmatter.target_object_type ?? ""}`.toLowerCase();
    if (query.trim() && !search.includes(query.trim().toLowerCase())) return false;
    if (type && proposalCategory(review) !== type) return false;
    if (meetingId && review.frontmatter.source_meeting_id !== meetingId) return false;
    const createdAt = Date.parse(String(review.frontmatter.created_at));
    if (window && (createdAt < window.from || createdAt >= window.to)) return false;
    return true;
  }).sort((a, b) => String(b.frontmatter.created_at).localeCompare(String(a.frontmatter.created_at)));

  useEffect(() => {
    if (narrow || openedId || !visible.length) return;
    setOpenedId(visible[0]!.frontmatter.id);
  }, [narrow, openedId, visible]);

  // While a decision saves, the refresh drops the item from `reviews`; keep showing it until the Inbox moves on (no "Select a proposal" flash).
  const selected = reviews.find((review) => review.frontmatter.id === openedId) ?? (deciding?.frontmatter.id === openedId ? deciding : undefined);
  const open = (id: string, options?: { replace?: boolean }) => { setOpenedId(id); setActionError(""); onOpen?.(id, options); };
  const back = () => { setOpenedId(undefined); setActionError(""); onBack?.(); };
  const clearFilters = () => { setQuery(""); setType(""); setMeetingId(""); setPeriod(""); };
  const notify = (message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotification(message); noticeTimer.current = setTimeout(() => setNotification(""), 3000);
  };
  const visibleIds = visible.map((review) => review.frontmatter.id);
  /** PB-035: the item below in the list, or the one above when the decided item was the bottom one. */
  const nextAfter = (id: string) => {
    const index = visibleIds.indexOf(id);
    if (index < 0) return visibleIds[0];
    return visibleIds[index + 1] ?? visibleIds[index - 1];
  };
  /** PB-035: once a decision is recorded, open the next waiting item; after the last one, show the empty list state. */
  const advanceFrom = (id: string, nextId: string | undefined) => {
    if (openedRef.current !== undefined && openedRef.current !== id) return; // the user already moved on while the decision was saving
    if (nextId) { open(nextId, { replace: true }); return; }
    setOpenedId(undefined); setActionError("");
  };
  const decide = async (review: InboxReview, outcome: Outcome, action: () => Promise<ActionResult>) => {
    const id = review.frontmatter.id;
    if (active.current.has(id) || busy || readOnly) return;
    const nextId = nextAfter(id);
    active.current.add(id); setActiveId(id); setActionError(""); setDeciding(review);
    try {
      const result = await action();
      if (result === false) return;
      notify(`Proposal ${outcome}`);
      advanceFrom(id, nextId);
    } catch (caught) { setActionError(caught instanceof Error ? caught.message : "Something went wrong"); }
    finally { active.current.delete(id); setActiveId((current) => current === id ? undefined : current); setDeciding((current) => current?.frontmatter.id === id ? undefined : current); }
  };
  /** Link-resolution cards run their own requests; once one finishes, the Inbox moves on the same way. */
  const linkFinished = (review: InboxReview, nextId: string | undefined, outcome: Outcome) => { notify(`Proposal ${outcome}`); advanceFrom(review.frontmatter.id, nextId); };
  const position = selected ? visibleIds.indexOf(selected.frontmatter.id) : -1;
  const previousId = position > 0 ? visibleIds[position - 1] : undefined;
  const followingId = position >= 0 ? visibleIds[position + 1] : undefined;
  const step = useRef<(direction: -1 | 1) => boolean>(() => false);
  step.current = (direction) => { const target = direction < 0 ? previousId : followingId; if (target) open(target); return Boolean(target); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']")) return;
      if (step.current(event.key === "ArrowUp" ? -1 : 1)) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const itemBusy = Boolean(busy || (selected && activeId === selected.frontmatter.id));

  const ref = useListDetailReturn(selected?.frontmatter.id);
  return <div ref={ref} className={`inbox-workspace pane-workspace${selected ? " detail-open" : ""}`} data-workspace="inbox" style={split.style}>
    {notification && <div className="inbox-toast" role="status">{notification}</div>}
    <section className="inbox-queue" data-pane="list" aria-label="Review queue" hidden={narrow && Boolean(selected)}>
      <header className="workspace-heading"><div><span>INBOX · {visible.length}</span><h2>Review proposals</h2><p className="muted">Nothing becomes a commitment until you accept it.</p></div></header>
      <WorkspaceFilterBar advanced={advanced} onToggleAdvanced={() => setAdvanced(!advanced)}>
        <input type="search" aria-label="Search proposals" placeholder="Search proposals…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="Filter by proposal type" value={type} onChange={(event) => setType(event.target.value)}><option value="">All proposal types</option>{proposalCategories.map((value) => <option value={value} key={value}>{value}</option>)}</select>
      </WorkspaceFilterBar>
      {advanced && <div className="inbox-advanced-filters">
        <label>Source meeting<select aria-label="Filter by source meeting" value={meetingId} onChange={(event) => setMeetingId(event.target.value)}><option value="">Any meeting</option>{meetings.map((meeting) => <option value={meeting.frontmatter.id} key={meeting.frontmatter.id}>{meeting.frontmatter.title}</option>)}</select></label>
        <label>Created<select aria-label="Filter by created period" value={period} onChange={(event) => setPeriod(event.target.value as CreatedPeriod)}><option value="">Any time</option><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
        <button onClick={() => { setMeetingId(""); setPeriod(""); }}>Clear advanced filters</button>
      </div>}
      {loading ? <div className="inbox-state" aria-busy="true">Loading review queue…</div> : error ? <div className="inbox-state failure" role="alert">{error}</div> : visible.length === 0 ? <div className="inbox-state"><h3>{reviews.length ? "No matching proposals" : "Inbox clear"}</h3>{reviews.length ? <><p>{reviews.length === 1 ? "1 proposal is hidden by the filters." : `${reviews.length} proposals are hidden by the filters.`}</p><button onClick={clearFilters}>Clear filters</button></> : <p>No proposals require your attention.</p>}</div> : <div className="inbox-rows">{visible.map((review) => <button className={openedId === review.frontmatter.id ? "inbox-row selected" : "inbox-row"} aria-label={`Open proposal: ${review.frontmatter.title}`} aria-pressed={openedId === review.frontmatter.id} key={review.frontmatter.id} onClick={() => open(review.frontmatter.id)}><span><strong>{review.frontmatter.title}</strong><small>{proposalLabel(review)} · {dateInTimeZone(new Date(review.frontmatter.created_at), displayTimeZone)}</small></span><LockBadge frontmatter={review.frontmatter} /></button>)}</div>}
    </section>
    {!narrow && <div {...split.dividerProps} />}
    <section className="inbox-detail" data-pane="detail" aria-label="Review detail" hidden={narrow && !selected}>
      {!selected ? <div className="inbox-state"><h3>Select a proposal</h3><p>Choose a row to review its source, evidence and proposed change.</p></div> : <>
        <header className="inbox-record-header"><button className="narrow-back" aria-label="Back to review queue" onClick={back}>Back</button><div><span>{proposalLabel(selected)}</span><h2 data-detail-heading tabIndex={-1}>{selected.frontmatter.title}</h2><div className="inbox-record-meta"><LockBadge frontmatter={selected.frontmatter} /><small>{String(selected.frontmatter.confidence_label ?? "Unrated")} confidence</small></div></div>
          <nav className="inbox-step" aria-label="Move between proposals">{position >= 0 && <small>{position + 1} of {visibleIds.length}</small>}<button aria-label="Previous proposal" title="Previous proposal (↑)" disabled={!previousId} onClick={() => step.current(-1)}>↑ Previous</button><button aria-label="Next proposal" title="Next proposal (↓)" disabled={!followingId} onClick={() => step.current(1)}>↓ Next</button></nav></header>
        {readOnly && <p className="inbox-read-only">Read-only on this Mac. Click “Use LifeOS here” before accepting, editing or rejecting proposals.</p>}
        {actionError && <p className="review-error" role="alert">{actionError}</p>}
        <ReviewDetail key={`${selected.frontmatter.id}:${selected.contentHash}`} review={selected} objectById={objectById} labels={labels} choices={choices} busy={itemBusy || readOnly} onAccept={() => decide(selected, "accepted", () => onAccept(selected))} onReject={() => decide(selected, "rejected", () => onReject(selected))} onSave={async (edits) => {
          if (active.current.has(selected.frontmatter.id) || busy || readOnly) return;
          active.current.add(selected.frontmatter.id); setActiveId(selected.frontmatter.id); setActionError("");
          try { const result = await onSave(selected, edits); if (result !== false) notify("Proposal updated"); }
          catch (caught) { setActionError(caught instanceof Error ? caught.message : "Something went wrong"); }
          finally { active.current.delete(selected.frontmatter.id); setActiveId(undefined); }
        }} linkActions={linkActionsFor?.(selected.frontmatter.id)} onLinkCompletion={(outcome, nextId) => linkFinished(selected, nextId, outcome)} nextId={nextAfter(selected.frontmatter.id)} />
      </>}
    </section>
  </div>;
}

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

function ReviewDetail({ review, objectById, labels, choices, busy, nextId, onAccept, onReject, onSave, linkActions, onLinkCompletion }: {
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
    return <div className="inbox-review-flow"><SourceAndEvidence review={review} objectById={objectById} /><section className="inbox-detail-section"><h3>Decision</h3><LinkResolutionCard review={review} labels={labels} busy={busy} actions={wrapped} /></section></div>;
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
    <footer className="inbox-decision-actions"><button disabled={busy || !Object.keys(edits).length} onClick={() => onSave(edits)}>Save edits</button><button className="primary" disabled={busy || Object.keys(edits).length > 0} title={Object.keys(edits).length ? "Save your edits first" : undefined} onClick={onAccept}>{type === "summary" ? "Accept summary" : type === "update" ? "Apply change" : type === "person-merge" ? "Merge" : `Accept ${target}`}</button><button className="danger" disabled={busy} onClick={onReject}>{type === "person-merge" ? "Keep separate" : "Reject"}</button></footer>
  </div>;
}
