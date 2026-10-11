// Open Points workspace (#42): mirrors the Decisions page. A filtered list beside a detail panel that edits
// an open point with a guarded save and moves it through its lifecycle: resolve with a summary or an
// existing decision, resolve with a new decision (created and linked in one step), or close.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { HistoryLink } from "./HistoryPanel.js";
import { CopyLink } from "./CopyLink.js";
import { decisionQuery, noDecisionFilters, type DecisionFilterState } from "./decisionFilters.js";
import { EnvelopeBadges, LockBadge } from "./EnvelopeBadges.js";
import { SearchSelect } from "./SearchSelect.js";
import { entityOptions } from "./searchOptions.js";
import { SensitivityToggle } from "./SensitivityToggle.js";
import { createStructuredEditorGuard, ListDetailWorkspace, StickyRecordActions, useStructuredEditorGuard, WorkspaceFilterBar, type StructuredEditorGuard } from "./WorkspacePatterns.js";
import "./DecisionsWorkspace.css";

import type { LifeObject, OpenPointDetail } from "@lifeos/contracts";
type Props = {
  projects: LifeObject[]; clients: LifeObject[]; products: LifeObject[]; people: LifeObject[];
  busy: boolean; readOnly: boolean; timeZone: string; highlightId?: string;
  guard?: StructuredEditorGuard;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onOpen: (id: string) => void; onChanged: () => Promise<void>; formatDate: (value: unknown) => string;
};
/** Which lifecycle form is open in the detail panel. */
type Action = { kind: "resolve"; summary: string; decisionId: string } | { kind: "decide"; title: string; decision_text: string; rationale: string } | { kind: "close"; reason: string };

const statusLabels: Record<string, string> = { open: "Open", resolved: "Resolved", closed: "Closed" };
const statusLabel = (value: unknown) => statusLabels[String(value)] ?? String(value);
const text = (value: unknown) => typeof value === "string" ? value : "";
const locatorText = (locator: unknown) => locator && typeof locator === "object" ? Object.entries(locator).map(([key, value]) => `${key} ${String(value)}`).join(", ") : "";

