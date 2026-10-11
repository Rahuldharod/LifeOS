// Decisions workspace (#41): a filtered list beside a detail panel. The detail edits a decision with a
// guarded save, supersedes it with a linked successor, and shows where it came from (meeting, sources,
// evidence). Open Points (#42, OpenPointsPage.tsx) mirror this page with their own lifecycle actions.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { HistoryLink } from "./HistoryPanel.js";
import { CopyLink } from "./CopyLink.js";
import { decisionQuery, noDecisionFilters, type DecisionFilterState } from "./decisionFilters.js";
import { EnvelopeBadges, LockBadge } from "./EnvelopeBadges.js";
import { SearchSelect } from "./SearchSelect.js";
import { entityOptions } from "./searchOptions.js";
import { SensitivityToggle } from "./SensitivityToggle.js";
import { createStructuredEditorGuard, ListDetailWorkspace, StickyRecordActions, useStructuredEditorGuard, WorkspaceFilterBar, type StructuredEditorGuard } from "./WorkspacePatterns.js";
import { zonedDateTime, zonedInputValue } from "./zonedTime.js";
import "./DecisionsWorkspace.css";

import type { DecisionDetail, LifeObject } from "@lifeos/contracts";
type Props = {
  projects: LifeObject[]; clients: LifeObject[]; products: LifeObject[]; people: LifeObject[];
  busy: boolean; readOnly: boolean; timeZone: string; highlightId?: string;
  guard?: StructuredEditorGuard;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onOpen: (id: string) => void; onChanged: () => Promise<void>; formatDate: (value: unknown) => string;
};

const statusLabels: Record<string, string> = { active: "Active", superseded: "Superseded", reversed: "Reversed" };
const statusLabel = (value: unknown) => statusLabels[String(value)] ?? String(value);
const text = (value: unknown) => typeof value === "string" ? value : "";
const locatorText = (locator: unknown) => locator && typeof locator === "object" ? Object.entries(locator).map(([key, value]) => `${key} ${String(value)}`).join(", ") : "";

