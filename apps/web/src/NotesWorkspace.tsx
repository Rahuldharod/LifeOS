import React, { type ReactNode, useEffect, useState } from "react";
import type { LifeObject } from "@lifeos/contracts";
import { LockBadge } from "./EnvelopeBadges.js";
import { ConflictBadge } from "./NoteConflictPanel.js";
import { NoteFiltersPanel } from "./NoteFiltersPanel.js";
import type { NoteFilterState } from "./noteFilters.js";
import { groupByDay } from "./noteGroups.js";
import { useSplitPane } from "./splitPane.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";

type Option = { id: string; title: string };
export type NoteEditorMode = "visual" | "write" | "preview";
export type NoteDetailState = "open" | "deleted" | "conflict" | "empty";

export type NotesWorkspaceProps = {
  notes: LifeObject[];
  openCount: number;
  deletedCount: number;
  tab: "open" | "deleted";
  selectedId?: string;
  query: string;
  filters: NoteFilterState;
  projects: Option[];
  clients: Option[];
  products: Option[];
  people: Option[];
  timeZone: string;
  loading: boolean;
  error?: string | null;
  readOnly: boolean;
  conflictedNoteIds: ReadonlySet<string>;
  emptyMessage: string;
  detailState?: NoteDetailState;
  onQueryChange: (query: string) => void;
  onFiltersChange: (filters: NoteFilterState) => void;
  onTabChange: (tab: "open" | "deleted") => void;
  onOpen: (id: string) => void;
  onBack: () => void;
  renderOpenNote: (mode: NoteEditorMode, readOnly: boolean) => ReactNode;
  deletedDetail: ReactNode;
  conflictDetail: ReactNode;
};

const preview = (body: string) => body.replace(/[#>*_`[\]-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110) || "Empty note";
const noteType = (note: LifeObject) => note.frontmatter.type === "meeting-note" ? "Meeting note" : "Knowledge note";
const timeIn = (value: unknown, timeZone: string) => {
  if (typeof value !== "string") return "—";
  try { return new Date(value).toLocaleTimeString([], { timeStyle: "short", timeZone }); }
  catch { return new Date(value).toLocaleTimeString([], { timeStyle: "short" }); }
};

/**
 * The persistent Notes list/detail shell. Authoritative note editing stays in the caller so the
 * existing draft controller, expected-hash saves, image handling and Markdown round trips remain
 * one implementation shared with Calendar.
 */
export function NotesWorkspace(props: NotesWorkspaceProps) {
  const [advanced, setAdvanced] = useState(false);
  const [mode, setMode] = useState<NoteEditorMode>("visual");
  const split = useSplitPane("notes");
  const narrow = useNarrowWorkspace();
  const detailOpen = Boolean(props.selectedId) || props.loading;
  const ref = useListDetailReturn(detailOpen ? props.selectedId ?? "loading" : undefined);
  const state = props.detailState ?? (props.selectedId ? (props.tab === "deleted" ? "deleted" : "open") : "empty");

  // A note never inherits the previous note's raw or preview mode.
  useEffect(() => { setMode("visual"); }, [props.selectedId]);

  return <div ref={ref} className={`notes-workspace split-layout pane-workspace${detailOpen ? " detail-open" : ""}`} data-workspace="notes" style={split.style}>
    <article className="notes-workspace-list" data-pane="list" aria-label="Notes list" hidden={narrow && detailOpen}>
      <div className="workspace-heading"><div><span>NOTES</span><h2>Notes</h2><p className="muted">Meeting and knowledge notes</p></div></div>
      <div className="workspace-tabs" role="tablist" aria-label="Notes">
        <button role="tab" aria-selected={props.tab === "open"} className={props.tab === "open" ? "selected" : ""} onClick={() => props.onTabChange("open")}>Open <small>{props.openCount}</small></button>
        <button role="tab" aria-selected={props.tab === "deleted"} className={props.tab === "deleted" ? "selected" : ""} onClick={() => props.onTabChange("deleted")}>Deleted <small>{props.deletedCount}</small></button>
      </div>
      <div className="notes-common-filters">
        <input type="search" aria-label="Search notes" placeholder={props.tab === "open" ? "Search notes…" : "Search deleted notes…"} value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} />
        <NoteFiltersPanel filters={props.filters} onChange={props.onFiltersChange} tab={props.tab} projects={props.projects} clients={props.clients} products={props.products} people={props.people} advanced={advanced} onToggleAdvanced={() => setAdvanced((value) => !value)} />
      </div>
      {props.error && !(narrow && detailOpen) && <p className="notes-workspace-error" role="alert">{props.error}</p>}
      {props.loading ? <p className="muted" role="status">Loading notes…</p> : <>
        {!props.notes.length && <p className="muted">{props.emptyMessage}</p>}
        <div className="note-workspace-rows">
          {groupByDay(props.notes, (note) => props.tab === "open" ? note.frontmatter.updated_at : String(note.frontmatter.deleted_at), props.timeZone).map((group) => <div className="note-day-group" key={group.key}>
            <h3 className="note-day-label">{group.label}</h3>
            {group.items.map((note) => <button className={`note-list-item${note.frontmatter.id === props.selectedId ? " selected" : ""}`} aria-label={`Open note: ${note.frontmatter.title}`} key={note.frontmatter.id} onClick={() => props.onOpen(note.frontmatter.id)}>
              <b>{note.frontmatter.title}<LockBadge frontmatter={note.frontmatter} />{props.tab === "open" && props.conflictedNoteIds.has(note.frontmatter.id) && <ConflictBadge />}</b>
              <small>{noteType(note)} · {props.tab === "open" ? timeIn(note.frontmatter.updated_at, props.timeZone) : `Deleted ${timeIn(note.frontmatter.deleted_at, props.timeZone)}`}</small>
              <span>{preview(note.body)}</span>
            </button>)}
          </div>)}
        </div>
      </>}
    </article>
    {!narrow && <div {...split.dividerProps} />}
    <section className="notes-workspace-detail" data-pane="detail" aria-label="Note detail" hidden={narrow && !detailOpen}>
      <div className="notes-detail-tools">
        <button className="narrow-back" onClick={props.onBack}>Back to notes</button>
        {props.readOnly && <span className="notes-read-only" role="status">Read-only on this Mac</span>}
        {state === "open" && <div className="mode-switch" role="group" aria-label="Note view">
          <button className={mode === "visual" ? "selected" : ""} aria-pressed={mode === "visual"} onClick={() => setMode("visual")}>Visual</button>
          <button className={mode === "write" ? "selected" : ""} aria-pressed={mode === "write"} onClick={() => setMode("write")}>Markdown</button>
          <button className={mode === "preview" ? "selected" : ""} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
        </div>}
      </div>
      {props.error && narrow && detailOpen && <p className="notes-workspace-error" role="alert">{props.error}</p>}
      {props.loading ? <article className="empty-state" role="status"><h3>Loading note…</h3><p>Reading the current Markdown file.</p></article>
        : state === "deleted" ? props.deletedDetail
        : state === "conflict" ? props.conflictDetail
        : state === "open" ? props.renderOpenNote(mode, props.readOnly)
        : <article className="empty-state"><h3>Select a note</h3><p>Choose a note to view or edit it.</p></article>}
    </section>
  </div>;
}