export function OpenPointsPage({ projects, clients, products, people, busy, readOnly, timeZone, highlightId, guard, run, onOpen, onChanged, formatDate }: Props) {
  const [filters, setFilters] = useState<DecisionFilterState>(noDecisionFilters);
  const [points, setPoints] = useState<LifeObject[]>([]);
  const [listError, setListError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<OpenPointDetail>();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const fallbackGuard = useRef(createStructuredEditorGuard()).current;
  const editorGuard = guard ?? fallbackGuard;
  // Same filter state and query as Decisions; on open points the dates apply to when the point was raised.
  const query = decisionQuery(filters, timeZone);
  const titleOf = (id: unknown, list: LifeObject[]) => list.find((object) => object.frontmatter.id === id)?.frontmatter.title;

  const loadList = useCallback(async () => {
    try { setPoints(await api("GET /api/v1/open-points", { query: new URLSearchParams(query) })); setListError(undefined); }
    catch (error) { setListError(error instanceof Error ? error.message : "Could not load open points"); }
  }, [query]);
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api("GET /api/v1/open-points/:id", { params: { id } })); }
    catch { setDetail(undefined); setSelectedId(undefined); }
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setDetail(undefined); }, [selectedId, loadDetail]);
  useEffect(() => { if (highlightId) { setCreating(false); setSelectedId(highlightId); } }, [highlightId]);

  /** After any write, or a failed one (a 409 means someone else saved first), show what is on disk now. */
  const refresh = async (id = selectedId) => { await loadList(); if (id) await loadDetail(id); await onChanged(); };
  const setFilter = (key: keyof DecisionFilterState, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const filtered = Object.values(filters).some(Boolean);

  const create = (fields: Record<string, unknown>) => run(async () => {
    // An open point raised while filtering by a project, client, product or person starts linked to it.
    const linked = { ...fields };
    if (!linked.primary_project_id && filters.projectId) linked.primary_project_id = filters.projectId;
    if (!linked.primary_client_id && filters.clientId) linked.primary_client_id = filters.clientId;
    if (!linked.primary_product_id && filters.productId) linked.primary_product_id = filters.productId;
    if ((!Array.isArray(linked.people_ids) || !linked.people_ids.length) && filters.personId) linked.people_ids = [filters.personId];
    const created = await api("POST /api/v1/open-points", { body: { fields: linked } });
    setCreating(false);
    setSelectedId(created.frontmatter.id);
    await refresh(created.frontmatter.id);
  }, "Open point recorded");
  const visible = points.filter((point) => `${point.frontmatter.title} ${point.frontmatter.resolution_summary ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));

  const detailOpen = Boolean(creating || selectedId);
  const leaveThen = async (action: () => void) => { if (await editorGuard.saveNow()) action(); };
  const closeDetail = () => void leaveThen(() => { setCreating(false); setSelectedId(undefined); });
  return <ListDetailWorkspace workspace="openPoints" detailOpen={detailOpen} selectedKey={creating ? "new" : selectedId} listLabel="Open points list" detailLabel="Open point detail" list={<>
      <header className="workspace-heading"><div><span>OPEN POINTS · {visible.length}</span><h2>Open points</h2><p className="muted">Questions still waiting for an answer.</p></div><button className="primary" disabled={busy || readOnly} onClick={() => void leaveThen(() => { setSelectedId(undefined); setCreating(true); })}>New Open Point</button></header>
      <WorkspaceFilterBar advanced={advanced} onToggleAdvanced={() => setAdvanced(!advanced)}><input type="search" aria-label="Search open points" placeholder="Search open points…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Filter open points by status" value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">Any status</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></WorkspaceFilterBar>
      {advanced && <div className="task-advanced-filters decision-advanced-filters" aria-label="Advanced open point filters">
        <SearchSelect label="Project" options={entityOptions(projects)} value={filters.projectId} onChange={(value) => setFilter("projectId", value)} placeholder="Any project" />
        <SearchSelect label="Client" options={entityOptions(clients)} value={filters.clientId} onChange={(value) => setFilter("clientId", value)} placeholder="Any client" />
        <SearchSelect label="Product" options={entityOptions(products)} value={filters.productId} onChange={(value) => setFilter("productId", value)} placeholder="Any product" />
        <SearchSelect label="Person" options={entityOptions(people)} value={filters.personId} onChange={(value) => setFilter("personId", value)} placeholder="Anyone" />
        <label><small>Raised from</small><input type="date" value={filters.fromDay} max={filters.toDay || undefined} onChange={(event) => setFilter("fromDay", event.target.value)} /></label>
        <label><small>Raised to</small><input type="date" value={filters.toDay} min={filters.fromDay || undefined} onChange={(event) => setFilter("toDay", event.target.value)} /></label>
        <button disabled={!filtered} onClick={() => setFilters(noDecisionFilters)}>Clear filters</button>
      </div>}
      <article className="decision-list">
        {listError && <p className="muted" role="alert">{listError}</p>}
        {!visible.length && !listError && <p className="muted">{filtered || search ? "No open points match these filters." : "No open points yet. Create one, or accept one from a meeting in the Inbox."}</p>}
        <ul>{visible.map((point) => {
          const value = point.frontmatter;
          const context = [titleOf(value.primary_project_id, projects), titleOf(value.primary_client_id, clients), titleOf(value.primary_product_id, products)].filter(Boolean).join(" · ");
          return <li key={value.id}><button aria-label={`Open open point: ${value.title}`} className={value.id === selectedId ? "decision-row selected" : "decision-row"} aria-current={value.id === selectedId ? "true" : undefined} onClick={() => void leaveThen(() => { setCreating(false); setSelectedId(value.id); })}>
            <b>{value.title}<LockBadge frontmatter={value} /></b>
            <small><span className={`status-label status-${String(value.status)}`}>{statusLabel(value.status)}</span> · {formatDate(value.raised_at ?? value.created_at)}{context ? ` · ${context}` : ""}</small>
          </button></li>;
        })}</ul>
      </article>
    </>} detail={<>
      <button className="narrow-back" onClick={closeDetail}>Back to open points</button>
      {creating ? <NewOpenPointPanel guard={editorGuard} projects={projects} clients={clients} products={products} people={people} busy={busy} readOnly={readOnly} onCancel={() => setCreating(false)} onCreate={create} />
        : detail ? <OpenPointPanel guard={editorGuard} detail={detail} projects={projects} clients={clients} products={products} people={people} busy={busy} readOnly={readOnly} timeZone={timeZone} run={run} onOpen={onOpen} refresh={refresh} formatDate={formatDate} />
        : <article className="empty-state"><h3>No open point selected</h3><p>Pick an open point to see its source, meeting and evidence, edit it, resolve it or close it.</p></article>}
    </>} />;
}

function NewOpenPointPanel({ guard, projects, clients, products, people, busy, readOnly, onCancel, onCreate }: Pick<Props, "projects" | "clients" | "products" | "people" | "busy" | "readOnly"> & { guard: StructuredEditorGuard; onCancel: () => void; onCreate: (fields: Record<string, unknown>) => Promise<boolean> }) {
  const empty = { title: "", importance: "", owner_person_id: "", due_on: "", primary_project_id: "", primary_client_id: "", primary_product_id: "", people_ids: [] as string[], sensitivity: "normal" };
  const [draft, setDraft] = useState(empty); const [failed, setFailed] = useState(false);
  const set = (key: keyof typeof draft, value: string | string[]) => { setDraft((current) => ({ ...current, [key]: value })); setFailed(false); };
  const dirty = JSON.stringify(draft) !== JSON.stringify(empty); const locked = busy || readOnly;
  const save = async () => { if (locked || !draft.title.trim()) return false; const ok = await onCreate(draft); setFailed(!ok); return ok; };
  const navigation = useStructuredEditorGuard({ guard, dirty, canSave: !locked && Boolean(draft.title.trim()), save, discard: () => { setDraft(empty); setFailed(false); }, noun: "open point" });
  return <article className="decision-detail" aria-label="New open point">
    <span>NEW OPEN POINT</span>
    <div className="crud-fields decision-fields">
      <label className="wide"><small>Question</small><input aria-label="Open point title" autoFocus value={draft.title} disabled={locked} onChange={(event) => set("title", event.target.value)} /></label>
      <label><small>Importance</small><select value={draft.importance} disabled={locked} onChange={(event) => set("importance", event.target.value)}><option value="">None</option><option>High</option><option>Medium</option><option>Low</option></select></label>
      <label><small>Due</small><input type="date" value={draft.due_on} disabled={locked} onChange={(event) => set("due_on", event.target.value)} /></label>
      <SearchSelect label="Owner" options={entityOptions(people)} value={draft.owner_person_id} disabled={locked} onChange={(next) => set("owner_person_id", next)} />
      <SearchSelect label="Project" options={entityOptions(projects)} value={draft.primary_project_id} disabled={locked} onChange={(next) => set("primary_project_id", next)} />
      <SearchSelect label="Client" options={entityOptions(clients)} value={draft.primary_client_id} disabled={locked} onChange={(next) => set("primary_client_id", next)} />
      <SearchSelect label="Product" options={entityOptions(products)} value={draft.primary_product_id} disabled={locked} onChange={(next) => set("primary_product_id", next)} />
      <SearchSelect multi label="People" options={entityOptions(people)} value={draft.people_ids} disabled={locked} onChange={(next) => set("people_ids", next)} />
      <label><small>Sensitivity</small><select aria-label="Open point sensitivity" value={draft.sensitivity} disabled={locked} onChange={(event) => set("sensitivity", event.target.value)}><option value="normal">Normal</option><option value="restricted">Restricted</option></select></label>
    </div>
    {failed && <p role="alert" className="field-error">Could not save. Your changes are still here; review them and try again.</p>}
    <StickyRecordActions status={dirty ? "Unsaved changes" : "Not saved yet"} busy={busy} saveDisabled={locked || !draft.title.trim()} onCancel={() => void navigation.leaveThen(onCancel)} onSave={() => void save()} />
    {navigation.dialog}
  </article>;
}

function OpenPointPanel({ guard, detail, projects, clients, products, people, busy, readOnly, run, onOpen, refresh, formatDate }: Omit<Props, "highlightId" | "onChanged" | "guard"> & { guard: StructuredEditorGuard; detail: OpenPointDetail; refresh: (id?: string) => Promise<void> }) {
  const { openPoint } = detail;
  const value = openPoint.frontmatter;
  const baseline = useMemo(() => ({ title: value.title, importance: text(value.importance), owner_person_id: text(value.owner_person_id), due_on: text(value.due_on), resolution_summary: text(value.resolution_summary), close_reason: text(value.close_reason), primary_project_id: text(value.primary_project_id), primary_client_id: text(value.primary_client_id), primary_product_id: text(value.primary_product_id), people_ids: Array.isArray(value.people_ids) ? value.people_ids.map(String) : [] }), [value.close_reason, value.due_on, value.importance, value.owner_person_id, value.people_ids, value.primary_client_id, value.primary_product_id, value.primary_project_id, value.resolution_summary, value.title]);
  const [draft, setDraft] = useState(baseline);
  const [saveStatus, setSaveStatus] = useState("");
  const previousId = useRef(value.id);
  const [action, setAction] = useState<Action>();
  const [decisions, setDecisions] = useState<LifeObject[]>([]);
  const set = (key: keyof typeof draft, next: unknown) => { setSaveStatus("Unsaved changes"); setDraft((current) => ({ ...current, [key]: next })); };
  const isOpen = value.status === "open";
  const locked = busy || readOnly;
  const writable = useRef(!locked); writable.current = !locked;
  useEffect(() => {
    setDraft(baseline);
    if (previousId.current !== value.id) setSaveStatus("");
    previousId.current = value.id;
  }, [baseline, value.id]);
  // Decisions to link are loaded only when the user starts resolving.
  useEffect(() => { if (action?.kind === "resolve" && !decisions.length) void api("GET /api/v1/decisions").then(setDecisions).catch(() => setDecisions([])); }, [action?.kind, decisions.length]);

  /** One expected-hash write; failures keep the structured draft visible for retry. */
  const write = async (endpoint: "PATCH /api/v1/open-points/:id" | `POST /api/v1/open-points/:id/${"resolve" | "resolve-with-decision" | "close"}`, fields: Record<string, unknown>, success: string) => {
    if (!writable.current) return false;
    const done = await run(async () => { await api(endpoint, { params: { id: value.id }, body: { fields, expectedHash: openPoint.contentHash } }); }, success);
    if (done) { setAction(undefined); await refresh(value.id); }
    return done;
  };
  const save = async () => {
    const { resolution_summary, close_reason, ...fields } = draft;
    // The outcome wording is only sent for the status that owns it.
    const done = await write("PATCH /api/v1/open-points/:id", { ...fields, ...(value.status === "resolved" ? { resolution_summary } : {}), ...(value.status === "closed" ? { close_reason } : {}) }, "Open point saved");
    if (done) setSaveStatus("Saved");
    return done;
  };
  const submitAction = async () => {
    if (!action) return true;
    if (action.kind === "resolve") return write("POST /api/v1/open-points/:id/resolve", { resolution_summary: action.summary, resolution_decision_id: action.decisionId }, "Open point resolved");
    if (action.kind === "decide") return write("POST /api/v1/open-points/:id/resolve-with-decision", { title: action.title, decision_text: action.decision_text, rationale: action.rationale }, "Decision recorded and open point resolved");
    if (!window.confirm("Close this open point? This is final.")) return false;
    return write("POST /api/v1/open-points/:id/close", { reason: action.reason }, "Open point closed");
  };
  const actionReady = action?.kind === "resolve" ? Boolean(action.summary.trim() || action.decisionId) : action?.kind === "decide" ? Boolean(action.title.trim()) : Boolean(action);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || Boolean(action);
  const canSave = !locked && (action ? actionReady : Boolean(draft.title.trim() && (value.status !== "resolved" || draft.resolution_summary.trim() || value.resolution_decision_id)));
  const navigation = useStructuredEditorGuard({ guard, dirty, canSave, save: action ? submitAction : save, discard: () => { setDraft(baseline); setAction(undefined); }, noun: "open point" });

  const link = (object: LifeObject | undefined, fallback = "None") => object ? <button className="link-button" onClick={() => onOpen(object.frontmatter.id)}>{object.frontmatter.title}</button> : <span className="muted">{fallback}</span>;

  return <article className="decision-detail" aria-label={`Open point: ${value.title}`}>
    <span>OPEN POINT · <span className={`status-label status-${String(value.status)}`}>{statusLabel(value.status)}</span></span>
    <details className="decision-more"><summary>More</summary><div><CopyLink object={openPoint} /><HistoryLink objectId={value.id} title={value.title} disabled={busy || readOnly} run={run} onRestored={() => refresh(value.id)} />{isOpen && <button className="danger" disabled={locked || Boolean(action)} onClick={() => void navigation.leaveThen(() => { if (writable.current) setAction({ kind: "close", reason: "" }); })}>Close…</button>}</div></details>
    {value.status === "resolved" && <p className="decision-chain" role="note">Resolved {formatDate(value.resolved_at)}{detail.resolutionDecision ? <> by decision {link(detail.resolutionDecision)}</> : value.resolution_decision_id ? <span className="muted"> by a decision that is missing</span> : null}</p>}
    {value.status === "closed" && <p className="decision-chain" role="note">Closed {formatDate(value.closed_at)}{value.close_reason ? `: ${String(value.close_reason)}` : " (no reason given)"}</p>}
    <div className="crud-fields decision-fields">
      <label className="wide"><small>Question</small><input aria-label="Open point title" value={draft.title} disabled={locked} onChange={(event) => set("title", event.target.value)} /></label>
      {value.status === "resolved" && <label className="wide"><small>Resolution summary</small><textarea rows={2} value={draft.resolution_summary} disabled={locked} onChange={(event) => set("resolution_summary", event.target.value)} /></label>}
      {value.status === "closed" && <label className="wide"><small>Reason for closing</small><input value={draft.close_reason} disabled={locked} onChange={(event) => set("close_reason", event.target.value)} /></label>}
      <label><small>Importance</small><select value={draft.importance} disabled={locked} onChange={(event) => set("importance", event.target.value)}><option value="">None</option><option>High</option><option>Medium</option><option>Low</option></select></label>
      <label><small>Due</small><input type="date" value={draft.due_on} disabled={locked} onChange={(event) => set("due_on", event.target.value)} /></label>
      <SearchSelect label="Owner" options={entityOptions(people)} value={draft.owner_person_id} disabled={locked} onChange={(next) => set("owner_person_id", next)} />
      <SearchSelect label="Project" options={entityOptions(projects)} value={draft.primary_project_id} disabled={locked} onChange={(next) => set("primary_project_id", next)} />
      <SearchSelect label="Client" options={entityOptions(clients)} value={draft.primary_client_id} disabled={locked} onChange={(next) => set("primary_client_id", next)} />
      <SearchSelect label="Product" options={entityOptions(products)} value={draft.primary_product_id} disabled={locked} onChange={(next) => set("primary_product_id", next)} />
      <SearchSelect multi label="People" options={entityOptions(people)} value={draft.people_ids} disabled={locked} onChange={(next) => set("people_ids", next)} />
    </div>
    <SensitivityToggle object={openPoint} noun="open point" disabled={locked} run={run} onChanged={() => refresh(value.id)} />
    <div className="crud-actions">
      <EnvelopeBadges frontmatter={value} lock={false} /><small>Revision {value.revision} · {formatDate(value.updated_at)}</small><small role="status">{saveStatus}</small>
      <button disabled={locked || !draft.title.trim() || (value.status === "resolved" && !draft.resolution_summary.trim() && !value.resolution_decision_id)} onClick={() => void save()}>Save changes</button>
      {isOpen && <>
        <button disabled={locked || Boolean(action)} onClick={() => void navigation.leaveThen(() => { if (writable.current) setAction({ kind: "resolve", summary: "", decisionId: "" }); })}>Resolve…</button>
        <button disabled={locked || Boolean(action)} onClick={() => void navigation.leaveThen(() => { if (writable.current) setAction({ kind: "decide", title: value.title, decision_text: "", rationale: "" }); })}>Resolve with decision…</button>
      </>}
    </div>
    {action && <div className="decision-successor" role="group" aria-label={action.kind === "close" ? "Close this open point" : "Resolve this open point"}>
      {action.kind === "resolve" && <>
        <small>RESOLVE · give a summary, link an existing decision, or both</small>
        <textarea aria-label="Resolution summary" autoFocus rows={2} placeholder="What was the answer?" value={action.summary} onChange={(event) => setAction({ ...action, summary: event.target.value })} />
        <SearchSelect label="Decision" options={entityOptions(decisions)} value={action.decisionId} onChange={(next) => setAction({ ...action, decisionId: next })} placeholder="No decision" />
      </>}
      {action.kind === "decide" && <>
        <small>NEW DECISION · keeps this open point's project, client, product and people</small>
        <input aria-label="New decision title" autoFocus placeholder="Title of the decision" value={action.title} onChange={(event) => setAction({ ...action, title: event.target.value })} />
        <textarea aria-label="New decision text" rows={2} placeholder="What is decided (defaults to the title)" value={action.decision_text} onChange={(event) => setAction({ ...action, decision_text: event.target.value })} />
        <textarea aria-label="Rationale" rows={2} placeholder="Why" value={action.rationale} onChange={(event) => setAction({ ...action, rationale: event.target.value })} />
      </>}
      {action.kind === "close" && <>
        <small>CLOSE · the question no longer matters (final)</small>
        <input aria-label="Reason for closing" autoFocus placeholder="Reason (optional)" value={action.reason} onChange={(event) => setAction({ ...action, reason: event.target.value })} />
      </>}
      <div className="crud-actions"><button onClick={() => void navigation.leaveThen(() => setAction(undefined))}>Cancel</button><button className="primary" disabled={locked || !actionReady} onClick={() => void submitAction()}>{action.kind === "close" ? "Close" : "Resolve"}</button></div>
    </div>}
    <div className="decision-links">
      <div><small>SOURCE MEETING</small>{link(detail.meeting, "Not from a meeting")}{detail.meeting && <small> · {formatDate(detail.meeting.frontmatter.starts_at)}</small>}</div>
      <div><small>SOURCES</small>{detail.sources.length ? <ul>{detail.sources.map((source) => <li key={source.frontmatter.id}>{source.frontmatter.title}<small> · {String(source.frontmatter.source_type ?? source.frontmatter.type)}</small></li>)}</ul> : <span className="muted">None linked</span>}</div>
      <div><small>EVIDENCE</small>{detail.evidence.length ? <ul>{detail.evidence.map((item) => <li key={`${item.field}:${item.sourceId}:${item.fragmentId}`}>{item.text ? <q>{item.text}</q> : <span className="muted">Fragment {item.fragmentId} not found</span>}<small> · {item.sourceTitle ?? "Missing source"}{locatorText(item.locator) ? `, ${locatorText(item.locator)}` : ""} · supports {item.field.replace(/_/g, " ")}</small></li>)}</ul> : <span className="muted">{detail.review ? "The proposal carried no field evidence" : "Recorded by hand: no evidence attached"}</span>}</div>
      <div><small>PEOPLE</small>{detail.people.length ? <span className="decision-people">{detail.people.map((person) => <React.Fragment key={person.frontmatter.id}>{link(person)}</React.Fragment>)}</span> : <span className="muted">None linked</span>}</div>
    </div>
    {navigation.dialog}
  </article>;
}
