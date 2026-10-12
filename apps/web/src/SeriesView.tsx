import { useEffect, useRef, useState } from "react";
import type { LifeObject, SeriesView as SeriesViewData, SeriesViewEarlier, SeriesViewMaterials } from "@lifeos/contracts";
import { ApiError, api } from "./api.js";
import { readCachedDraft } from "./draftStorage.js";
import type { LinkedObject } from "./lifeosLinks.js";
import { MarkdownEditor, type EditorMode } from "./MarkdownEditor.js";
import type { GuardedEditor } from "./navigationGuard.js";
import { NoteConflictPanel } from "./NoteConflictPanel.js";
import { SaveState } from "./SaveState.js";
import { useNoteDraftController } from "./useNoteDraftController.js";
import "./SeriesView.css";

const dateLabel = (value: string, timeZone: string) => new Date(value).toLocaleDateString([], { timeZone, dateStyle: "full" });
const timeLabel = (value: string, timeZone: string) => new Date(value).toLocaleTimeString([], { timeZone, hour: "2-digit", minute: "2-digit" });

/** The Calendar's yyyy-mm-dd for a moment in the display time zone. */
export const calendarDate = (value: string, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

/** ADR 0021: one label per earlier Note. A Legacy shared Note shows the date range of the Meetings it covers. */
export function seriesViewLabel(entry: SeriesViewEarlier, timeZone: string) {
  if (entry.kind === "legacy-shared") {
    const from = dateLabel(entry.range.startsAt, timeZone);
    const to = dateLabel(entry.range.endsAt, timeZone);
    return { title: from === to ? from : `${from} to ${to}`, detail: "Shared Note" };
  }
  return { title: dateLabel(entry.range.startsAt, timeZone), detail: `${timeLabel(entry.range.startsAt, timeZone)}–${timeLabel(entry.range.endsAt, timeZone)}` };
}

/** What every Series editor needs from the app. */
export type SeriesEditorContext = {
  mode: EditorMode;
  /** True when another device holds the write lease: nothing may be written from here. */
  readOnly: boolean;
  linkObjects: LinkedObject[];
  notify: (message: string) => void;
  /** Registers the editor with the leave-page guard (PB-027); returns the unregister function. */
  register: (id: string, read: () => GuardedEditor) => () => void;
};

/**
 * One earlier Note, edited in place (ADR 0021, #173). It owns its own draft controller and busy state, so its
 * autosave, base hash, browser draft, conflict and save status never touch another Note's, nor the opened
 * occurrence's editor. A Legacy shared Note is one whole Note: its body is never split.
 */
function SeriesNoteEditor({ entry, editor }: { entry: SeriesViewEarlier; editor: SeriesEditorContext }) {
  const { mode, readOnly, linkObjects, notify, register } = editor;
  const id = entry.note.frontmatter.id;
  const [note, setNote] = useState<LifeObject>(entry.note);
  const [opened, setOpened] = useState(false);
  const [gone, setGone] = useState(false);
  // Per Note, like the app-wide busy flag: image attach and the conflict choices lock only this Note.
  const [busy, setBusy] = useState(false);
  const controller = useNoteDraftController({
    note,
    readOnly,
    busy,
    onMessage: notify,
    onSaved: (updated) => setNote(updated as LifeObject),
    // The disk copy, fetched by id so a Note outside the Series view's window still resolves. Only a real 404 means gone.
    fetchLatest: async () => {
      try {
        const latest = await api("GET /api/v1/notes/:id", { params: { id } });
        setNote(latest);
        return latest;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) { setGone(true); return undefined; }
        throw error;
      }
    }
  });
  useEffect(() => { controller.open(entry.note, readCachedDraft(entry.note)); setOpened(true); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A refreshed Series view (the opened occurrence was reloaded) hands in a newer copy of this Note. Take it only when it
  // is not the copy the draft is based on and not older than what we hold; the controller then resyncs or flags a conflict.
  // The deps are deliberately just the incoming hash: we react to the parent changing it, not to our own saves.
  const incoming = entry.note.contentHash;
  const baseHash = controller.base?.hash;
  useEffect(() => {
    if (incoming !== baseHash && Number(entry.note.frontmatter.revision) >= Number(note.frontmatter.revision)) setNote(entry.note);
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  // The leave-page guard reads the latest controller each time it asks.
  const latest = useRef<GuardedEditor>(controller);
  latest.current = controller;
  useEffect(() => register(id, () => latest.current), [id, register]);

  const choose = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { notify(error instanceof Error ? error.message : "Could not reach LifeOS; try again"); } finally { setBusy(false); }
  };
  if (gone) return <p className="muted">This Note no longer exists on disk.</p>;
  if (!opened) return null;
  if (controller.conflict) return <NoteConflictPanel noteTitle={note.frontmatter.title} draftText={controller.draft} diskText={note.body} disabled={busy || readOnly} onKeepBrowserVersion={() => void choose(controller.keepBrowserVersion)} onKeepDiskVersion={() => void choose(controller.keepDiskVersion)} />;
  return <div className="series-note-editor">
    <MarkdownEditor mode={mode} editorKey={`series:${id}`} draft={controller.draft} onChange={controller.setDraft} readOnly={readOnly} busy={busy} owner={{ id, relativePath: note.relativePath }} linkObjects={linkObjects} setBusy={setBusy} notify={notify} placeholder="Write Markdown… Paste or drop an image here." codeLanguagePrompt="Code language" caretAfterInsert refocusAfterImage={false} />
    <SaveState dirty={controller.dirty} autoSaving={controller.autoSaving} undoAvailable={controller.undoAvailable} undoDisabled={busy || readOnly} onUndo={() => void choose(controller.undoKeepDiskVersion)} />
  </div>;
}

/** #176: what enrichment attached to this occurrence's own Meeting, shown with it and never inside the Note. */
function SeriesMaterials({ materials }: { materials: SeriesViewMaterials }) {
  return <div className="series-view-materials">
    {materials.summary && <section aria-label="Accepted summary"><h4>Summary</h4><p>{materials.summary}</p></section>}
    {materials.sources.length > 0 && <section aria-label="Sources"><h4>Sources</h4><ul>{materials.sources.map((source) => <li key={source.id}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}</li>)}</ul></section>}
  </div>;
}

/**
 * History of earlier occurrences with a Note, collapsed by default (ADR 0021, #179), loaded 4 at a time (#180) and
 * edited in place (#173). Remount (key) per opened occurrence so loaded pages never leak between occurrences.
 * There is no delete here. Every Note, including each loaded page, is its own SeriesNoteEditor.
 */
export function SeriesView({ view, timeZone, editor, onOpenMeeting }: { view: SeriesViewData; timeZone: string; editor: SeriesEditorContext; onOpenMeeting: (meetingId: string, date: string) => void }) {
  const [loaded, setLoaded] = useState<{ entries: SeriesViewEarlier[]; cursor: string | undefined } | undefined>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const shown = new Set(view.earlier.map((entry) => entry.note.frontmatter.id));
  const earlier = [...view.earlier, ...(loaded?.entries ?? []).filter((entry) => !shown.has(entry.note.frontmatter.id))];
  const cursor = loaded ? loaded.cursor : view.nextCursor;
  const { newer } = view;
  if (!earlier.length && !newer) return null;
  const loadOlder = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const page = await api("GET /api/v1/meetings/series-view", { query: { cursor } });
      setLoaded({ entries: [...(loaded?.entries ?? []), ...page.earlier], cursor: page.nextCursor });
    } catch { setFailed(true); } finally { setLoading(false); }
  };
  return <section className="series-view" aria-label="Earlier occurrences">
    {newer && <p className="series-view-newer">Newer occurrences exist. <button type="button" onClick={() => onOpenMeeting(newer.meetingId, calendarDate(newer.startsAt, timeZone))}>Open the latest ({dateLabel(newer.startsAt, timeZone)})</button></p>}
    {earlier.length > 0 && <h3>Earlier occurrences</h3>}
    {earlier.map((entry) => {
      const { title, detail } = seriesViewLabel(entry, timeZone);
      return <details key={entry.note.frontmatter.id} className="series-view-entry">
        <summary><span>{title}</span><b>{detail}</b>{entry.cancelled && <em>Cancelled</em>}{entry.note.frontmatter.sensitivity === "restricted" && <em>Restricted</em>}</summary>
        {entry.materials && <SeriesMaterials materials={entry.materials} />}
        <SeriesNoteEditor entry={entry} editor={editor} />
      </details>;
    })}
    {cursor && <button type="button" className="series-view-load-older" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading…" : "Load older"}</button>}
    {failed && <p role="alert" className="series-view-error">Could not load older occurrences. Try again.</p>}
  </section>;
}
