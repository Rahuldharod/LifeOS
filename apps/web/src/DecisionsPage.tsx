// Decisions workspace (#41): a filtered list beside a detail panel. The detail edits a decision with a
// guarded save, supersedes it with a linked successor, and shows where it came from (meeting, sources,
// evidence). Open Points (#42, OpenPointsPage.tsx) mirror this page with their own lifecycle actions.
import React, { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { decisionQuery, noDecisionFilters, type DecisionFilterState } from "./decisionFilters.js";
import { EnvelopeBadges } from "./EnvelopeBadges.js";
import { SearchSelect } from "./SearchSelect.js";
import { zonedDateTime, zonedInputValue } from "./zonedTime.js";

type LifeObject = { frontmatter: Record<string, unknown> & { id: string; type: string; title: string; revision: number }; body: string; relativePath: string; contentHash: string };
type Evidence = { field: string; sourceId: string; sourceTitle?: string; fragmentId: string; text?: string; locator?: unknown };
type DecisionDetail = { decision: LifeObject; supersedes?: LifeObject; supersededBy?: LifeObject; meeting?: LifeObject; sources: LifeObject[]; people: LifeObject[]; project?: LifeObject; client?: LifeObject; product?: LifeObject; review?: LifeObject; evidence: Evidence[]; resolvesOpenPoints?: LifeObject[] };
type Props = {
  projects: LifeObject[]; clients: LifeObject[]; products: LifeObject[]; people: LifeObject[];
  busy: boolean; readOnly: boolean; timeZone: string; highlightId?: string;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onOpen: (id: string) => void; onChanged: () => Promise<void>; formatDate: (value: unknown) => string;
};

const statusLabels: Record<string, string> = { active: "Active", superseded: "Superseded", reversed: "Reversed" };
const statusLabel = (value: unknown) => statusLabels[String(value)] ?? String(value);
const options = (objects: LifeObject[]) => objects.map((object) => ({ id: object.frontmatter.id, title: object.frontmatter.title }));
const text = (value: unknown) => typeof value === "string" ? value : "";
const locatorText = (locator: unknown) => locator && typeof locator === "object" ? Object.entries(locator).map(([key, value]) => `${key} ${String(value)}`).join(", ") : "";

export function DecisionsPage({ projects, clients, products, people, busy, readOnly, timeZone, highlightId, run, onOpen, onChanged, formatDate }: Props) {
  const [filters, setFilters] = useState<DecisionFilterState>(noDecisionFilters);
  const [decisions, setDecisions] = useState<LifeObject[]>([]);
  const [listError, setListError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<DecisionDetail>();
  const [newTitle, setNewTitle] = useState("");
  const query = decisionQuery(filters, timeZone);
  const titleOf = (id: unknown, list: LifeObject[]) => list.find((object) => object.frontmatter.id === id)?.frontmatter.title;

  const loadList = useCallback(async () => {
    try { setDecisions(await api<LifeObject[]>(`/api/v1/decisions${query ? `?${query}` : ""}`)); setListError(undefined); }
    catch (error) { setListError(error instanceof Error ? error.message : "Could not load decisions"); }
  }, [query]);
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api<DecisionDetail>(`/api/v1/decisions/${id}`)); }
    catch { setDetail(undefined); setSelectedId(undefined); }
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setDetail(undefined); }, [selectedId, loadDetail]);
  useEffect(() => { if (highlightId) setSelectedId(highlightId); }, [highlightId]);

  /** After any write, or a failed one (a 409 means someone else saved first), show what is on disk now. */
  const refresh = async (id = selectedId) => { await loadList(); if (id) await loadDetail(id); await onChanged(); };
  const setFilter = (key: keyof DecisionFilterState, value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const filtered = Object.values(filters).some(Boolean);

  const create = () => run(async () => {
    // A decision recorded while filtering by a project, client, product or person starts linked to it.
    const fields = { title: newTitle, primary_project_id: filters.projectId, primary_client_id: filters.clientId, primary_product_id: filters.productId, people_ids: filters.personId ? [filters.personId] : undefined };
    const created = await api<LifeObject>("/api/v1/decisions", { method: "POST", body: JSON.stringify({ fields }) });
    setNewTitle("");
    setSelectedId(created.frontmatter.id);
    await refresh(created.frontmatter.id);
  }, "Decision recorded");

  return <>
    <header><p className="eyebrow">DECISIONS</p><h2>Decisions</h2><p className="lede">What was decided, why, and what replaced it. Superseding keeps the old decision and links the two.</p></header>
    <article className="crud-panel">
      <span>RECORD A DECISION</span>
      <div className="capture-row"><input aria-label="New decision title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && newTitle.trim()) void create(); }} placeholder="What was decided?" /><button className="primary" disabled={busy || readOnly || !newTitle.trim()} onClick={() => void create()}>Record</button></div>
    </article>
    <article className="decision-filters" aria-label="Filter decisions">
      <span>FILTERS</span>
      <div className="decision-filter-grid">
        <SearchSelect label="Project" options={options(projects)} value={filters.projectId} onChange={(value) => setFilter("projectId", value)} placeholder="Any project" />
        <SearchSelect label="Client" options={options(clients)} value={filters.clientId} onChange={(value) => setFilter("clientId", value)} placeholder="Any client" />
        <SearchSelect label="Product" options={options(products)} value={filters.productId} onChange={(value) => setFilter("productId", value)} placeholder="Any product" />
        <SearchSelect label="Person" options={options(people)} value={filters.personId} onChange={(value) => setFilter("personId", value)} placeholder="Anyone" />
        <label><small>Status</small><select value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">Any status</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><small>Decided from</small><input type="date" value={filters.fromDay} max={filters.toDay || undefined} onChange={(event) => setFilter("fromDay", event.target.value)} /></label>
        <label><small>Decided to</small><input type="date" value={filters.toDay} min={filters.fromDay || undefined} onChange={(event) => setFilter("toDay", event.target.value)} /></label>
        <button disabled={!filtered} onClick={() => setFilters(noDecisionFilters)}>Clear filters</button>
      </div>
    </article>
    <div className="decisions-layout">
      <article className="decision-list">
        <span>{decisions.length} {decisions.length === 1 ? "DECISION" : "DECISIONS"}</span>
        {listError && <p className="muted" role="alert">{listError}</p>}
        {!decisions.length && !listError && <p className="muted">{filtered ? "No decisions match these filters." : "No decisions yet. Record one above, or accept one from a meeting in the Inbox."}</p>}
        <ul>{decisions.map((decision) => {
          const value = decision.frontmatter;
          const context = [titleOf(value.primary_project_id, projects), titleOf(value.primary_client_id, clients), titleOf(value.primary_product_id, products)].filter(Boolean).join(" · ");
          return <li key={value.id}><button className={value.id === selectedId ? "decision-row selected" : "decision-row"} aria-current={value.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(value.id)}>
            <b>{value.title}</b>
            <small><span className={`status-label status-${String(value.status)}`}>{statusLabel(value.status)}</span> · {formatDate(value.decided_at)}{context ? ` · ${context}` : ""}</small>
          </button></li>;
        })}</ul>
      </article>
      {detail ? <DecisionPanel key={`${detail.decision.frontmatter.id}:${detail.decision.contentHash}`} detail={detail} projects={projects} clients={clients} products={products} people={people} busy={busy} readOnly={readOnly} timeZone={timeZone} run={run} onOpen={onOpen} onSelect={setSelectedId} refresh={refresh} formatDate={formatDate} />
        : <article className="empty-state"><h3>No decision selected</h3><p>Pick a decision to see its source, meeting and evidence, edit it, or supersede it.</p></article>}
    </div>
  </>;
}

