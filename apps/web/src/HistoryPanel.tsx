// #85: an object's history (ADR 0012): its kept versions, newest first, and the edits made outside LifeOS,
// each with a 'Restore this version' action that asks for confirmation, then puts the copy back through the
// guarded write. Copies that retention has pruned say so and offer nothing.
import React, { useEffect, useId, useState } from "react";
import type { HistoryEntry, HistoryPanel as HistoryPanelData } from "@lifeos/contracts";
import { api, ApiError, type Api } from "./api.js";
import { formatDate } from "./dateFormat.js";
import { CappedRows } from "./TodayLists.js";


/** Same wording as the server's refusal (#79), so the list and a late restore attempt agree. */
export const prunedMessage = "This version is no longer kept (only the last 10 are)";

/** #92: same wording as the server's refusal when the object changed after the panel opened. */
export const restoreConflictMessage = "This was changed since you opened its history, so nothing was restored. Reload to see the latest version, then try again.";

/** What the panel was opened with: the hash a restore is guarded by, and whether the object is restricted. */
export type OpenedObject = Pick<HistoryPanelData, "contentHash" | "restricted">;

const eventLabels: Record<string, string> = {
  "object.changed-externally": "Edited outside LifeOS",
  "object.deleted-externally": "Deleted outside LifeOS",
  "object.made-unreadable-externally": "Made unreadable outside LifeOS",
  "object.restored-from-version": "Restored a kept version"
};

/** What the row is: a version (with its revision) or an event. */
export function historyEntryLabel(entry: HistoryEntry) {
  if (entry.kind === "event") return eventLabels[entry.action ?? ""] ?? entry.action ?? "Event";
  return `Revision ${entry.revision ?? "?"}${entry.title ? ` · ${entry.title}` : ""}`;
}

/** Only kept versions other than the current file can be restored; events and pruned copies offer nothing. */
export const canRestore = (entry: HistoryEntry) => entry.kind === "version" && entry.kept && !entry.current && Boolean(entry.versionPath);

/**
 * The restore step itself, separate from the UI so it can be tested: posts the version, then refreshes the history
 * and the caller's view. `run` is the app's action runner, which shows the success toast or the server's error.
 * #92: guarded by the hash the panel was opened with; a restore keeps the current sensitivity, and the toast says so.
 */
export async function restoreEntry(objectId: string, entry: HistoryEntry, opened: OpenedObject, deps: {
  call: Api;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  reload: () => Promise<void>;
  onRestored?: () => Promise<void>;
}) {
  if (!canRestore(entry)) return false;
  return deps.run(async () => {
    try { await deps.call("POST /api/v1/objects/:id/history/restore", { params: { id: objectId }, body: { versionPath: entry.versionPath!, expectedHash: opened.contentHash } }); }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) throw new Error(restoreConflictMessage);
      throw error;
    } finally { await deps.reload(); }
    await deps.onRestored?.();
  }, `Restored revision ${entry.revision} from ${formatDate(entry.at)}${opened.restricted ? ". It stays restricted: a restore never changes sensitivity." : ""}`);
}

/** One row. While `confirming`, the restore button is replaced by an explicit confirm / cancel pair. */
export function HistoryRow({ entry, confirming, disabled, onAsk, onConfirm, onCancel }: {
  entry: HistoryEntry; confirming: boolean; disabled: boolean;
  onAsk: () => void; onConfirm: () => void; onCancel: () => void;
}) {
  const label = historyEntryLabel(entry);
  return <div className="history-row">
    <div>
      <b>{label}</b>
      {entry.current && <span className="history-tag">Current</span>}
      {entry.external && <span className="history-tag external">External edit</span>}
      <small>{formatDate(entry.at)} · {entry.device}</small>
      {entry.versionPath && !entry.kept && <small className="muted">{prunedMessage}</small>}
    </div>
    {canRestore(entry) && (confirming
      ? <span className="history-confirm" role="group" aria-label={`Confirm restoring ${label}`}>
          <small>Replace the current version with this one?</small>
          <button type="button" className="primary" disabled={disabled} onClick={onConfirm}>Confirm restore</button>
          <button type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
        </span>
      : <button type="button" disabled={disabled} aria-label={`Restore this version: ${label}, ${formatDate(entry.at)}`} onClick={onAsk}>Restore this version</button>)}
  </div>;
}

/** The list, capped at 7 rows with 'Show N more' (shared with Today). */
export function HistoryList({ entries, confirmingId, disabled, onAsk, onConfirm, onCancel }: {
  entries: HistoryEntry[]; confirmingId?: string; disabled: boolean;
  onAsk: (entry: HistoryEntry) => void; onConfirm: (entry: HistoryEntry) => void; onCancel: () => void;
}) {
  if (!entries.length) return <p className="muted">No kept versions yet.</p>;
  return <div className="history-list"><CappedRows items={entries} row={(entry) => <HistoryRow key={`${entry.kind}:${entry.id}`} entry={entry} confirming={entry.id === confirmingId} disabled={disabled} onAsk={() => onAsk(entry)} onConfirm={() => onConfirm(entry)} onCancel={onCancel} />} /></div>;
}

/** A 'History' button for an object detail; opens the history in place and loads it each time it opens. */
export function HistoryLink({ objectId, title, disabled, run, onRestored }: {
  objectId: string; title: string; disabled: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onRestored?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<HistoryPanelData>();
  const entries = panel?.entries;
  const [error, setError] = useState<string>();
  const [confirmingId, setConfirmingId] = useState<string>();
  const [working, setWorking] = useState(false);
  const panelId = useId();
  const reload = async () => {
    try { setPanel(await api("GET /api/v1/objects/:id/history", { params: { id: objectId } })); setError(undefined); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "History could not be loaded"); }
  };
  useEffect(() => { if (open) void reload(); else setConfirmingId(undefined); }, [open, objectId]);
  const confirm = async (entry: HistoryEntry) => {
    setWorking(true);
    try {
      await restoreEntry(objectId, entry, { contentHash: panel?.contentHash, restricted: panel?.restricted ?? false }, { call: api, run, reload, onRestored });
    } finally { setWorking(false); setConfirmingId(undefined); }
  };
  return <div className="history-link">
    <button type="button" className="link-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>History</button>
    {open && <section id={panelId} className="history-panel" aria-label={`History of ${title}`} onKeyDown={(event) => { if (event.key === "Escape") { if (confirmingId) setConfirmingId(undefined); else setOpen(false); } }}>
      <span>HISTORY · KEPT VERSIONS</span>
      {error && <p role="alert">{error}</p>}
      {!entries && !error && <p className="muted">Loading…</p>}
      {entries && <HistoryList entries={entries} confirmingId={confirmingId} disabled={disabled || working} onAsk={(entry) => setConfirmingId(entry.id)} onConfirm={(entry) => void confirm(entry)} onCancel={() => setConfirmingId(undefined)} />}
    </section>}
  </div>;
}
