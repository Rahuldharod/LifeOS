// Shared draft/conflict controller for any Markdown note editor (Notes view, Calendar meeting
// workspace). Owns: opening a draft (adopting a recovered browser draft when present), pausing
// autosave and flagging a conflict when the file changed outside LifeOS while a draft was open,
// resyncing silently when the draft was untouched, and the "Keep browser version" / "Keep disk
// version" choices from the conflict panel. Both editors get identical guarantees this way,
// including the base-hash pinning U1 fixed for Notes (autosave and manual saves send the hash the
// draft was opened with, never a hash a background refresh happened to pick up).
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.js";
import { cacheDraft, clearCachedDraft, type CachedDraft } from "./draftStorage.js";
import { noteDraftBase, noteSaveRequest, openNoteDraft, reconcileNoteDraft, type NoteDraftBase } from "./noteDraft.js";

export type DraftControllerNote = { frontmatter: { id: string }; body: string; contentHash: string };

export type NoteDraftController = {
  draft: string;
  setDraft: (value: string) => void;
  base: NoteDraftBase | undefined;
  conflict: boolean;
  autoSaving: boolean;
  dirty: boolean;
  /** Opens (or resumes, if a cached browser draft disagrees with disk) a draft for `note`. Called
   * imperatively by editors that already have the fresh note in hand (selecting a note, opening a
   * meeting), so the draft appears in the same tick rather than waiting for a reactive effect. */
  open: (note: DraftControllerNote, cached?: CachedDraft) => { conflict: boolean };
  /** Clears the controller back to an empty, unopened state (e.g. a meeting with no canonical note yet). */
  reset: () => void;
  /** Saves the current draft immediately (skipping the autosave debounce), pinned to the base hash
   * the draft was opened with — used by explicit "Save" buttons so they get the same U1 guarantee
   * as autosave, rather than saving against the note's live (possibly stale) hash. Resolves false
   * (without throwing) if the save was skipped or failed, including a fresh conflict — the conflict
   * panel takes over in that case, so callers should stop rather than report success. */
  saveNow: () => Promise<boolean>;
  keepDiskVersion: () => Promise<void>;
  keepBrowserVersion: () => Promise<void>;
  /** True for a single, short-lived window right after "Keep disk version": the just-discarded
   * browser draft can still be brought back with `undoKeepDiskVersion`. Cleared by any other
   * draft-affecting action (typing, saving, opening a different note, `keepBrowserVersion`, or a
   * later `keepDiskVersion`) — this is a one-shot offer, not a history browser. */
  undoAvailable: boolean;
  /** Restores the draft discarded by the most recent "Keep disk version", if the offer is still
   * live. Re-checks the note's current disk hash against the hash that draft was discarded in
   * favour of: if disk hasn't moved on, the draft comes back directly; if it has (another external
   * edit landed after the discard), this reopens the conflict panel against the newer disk copy
   * instead of silently overwriting it. No-op if `undoAvailable` is false. */
  undoKeepDiskVersion: () => Promise<void>;
};

export type NoteDraftControllerOptions = {
  note: DraftControllerNote | undefined;
  readOnly: boolean;
  busy: boolean;
  onMessage: (message: string) => void;
  /** Merge a freshly-saved object back into the caller's own list/workspace state. */
  onSaved: (updated: DraftControllerNote) => void;
  /** Refetch the freshest copy of the same note from the server, updating the caller's own
   * list/workspace state as a side effect, and return that note (or undefined if it's gone). */
  fetchLatest: () => Promise<DraftControllerNote | undefined>;
  autosaveDelayMs?: number;
};