function DecisionPanel({ detail, projects, clients, products, people, busy, readOnly, timeZone, run, onOpen, onSelect, refresh, formatDate }: Omit<Props, "highlightId" | "onChanged"> & { detail: DecisionDetail; onSelect: (id: string) => void; refresh: (id?: string) => Promise<void> }) {
  const { decision } = detail;
  const value = decision.frontmatter;
  const originalDecidedAt = text(value.decided_at) ? zonedInputValue(text(value.decided_at), timeZone) : "";
  const [draft, setDraft] = useState({ title: value.title, decision_text: text(value.decision_text), rationale: text(value.rationale), decidedAt: originalDecidedAt, status: text(value.status), primary_project_id: text(value.primary_project_id), primary_client_id: text(value.primary_client_id), primary_product_id: text(value.primary_product_id), people_ids: Array.isArray(value.people_ids) ? value.people_ids.map(String) : [] });
  const [successor, setSuccessor] = useState<{ title: string; decision_text: string; rationale: string }>();
  const set = (key: keyof typeof draft, next: unknown) => setDraft((current) => ({ ...current, [key]: next }));
  const active = value.status === "active";
  const locked = busy || readOnly;

  const save = async () => {
    const { decidedAt, ...fields } = draft;
    const changes: Record<string, unknown> = { ...fields, ...(decidedAt && decidedAt !== originalDecidedAt ? { decided_at: zonedDateTime(decidedAt.slice(0, 10), decidedAt.slice(11, 16), timeZone).toISOString() } : {}) };
    if (changes.status === value.status) delete changes.status;
    if (changes.status === "reversed" && !window.confirm("Mark this decision reversed? This is final.")) return;
    // On a conflict `run` shows the error and the refresh loads what is on disk now, so nothing is overwritten blindly.
    await run(async () => { await api(`/api/v1/decisions/${value.id}`, { method: "PATCH", body: JSON.stringify({ fields: changes, expectedHash: decision.contentHash }) }); }, "Decision saved");
    await refresh(value.id);
  };

  const supersede = async () => {
    if (!successor) return;
    let nextId: string | undefined;
    const done = await run(async () => {
      const result = await api<{ decision: LifeObject }>(`/api/v1/decisions/${value.id}/supersede`, { method: "POST", body: JSON.stringify({ fields: successor, expectedHash: decision.contentHash }) });
      nextId = result.decision.frontmatter.id;
    }, "Decision superseded");
    if (done && nextId) { setSuccessor(undefined); onSelect(nextId); await refresh(nextId); } else await refresh(value.id);
  };

  const link = (object: LifeObject | undefined, fallback = "None") => object ? <button className="link-button" onClick={() => onOpen(object.frontmatter.id)}>{object.frontmatter.title}</button> : <span className="muted">{fallback}</span>;

  return <article className="decision-detail" aria-label={`Decision: ${value.title}`}>
    <span>DECISION · <span className={`status-label status-${String(value.status)}`}>{statusLabel(value.status)}</span></span>
    {detail.supersededBy && <p className="decision-chain" role="note">Superseded by <button className="link-button" onClick={() => onSelect(detail.supersededBy!.frontmatter.id)}>{detail.supersededBy.frontmatter.title}</button></p>}
    {detail.resolvesOpenPoints?.map((point) => <p className="decision-chain" key={point.frontmatter.id}>Resolves open point <button className="link-button" onClick={() => onOpen(point.frontmatter.id)}>{point.frontmatter.title}</button></p>)}
    {detail.supersedes && <p className="decision-chain">Supersedes <button className="link-button" onClick={() => onSelect(detail.supersedes!.frontmatter.id)}>{detail.supersedes.frontmatter.title}</button></p>}
    <div className="crud-fields decision-fields">
      <label className="wide"><small>Title</small><input value={draft.title} disabled={locked} onChange={(event) => set("title", event.target.value)} /></label>
      <label className="wide"><small>Decision</small><textarea rows={3} value={draft.decision_text} disabled={locked} onChange={(event) => set("decision_text", event.target.value)} /></label>
      <label className="wide"><small>Rationale</small><textarea rows={2} value={draft.rationale} disabled={locked} onChange={(event) => set("rationale", event.target.value)} /></label>
      <label><small>Decided at</small><input type="datetime-local" value={draft.decidedAt} disabled={locked} onChange={(event) => set("decidedAt", event.target.value)} /></label>
      <label><small>Status</small>{active
        ? <select value={draft.status} disabled={locked} onChange={(event) => set("status", event.target.value)}><option value="active">Active</option><option value="reversed">Reversed (final)</option></select>
        : <b>{statusLabel(value.status)} (final)</b>}</label>
      <SearchSelect label="Project" options={options(projects)} value={draft.primary_project_id} disabled={locked} onChange={(next) => set("primary_project_id", next)} />
      <SearchSelect label="Client" options={options(clients)} value={draft.primary_client_id} disabled={locked} onChange={(next) => set("primary_client_id", next)} />
      <SearchSelect label="Product" options={options(products)} value={draft.primary_product_id} disabled={locked} onChange={(next) => set("primary_product_id", next)} />
      <SearchSelect multi label="People" options={options(people)} value={draft.people_ids} disabled={locked} onChange={(next) => set("people_ids", next)} />
    </div>
    <div className="crud-actions">
      <EnvelopeBadges frontmatter={value} /><small>Revision {value.revision} · {formatDate(value.updated_at)}</small>
      <button disabled={locked || !draft.title.trim() || !draft.decision_text.trim()} onClick={() => void save()}>Save changes</button>
      <button disabled={locked || !active || Boolean(successor)} title={active ? undefined : "Only active decisions can be superseded"} onClick={() => setSuccessor({ title: "", decision_text: "", rationale: "" })}>Supersede…</button>
    </div>
    {successor && <div className="decision-successor" role="group" aria-label="New decision that supersedes this one">
      <small>NEW DECISION · keeps this one's project, client, product and people</small>
      <input aria-label="New decision title" autoFocus placeholder="Title of the new decision" value={successor.title} onChange={(event) => setSuccessor({ ...successor, title: event.target.value })} />
      <textarea aria-label="New decision text" rows={2} placeholder="What is decided now (defaults to the title)" value={successor.decision_text} onChange={(event) => setSuccessor({ ...successor, decision_text: event.target.value })} />
      <textarea aria-label="Why it changed" rows={2} placeholder="Why it changed" value={successor.rationale} onChange={(event) => setSuccessor({ ...successor, rationale: event.target.value })} />
      <div className="crud-actions"><button onClick={() => setSuccessor(undefined)}>Cancel</button><button className="primary" disabled={locked || !successor.title.trim()} onClick={() => void supersede()}>Supersede</button></div>
    </div>}
    <div className="decision-links">
      <div><small>SOURCE MEETING</small>{link(detail.meeting, "Not from a meeting")}{detail.meeting && <small> · {formatDate(detail.meeting.frontmatter.starts_at)}</small>}</div>
      <div><small>SOURCES</small>{detail.sources.length ? <ul>{detail.sources.map((source) => <li key={source.frontmatter.id}>{source.frontmatter.title}<small> · {String(source.frontmatter.source_type ?? source.frontmatter.type)}</small></li>)}</ul> : <span className="muted">None linked</span>}</div>
      <div><small>EVIDENCE</small>{detail.evidence.length ? <ul>{detail.evidence.map((item) => <li key={`${item.field}:${item.sourceId}:${item.fragmentId}`}>{item.text ? <q>{item.text}</q> : <span className="muted">Fragment {item.fragmentId} not found</span>}<small> · {item.sourceTitle ?? "Missing source"}{locatorText(item.locator) ? `, ${locatorText(item.locator)}` : ""} · supports {item.field.replace(/_/g, " ")}</small></li>)}</ul> : <span className="muted">{detail.review ? "The proposal carried no field evidence" : "Recorded by hand: no evidence attached"}</span>}</div>
      <div><small>PEOPLE</small>{detail.people.length ? <span className="decision-people">{detail.people.map((person) => <React.Fragment key={person.frontmatter.id}>{link(person)}</React.Fragment>)}</span> : <span className="muted">None linked</span>}</div>
    </div>
  </article>;
}
