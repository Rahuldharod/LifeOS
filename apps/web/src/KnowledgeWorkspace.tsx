import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LifeObject } from "@lifeos/contracts";
import { LockBadge } from "./EnvelopeBadges.js";
import { KnowledgeSourceForm, knowledgeSkillHelp } from "./KnowledgeSourceForm.js";
import { OverlayDialog } from "./OverlayDialog.js";
import { areaOptions } from "./envelope.js";
import { foldText } from "./searchOptions.js";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";
import "./KnowledgeWorkspace.css";

type Option = { id: string; title: string };
type Filters = { query: string; area: string; sourceType: string; fromDay: string; toDay: string; projectId: string; personId: string };
const emptyFilters: Filters = { query: "", area: "", sourceType: "", fromDay: "", toDay: "", projectId: "", personId: "" };

export type KnowledgeWorkspaceProps = {
  notes: LifeObject[];
  sources: LifeObject[];
  projects: Option[];
  people: Option[];
  selectedId?: string;
  loading: boolean;
  readOnly: boolean;
  error?: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  /** Resolves only after the existing Source API/application write and refresh have completed. */
  onPreserve: (title: string, text: string) => Promise<void>;
};

const values = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const label = (value: string) => value.replaceAll("-", " ").replace(/^./, (first) => first.toUpperCase());
const publishedDay = (note: LifeObject) => String(note.frontmatter.published_at ?? note.frontmatter.created_at).slice(0, 10);
const preview = (body: string) => body.replace(/[#>*_`[\]-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 130) || "Empty note";

function sourceTypes(note: LifeObject, sources: Map<string, LifeObject>) {
  return values(note.frontmatter.source_ids).map((id) => sources.get(id)?.frontmatter.source_type).filter((value): value is string => typeof value === "string");
}

function matches(note: LifeObject, filters: Filters, sources: Map<string, LifeObject>) {
  const query = foldText(filters.query.trim());
  if (query && !foldText(`${note.frontmatter.title}\n${note.body}`).includes(query)) return false;
  if (filters.area && note.frontmatter.area !== filters.area) return false;
  if (filters.sourceType && !sourceTypes(note, sources).includes(filters.sourceType)) return false;
  const day = publishedDay(note);
  if (filters.fromDay && day < filters.fromDay) return false;
  if (filters.toDay && day > filters.toDay) return false;
  if (filters.projectId && note.frontmatter.primary_project_id !== filters.projectId) return false;
  if (filters.personId && !values(note.frontmatter.people_ids).includes(filters.personId)) return false;
  return true;
}

function KnowledgeIntakePanel({ open, readOnly, onClose, onPreserve }: { open: boolean; readOnly: boolean; onClose: () => void; onPreserve: (title: string, text: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: "success" | "error"; text: string }>();

  async function preserve() {
    if (busy || readOnly || !title.trim() || !text.trim()) return;
    setBusy(true); setOutcome(undefined);
    try {
      await onPreserve(title.trim(), text.trim());
      setTitle(""); setText("");
      setOutcome({ kind: "success", text: "Source preserved in Markdown. It is safe to close this panel." });
    } catch (caught) {
      setOutcome({ kind: "error", text: caught instanceof Error ? caught.message : "Source could not be preserved" });
    } finally { setBusy(false); }
  }

  return <OverlayDialog open={open} label="Preserve Source" onClose={onClose}>
    <div className="knowledge-intake-heading"><div><span>KNOWLEDGE INTAKE</span><h2>Preserve Source</h2></div><button aria-label="Close Preserve Source" onClick={onClose}>Close</button></div>
    <KnowledgeSourceForm title={title} text={text} disabled={busy || readOnly} onTitleChange={(value) => { setTitle(value); setOutcome(undefined); }} onTextChange={(value) => { setText(value); setOutcome(undefined); }} onPreserve={() => void preserve()} />
    {outcome && <p className={`knowledge-intake-outcome ${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>{outcome.text}</p>}
  </OverlayDialog>;
}

export function KnowledgeWorkspace({ notes, sources, projects, people, selectedId, loading, readOnly, error, onOpen, onBack, onPreserve }: KnowledgeWorkspaceProps) {
  const narrow = useNarrowWorkspace();
  const [advanced, setAdvanced] = useState(false);
  const [filters, setFilters] = useState(emptyFilters);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const sourceById = useMemo(() => new Map(sources.filter((source) => source.frontmatter.type === "source").map((source) => [source.frontmatter.id, source])), [sources]);
  const sourceTypeOptions = useMemo(() => [...new Set(sources.map((source) => source.frontmatter.source_type).filter((value): value is string => typeof value === "string"))].sort(), [sources]);
  const published = useMemo(() => notes.filter((note) => note.frontmatter.type === "knowledge-note" && !note.frontmatter.archived_at && !note.frontmatter.deleted_at).filter((note) => matches(note, filters, sourceById)).sort((left, right) => String(right.frontmatter.created_at).localeCompare(String(left.frontmatter.created_at))), [notes, filters, sourceById]);
  const selected = notes.find((note) => note.frontmatter.id === selectedId && note.frontmatter.type === "knowledge-note" && !note.frontmatter.deleted_at);
  const detailOpen = Boolean(selectedId);
  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  return <div className={`knowledge-workspace${detailOpen ? " detail-open" : ""}`}>
    <section className="knowledge-list-pane" aria-label="Knowledge list" hidden={narrow && detailOpen}>
      <header className="knowledge-heading"><div><span>KNOWLEDGE</span><h2>Published Knowledge Notes</h2><p className="muted">Browse accepted ideas and research. Original Sources remain separate and traceable.</p></div><button className="primary" disabled={readOnly} onClick={() => setIntakeOpen(true)}>Preserve Source</button></header>
      {readOnly && <p className="knowledge-read-only">Read-only on this Mac. Published notes remain available to read.</p>}
      <div className="knowledge-common-filters">
        <input type="search" aria-label="Search knowledge" placeholder="Search published notes…" value={filters.query} onChange={(event) => set({ query: event.target.value })} />
        <select aria-label="Filter by area" value={filters.area} onChange={(event) => set({ area: event.target.value })}><option value="">Any area</option>{areaOptions.map((area) => <option value={area} key={area}>{label(area)}</option>)}</select>
        <button aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>Advanced</button>
      </div>
      {advanced && <div className="knowledge-advanced-filters">
        <label>Source type<select aria-label="Filter by source type" value={filters.sourceType} onChange={(event) => set({ sourceType: event.target.value })}><option value="">Any source</option>{sourceTypeOptions.map((type) => <option value={type} key={type}>{label(type)}</option>)}</select></label>
        <label>Published from<input aria-label="Published from" type="date" value={filters.fromDay} max={filters.toDay || undefined} onChange={(event) => set({ fromDay: event.target.value })} /></label>
        <label>Published to<input aria-label="Published to" type="date" value={filters.toDay} min={filters.fromDay || undefined} onChange={(event) => set({ toDay: event.target.value })} /></label>
        <label>Project<select aria-label="Filter by project" value={filters.projectId} onChange={(event) => set({ projectId: event.target.value })}><option value="">Any project</option>{projects.map((option) => <option value={option.id} key={option.id}>{option.title}</option>)}</select></label>
        <label>Person<select aria-label="Filter by person" value={filters.personId} onChange={(event) => set({ personId: event.target.value })}><option value="">Anyone</option>{people.map((option) => <option value={option.id} key={option.id}>{option.title}</option>)}</select></label>
        <button disabled={filters === emptyFilters || Object.values(filters).every((value) => !value)} onClick={() => setFilters(emptyFilters)}>Clear filters</button>
      </div>}
      {error && !(narrow && detailOpen) && <p className="knowledge-error" role="alert">{error}</p>}
      {loading ? <p className="muted" role="status">Loading published Knowledge Notes…</p> : published.length ? <div className="knowledge-rows">{published.map((note) => <button className={`knowledge-row${note.frontmatter.id === selectedId ? " selected" : ""}`} key={note.frontmatter.id} aria-label={`Open Knowledge Note: ${note.frontmatter.title}`} onClick={() => onOpen(note.frontmatter.id)}><strong>{note.frontmatter.title}<LockBadge frontmatter={note.frontmatter} /></strong><small>{note.frontmatter.area ? label(String(note.frontmatter.area)) : "No area"} · Published {publishedDay(note)}</small><span>{preview(note.body)}</span></button>)}</div> : <article className="knowledge-empty"><h3>No published Knowledge Notes yet</h3><p>Preserve a Source, then use LifeOS capture to propose a Knowledge Note for review.</p></article>}
    </section>
    <section className="knowledge-detail-pane" aria-label="Knowledge detail" hidden={narrow && !detailOpen}>
      <button className="knowledge-back" onClick={onBack}>Back to knowledge</button>
      {error && narrow && detailOpen && <p className="knowledge-error" role="alert">{error}</p>}
      {loading && narrow ? <p className="muted" role="status">Loading published Knowledge Notes…</p> : selected ? <article className="knowledge-reader"><header><span>PUBLISHED KNOWLEDGE NOTE</span><h1>{selected.frontmatter.title}</h1><div><LockBadge frontmatter={selected.frontmatter} /><small>{selected.frontmatter.area ? label(String(selected.frontmatter.area)) : "No area"} · Published {publishedDay(selected)}</small></div></header><div className="knowledge-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.body || "_Empty note._"}</ReactMarkdown></div><footer>{sourceTypes(selected, sourceById).length ? `Sources: ${sourceTypes(selected, sourceById).map(label).join(", ")}` : "No source type recorded"}</footer></article> : <article className="knowledge-empty"><h3>Select a Knowledge Note</h3><p>Choose a published note to read it here.</p></article>}
    </section>
    <KnowledgeIntakePanel open={intakeOpen} readOnly={readOnly} onClose={() => setIntakeOpen(false)} onPreserve={onPreserve} />
  </div>;
}

export { knowledgeSkillHelp };