export function useNoteDraftController({ note, readOnly, busy, onMessage, onSaved, fetchLatest, autosaveDelayMs = 1800 }: NoteDraftControllerOptions): NoteDraftController {
  const [draft, setDraftState] = useState("");
  const [base, setBase] = useState<NoteDraftBase>();
  const [conflict, setConflict] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [undoable, setUndoable] = useState<{ body: string; baseHash: string; noteId: string } | undefined>(undefined);
  const activeDraft = useRef("");
  const restoredId = useRef<string | undefined>(undefined);

  useEffect(() => { activeDraft.current = draft; }, [draft]);

  /** Typing is a draft-affecting action: it always retires a pending "Keep disk version" undo
   * offer, same as saving or opening a different note. */
  function setDraft(value: string) {
    setUndoable(undefined);
    setDraftState(value);
  }

  function open(target: DraftControllerNote, cached?: CachedDraft) {
    const opened = openNoteDraft(target, cached);
    restoredId.current = target.frontmatter.id;
    setBase(opened.base); setDraftState(opened.draft); setConflict(opened.conflict); setUndoable(undefined);
    return { conflict: opened.conflict };
  }

  function reset() {
    restoredId.current = undefined;
    setBase(undefined); setDraftState(""); setConflict(false); setUndoable(undefined);
  }

  /** Shared by the debounced autosave effect and `saveNow`: PUT the draft pinned to `saveBase`,
   * merge the result back into the caller's state, and reconcile the local cache. Never throws —
   * returns whether the save actually landed, so a caller doesn't have to read back potentially
   * stale state to find out. */
  async function performSave(saveBase: NoteDraftBase, bodyToSave: string): Promise<boolean> {
    setUndoable(undefined);
    setAutoSaving(true);
    try {
      const updated = await api<DraftControllerNote>(`/api/v1/objects/${saveBase.noteId}/body`, { method: "PUT", body: JSON.stringify(noteSaveRequest(saveBase, bodyToSave)) });
      onSaved(updated);
      setBase((current) => current?.noteId === saveBase.noteId ? noteDraftBase(updated) : current);
      if (activeDraft.current === bodyToSave) clearCachedDraft(saveBase.noteId); else cacheDraft(saveBase.noteId, activeDraft.current, updated.contentHash);
      onMessage("Autosaved to Markdown");
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      onMessage(`Browser draft is safe; Markdown autosave failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return false;
    } finally {
      setAutoSaving(false);
    }
  }

  async function saveNow(): Promise<boolean> {
    if (!note || restoredId.current !== note.frontmatter.id || !base || base.noteId !== note.frontmatter.id) return false;
    if (readOnly || busy || conflict || autoSaving) return false;
    return performSave(base, draft);
  }

  // A refreshed copy of the open note may carry an external edit: adopt it silently if the draft
  // is untouched, otherwise pause autosave and flag a conflict.
  useEffect(() => {
    if (!note || !base || restoredId.current !== note.frontmatter.id || autoSaving) return;
    const result = reconcileNoteDraft(base, draft, note);
    if (result.kind === "resync") { setBase(result.base); setDraft(result.draft); }
    if (result.kind === "conflict" && !conflict) {
      setConflict(true);
      onMessage("This note changed on disk while you were editing. Autosave paused; your draft is kept in the browser.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.contentHash, base?.hash, autoSaving]);

  // Debounced autosave, gated on the pinned base hash rather than the note's live contentHash.
  useEffect(() => {
    if (!note || restoredId.current !== note.frontmatter.id) return;
    const dirty = draft !== note.body;
    if (!dirty) { clearCachedDraft(note.frontmatter.id); return; }
    if (!base || base.noteId !== note.frontmatter.id) return;
    cacheDraft(base.noteId, draft, base.hash);
    if (readOnly || busy || conflict || autoSaving) return;
    const saveBase = base;
    const bodyToSave = draft;
    const timer = window.setTimeout(() => void performSave(saveBase, bodyToSave), autosaveDelayMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.frontmatter.id, note?.contentHash, draft, base, readOnly, busy, conflict, autoSaving]);

  /** "Keep disk version": discard the browser draft and adopt the current Markdown file. Always
   * clears the conflict flag, even if the note is gone — otherwise a deleted-elsewhere note would
   * leave the panel stuck open with no way to dismiss it. Guards against the controller having
   * moved on to a different note while `fetchLatest` was in flight (e.g. the user clicked another
   * note before this resolved) — without this, a slow `keepDiskVersion` for note A could land after
   * note B was opened and clobber B's freshly-opened draft with A's disk content. */
  async function keepDiskVersion() {
    const discardedDraft = draft;
    const openedNoteId = restoredId.current;
    const latest = await fetchLatest();
    if (restoredId.current !== openedNoteId) return;
    if (!latest) {
      reset();
      onMessage("This note no longer exists on disk.");
      return;
    }
    setBase(noteDraftBase(latest)); setDraftState(latest.body); setConflict(false);
    clearCachedDraft(latest.frontmatter.id);
    // Stash the discarded draft against the hash of the disk version just kept (not the stale
    // pre-conflict base hash) so `undoKeepDiskVersion` can tell whether disk has moved on again
    // by the time undo is used.
    setUndoable({ body: discardedDraft, baseHash: latest.contentHash, noteId: latest.frontmatter.id });
    onMessage("Kept the disk version; your browser draft was discarded");
  }

  /** Restores the draft discarded by the most recent `keepDiskVersion`, reusing the same
   * base-hash comparison `open()`/`openNoteDraft` already do for a recovered browser draft:
   * unchanged disk restores directly, a disk change since the discard reopens the conflict panel
   * instead of overwriting it blind. One-shot — always clears the offer first. Same in-flight guard
   * as `keepDiskVersion`: if the controller moved on to a different note while `fetchLatest` was
   * pending, this bails out rather than clobbering that note's state. */
  async function undoKeepDiskVersion() {
    if (!undoable) return;
    const stashed = undoable;
    setUndoable(undefined);
    const latest = await fetchLatest();
    if (restoredId.current !== stashed.noteId) return;
    if (!latest || latest.frontmatter.id !== stashed.noteId) {
      onMessage("This note is no longer available to restore.");
      return;
    }
    const restored = openNoteDraft(latest, { body: stashed.body, baseHash: stashed.baseHash });
    setBase(restored.base); setDraftState(restored.draft); setConflict(restored.conflict);
    onMessage(restored.conflict
      ? "This note changed again after you kept the disk version. Compare before choosing."
      : "Restored your browser draft");
  }

  /**
   * "Keep browser version": save the draft over whatever is currently on disk, rather than the
   * (now stale) hash the draft was opened with. Refetches immediately before saving, since `note`
   * may be a little behind if the file changed again after the conflict first appeared — the
   * previous disk content isn't lost either way: the object store snapshots it to
   * `.lifeos/versions/` before this overwrite.
   */
  async function keepBrowserVersion() {
    if (busy || readOnly) return;
    setUndoable(undefined);
    const bodyToSave = draft;
    try {
      const latest = await fetchLatest();
      if (!latest) { onMessage("This note no longer exists on disk."); return; }
      const rebased = noteSaveRequest(noteDraftBase(latest), bodyToSave);
      const updated = await api<DraftControllerNote>(`/api/v1/objects/${latest.frontmatter.id}/body`, { method: "PUT", body: JSON.stringify(rebased) });
      onSaved(updated);
      setBase(noteDraftBase(updated)); setDraftState(updated.body); setConflict(false);
      clearCachedDraft(updated.frontmatter.id);
      onMessage("Kept the browser version; the previous disk version is in its history");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await fetchLatest();
        onMessage("This note changed again while saving. Compare once more, then choose.");
      } else {
        onMessage(error instanceof Error ? error.message : "Could not save the browser version");
      }
    }
  }

  const dirty = Boolean(note && draft !== note.body);

  return { draft, setDraft, base, conflict, autoSaving, dirty, open, reset, saveNow, keepDiskVersion, keepBrowserVersion, undoAvailable: undoable !== undefined, undoKeepDiskVersion };
}