export function DecisionsPage({ projects, clients, products, people, busy, readOnly, timeZone, highlightId, guard, run, onOpen, onChanged, formatDate }: Props) {
  const [filters, setFilters] = useState<DecisionFilterState>(noDecisionFilters);
  const [decisions, setDecisions] = useState<LifeObject[]>([]);
  const [listError, setListError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<DecisionDetail>();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const fallbackGuard = useRef(createStructuredEditorGuard()).current;
  const editorGuard = guard ?? fallbackGuard;
  const query = decisionQuery(filters, timeZone);
  const titleOf = (id: unknown, list: LifeObject[]) => list.find((object) => object.frontmatter.id === id)?.frontmatter.title;

  const loadList = useCallback(async () => {
    try { setDecisions(await api("GET /api/v1/decisions", { query: new URLSearchParams(query) })); setListError(undefined); }
    catch (error) { setListError(error instanceof Error ? error.message : "Could not load decisions"); }
  }, [query]);
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api("GET /api/v1/decisions/:id", { params: { id } })); }
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
    // A decision recorded while filtering by a project, client, product or person starts linked to it.
    const linked = { ...fields };
    if (!linked.primary_project_id && filters.projectId) linked.primary_project_id = filters.projectId;
    if (!linked.primary_client_id && filters.clientId) linked.primary_client_id = filters.clientId;
    if (!linked.primary_product_id && filters.productId) linked.primary_product_id = filters.productId;
    if ((!Array.isArray(linked.people_ids) || !linked.people_ids.length) && filters.personId) linked.people_ids = [filters.personId];
    const created = await api("POST /api/v1/decisions", { body: { fields: linked } });
    setCreating(false);
    setSelectedId(created.frontmatter.id);
    await refresh(created.frontmatter.id);
  }, "Decision recorded");

  const visible = decisions.filter((decision) => `${decision.frontmatter.title} ${decision.frontmatter.decision_text ?? ""} ${decision.frontmatter.rationale ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));

  const detailOpen = Boolean(creating || selectedId);
  const leaveThen = async (action: () => void) => { if (await editorGuard.saveNow()) action(); };
  const closeDetail = () => void leaveThen(() => { setCreating(false); setSelectedId(undefined); });
  return <ListDetailWorkspace detailOpen={detailOpen} listLabel="Decisions list" detailLabel="Decision detail" list={<>
      <header className="workspace-heading"><div><span>DECISIONS · {visible.length}</span><h2>Decisions</h2><p className="muted">What was decided, why, and what replaced it.</p></div><button className="primary" disabled={busy || readOnly} onClick={() => void leaveThen(() => { setSelectedId(undefined); setCreating(true); })}>New Decision</button></header>
      <WorkspaceFilterBar advanced={advanced} onToggleAdvanced={() => setAdvanced(!advanced)}><input type="search" aria-label="Search decisions" placeholder="Search decisions…" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="Filter decisions by status" value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">Any status</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></WorkspaceFilterBar>
      {advanced && <div className="task-advanced-filters decision-advanced-filters" aria-label="Advanced decision filters">
        <SearchSelect label="Project" options={entityOptions(projects)} value={filters.projectId} onChange={(value) => setFilter("projectId", value)} placeholder="Any project" />
        <SearchSelect label="Client" options={entityOptions(clients)} value={filters.clientId} onChange={(value) => setFilter("clientId", value)} placeholder="Any client" />
        <SearchSelect label="Product" options={entityOptions(products)} value={filters.productId} onChange={(value) => setFilter("productId", value)} placeholder="Any product" />
        <SearchSelect label="Person" options={entityOptions(people)} value={filters.personId} onChange={(value) => setFilter("personId", value)} placeholder="Anyone" />
        <label><small>Decided from</small><input type="date" value={filters.fromDay} max={filters.toDay || undefined} onChange={(event) => setFilter("fromDay", event.target.value)} /></label>
        <label><small>Decided to</small><input type="date" value={filters.toDay} min={filters.fromDay || undefined} onChange={(event) => setFilter("toDay", event.target.value)} /></label>
        <button disabled={!filtered} onClick={() => setFilters(noDecisionFilters)}>Clear filters</button>
      </div>}
      <article className="decision-list">
        {listError && <p className="muted" role="alert">{listError}</p>}
        {!visible.length && !listError && <p className="muted">{filtered || search ? "No decisions match these filters." : "No decisions yet. Create one, or accept one from a meeting in the Inbox."}</p>}
        <ul>{visible.map((decision) => {
          const value = decision.frontmatter;
          const context = [titleOf(value.primary_project_id, projects), titleOf(value.primary_client_id, clients), titleOf(value.primary_product_id, products)].filter(Boolean).join(" · ");
          return <li key={value.id}><button aria-label={`Open decision: ${value.title}`} className={value.id === selectedId ? "decision-row selected" : "decision-row"} aria-current={value.id === selectedId ? "true" : undefined} onClick={() => void leaveThen(() => { setCreating(false); setSelectedId(value.id); })}>
            <b>{value.title}<LockBadge frontmatter={value} /></b>
            <small><span className={`status-label status-${String(value.status)}`}>{statusLabel(value.status)}</span> · {formatDate(value.decided_at)}{context ? ` · ${context}` : ""}</small>
          </button></li>;
        })}</ul>
      </article>
    </>} detail={<>
      <button className="narrow-back" onClick={closeDetail}>Back to decisions</button>
      {creating ? <NewDecisionPanel guard={editorGuard} projects={projects} clients={clients} products={products} people={people} busy={busy} readOnly={readOnly} timeZone={timeZone} onCancel={() => setCreating(false)} onCreate={create} />
        : detail ? <DecisionPanel key={`${detail.decision.frontmatter.id}:${detail.decision.contentHash}`} guard={editorGuard} detail={detail} projects={projects} clients={clients} products={products} people={people} busy={busy} readOnly={readOnly} timeZone={timeZone} run={run} onOpen={onOpen} onSelect={setSelectedId} refresh={refresh} formatDate={formatDate} />
        : <article className="empty-state"><h3>No decision selected</h3><p>Pick a decision to see its source, meeting and evidence, edit it, or supersede it.</p></article>}
    </>} />;
}

function NewDecisionPanel({ guard, projects, clients, products, people, busy, readOnly, timeZone, onCancel, onCreate }: Pick<Props, "projects" | "clients" | "products" | "people" | "busy" | "readOnly" | "timeZone"> & { guard: StructuredEditorGuard; onCancel: () => void; onCreate: (fields: Record<string, unknown>) => Promise<boolean> }) {
  const empty = { title: "", decision_text: "", rationale: "", decidedAt: "", primary_project_id: "", primary_client_id: "", primary_product_id: "", people_ids: [] as string[], sensitivity: "normal" };
  const [draft, setDraft] = useState(empty); const [failed, setFailed] = useState(false);
  const set = (key: keyof typeof draft, value: string | string[]) => { setDraft((current) => ({ ...current, [key]: value })); setFailed(false); };
  const dirty = JSON.stringify(draft) !== JSON.stringify(empty); const locked = busy || readOnly;
  const save = async () => {
    const { decidedAt, ...fields } = draft;
    const ok = await onCreate({ ...fields, ...(decidedAt ? { decided_at: zonedDateTime(decidedAt.slice(0, 10), decidedAt.slice(11, 16), timeZone).toISOString() } : {}) });
    setFailed(!ok);
    return ok;
  };
  const navigation = useStructuredEditorGuard({ guard, dirty, save, discard: () => { setDraft(empty); setFailed(false); }, noun: "decision" });
  return <article className="decision-detail" aria-label="New decision">
    <span>NEW DECISION</span>
    <div className="crud-fields decision-fields">
      <label className="wide"><small>Title</small><input aria-label="Decision title" autoFocus value={draft.title} disabled={locked} onChange={(event) => set("title", event.target.value)} /></label>
      <label className="wide"><small>Decision</small><textarea aria-label="Decision text" rows={3} value={draft.decision_text} disabled={locked} onChange={(event) => set("decision_text", event.target.value)} /></label>
      <label className="wide"><small>Rationale</small><textarea rows={2} value={draft.rationale} disabled={locked} onChange={(event) => set("rationale", event.target.value)} /></label>
      <label><small>Decided at</small><input type="datetime-local" value={draft.decidedAt} disabled={locked} onChange={(event) => set("decidedAt", event.target.value)} /></label>
      <SearchSelect label="Project" options={entityOptions(projects)} value={draft.primary_project_id} disabled={locked} onChange={(next) => set("primary_project_id", next)} />
      <SearchSelect label="Client" options={entityOptions(clients)} value={draft.primary_client_id} disabled={locked} onChange={(next) => set("primary_client_id", next)} />
      <SearchSelect label="Product" options={entityOptions(products)} value={draft.primary_product_id} disabled={locked} onChange={(next) => set("primary_product_id", next)} />
      <SearchSelect multi label="People" options={entityOptions(people)} value={draft.people_ids} disabled={locked} onChange={(next) => set("people_ids", next)} />
      <label><small>Sensitivity</small><select aria-label="Decision sensitivity" value={draft.sensitivity} disabled={locked} onChange={(event) => set("sensitivity", event.target.value)}><option value="normal">Normal</option><option value="restricted">Restricted</option></select></label>
    </div>
    {failed && <p role="alert" className="field-error">Could not save. Your changes are still here; review them and try again.</p>}
    <StickyRecordActions status={dirty ? "Unsaved changes" : "Not saved yet"} busy={busy} saveDisabled={locked || !draft.title.trim()} onCancel={() => void navigation.leaveThen(onCancel)} onSave={() => void save()} />
    {navigation.dialog}
  </article>;
}

function DecisionPanel({ guard, detail, projects, clients, products, people, busy, readOnly, timeZone, run, onOpen, onSelect, refresh, formatDate }: Omit<Props, "highlightId" | "onChanged" | "guard"> & { guard: StructuredEditorGuard; detail: DecisionDetail; onSelect: (id: string) => void; refresh: (id?: string) => Promise<void> }) {
  const { decision } = detail;
  const value = decision.frontmatter;
  const originalDecidedAt = text(value.decided_at) ? zonedInputValue(text(value.decided_at), timeZone) : "";
  const baseline = { title: value.title, decision_text: text(value.decision_text), rationale: text(value.rationale), decidedAt: originalDecidedAt, primary_project_id: text(value.primary_project_id), primary_client_id: text(value.primary_client_id), primary_product_id: text(value.primary_product_id), people_ids: Array.isArray(value.people_ids) ? value.people_ids.map(String) : [] };
  const [draft, setDraft] = useState(baseline);
  const [successor, setSuccessor] = useState<{ title: string; decision_text: string; rationale: string }>();
  const set = (key: keyof typeof draft, next: unknown) => setDraft((current) => ({ ...current, [key]: next }));
  const active = value.status === "active";
  const locked = busy || readOnly;

  const save = async () => {
    const { decidedAt, ...fields } = draft;
    const changes: Record<string, unknown> = { ...fields, ...(decidedAt && decidedAt !== originalDecidedAt ? { decided_at: zonedDateTime(decidedAt.slice(0, 10), decidedAt.slice(11, 16), timeZone).toISOString() } : {}) };
    // A failed write keeps this draft visible; the next successful refresh adopts the new disk hash.
    const done = await run(async () => { await api("PATCH /api/v1/decisions/:id", { params: { id: value.id }, body: { fields: changes, expectedHash: decision.contentHash } }); }, "Decision saved");
    if (done) await refresh(value.id);
    return done;
  };

  const supersede = async () => {
    if (!successor) return true;
    let nextId: string | undefined;
    const done = await run(async () => {
      const result = await api("POST /api/v1/decisions/:id/supersede", { params: { id: value.id }, body: { fields: successor, expectedHash: decision.contentHash } });
      nextId = result.decision.frontmatter.id;
    }, "Decision superseded");
    if (done && nextId) { setSuccessor(undefined); onSelect(nextId); await refresh(nextId); }
    return done;
  };
  const reverse = async () => {
    if (!window.confirm("Mark this decision reversed? This is final.")) return;
    await run(async () => { await api("PATCH /api/v1/decisions/:id", { params: { id: value.id }, body: { fields: { status: "reversed" }, expectedHash: decision.contentHash } }); }, "Decision reversed");
    await refresh(value.id);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || Boolean(successor);
  const navigation = useStructuredEditorGuard({ guard, dirty, save: successor ? supersede : save, discard: () => { setDraft(baseline); setSuccessor(undefined); }, noun: "decision" });

  const link = (object: LifeObject | undefined, fallback = "None") => object ? <button className="link-button" onClick={() => onOpen(object.frontmatter.id)}>{object.frontmatter.title}</button> : <span className="muted">{fallback}</span>;

  return <article className="decision-detail" aria-label={`Decision: ${value.title}`}>
    <span>DECISION · <span className={`status-label status-${String(value.status)}`}>{statusLabel(value.status)}</span></span>
    <details className="decision-more"><summary>More</summary><div><CopyLink object={decision} /><HistoryLink objectId={value.id} title={value.title} disabled={busy || readOnly} run={run} onRestored={() => refresh(value.id)} />{active && <button className="danger" disabled={locked} onClick={() => void navigation.leaveThen(reverse)}>Mark reversed…</button>}</div></details>
    {detail.supersededBy && <p className="decision-chain" role="note">Superseded by <button className="link-button" onClick={() => onSelect(detail.supersededBy!.frontmatter.id)}>{detail.supersededBy.frontmatter.title}</button></p>}
    {detail.resolvesOpenPoints?.map((point) => <p className="decision-chain" key={point.frontmatter.id}>Resolves open point <button className="link-button" onClick={() => onOpen(point.frontmatter.id)}>{point.frontmatter.title}</button></p>)}
    {detail.supersedes && <p className="decision-chain">Supersedes <button className="link-button" onClick={() => onSelect(detail.supersedes!.frontmatter.id)}>{detail.supersedes.frontmatter.title}</button></p>}
    <div className="crud-fields decision-fields">
      <label className="wide"><small>Title</small><input aria-label="Decision title" value={draft.title} disabled={locked} onChange={(event) => set("title", event.target.value)} /></label>
      <label className="wide"><small>Decision</small><textarea rows={3} value={draft.decision_text} disabled={locked} onChange={(event) => set("decision_text", event.target.value)} /></label>
      <label className="wide"><small>Rationale</small><textarea rows={2} value={draft.rationale} disabled={locked} onChange={(event) => set("rationale", event.target.value)} /></label>
      <label><small>Decided at</small><input type="datetime-local" value={draft.decidedAt} disabled={locked} onChange={(event) => set("decidedAt", event.target.value)} /></label>
      <label><small>Status</small><b>{statusLabel(value.status)}{active ? "" : " (final)"}</b></label>
      <SearchSelect label="Project" options={entityOptions(projects)} value={draft.primary_project_id} disabled={locked} onChange={(next) => set("primary_project_id", next)} />
      <SearchSelect label="Client" options={entityOptions(clients)} value={draft.primary_client_id} disabled={locked} onChange={(next) => set("primary_client_id", next)} />
      <SearchSelect label="Product" options={entityOptions(products)} value={draft.primary_product_id} disabled={locked} onChange={(next) => set("primary_product_id", next)} />
      <SearchSelect multi label="People" options={entityOptions(people)} value={draft.people_ids} disabled={locked} onChange={(next) => set("people_ids", next)} />
    </div>
    <SensitivityToggle object={decision} noun="decision" disabled={locked} run={run} onChanged={() => refresh(value.id)} />
    <div className="crud-actions">
      <EnvelopeBadges frontmatter={value} lock={false} /><small>Revision {value.revision} · {formatDate(value.updated_at)}</small>
      <button disabled={locked || !draft.title.trim() || !draft.decision_text.trim()} onClick={() => void save()}>Save changes</button>
      <button disabled={locked || !active || Boolean(successor)} title={active ? undefined : "Only active decisions can be superseded"} onClick={() => void navigation.leaveThen(() => setSuccessor({ title: "", decision_text: "", rationale: "" }))}>Supersede…</button>
    </div>
    {successor && <div className="decision-successor" role="group" aria-label="New decision that supersedes this one">
      <small>NEW DECISION · keeps this one's project, client, product and people</small>
      <input aria-label="New decision title" autoFocus placeholder="Title of the new decision" value={successor.title} onChange={(event) => setSuccessor({ ...successor, title: event.target.value })} />
      <textarea aria-label="New decision text" rows={2} placeholder="What is decided now (defaults to the title)" value={successor.decision_text} onChange={(event) => setSuccessor({ ...successor, decision_text: event.target.value })} />
      <textarea aria-label="Why it changed" rows={2} placeholder="Why it changed" value={successor.rationale} onChange={(event) => setSuccessor({ ...successor, rationale: event.target.value })} />
      <div className="crud-actions"><button onClick={() => void navigation.leaveThen(() => setSuccessor(undefined))}>Cancel</button><button className="primary" disabled={locked || !successor.title.trim()} onClick={() => void supersede()}>Supersede</button></div>
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
