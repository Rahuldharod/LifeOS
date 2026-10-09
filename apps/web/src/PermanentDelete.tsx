// PB-030: "Delete permanently" on the Deleted notes tab (ADR 0017). The pop-up names the note, says the delete
// cannot be undone from the app and that backups still hold it. Front-matter references block the delete and are
// listed as links; body links only warn. The delete is a guarded write: a stale hash fails with a plain message.
import React, { useState } from "react";
import { api, ApiError } from "./api.js";

export type PurgeReference = { id: string; type: string; title: string };
export type PurgeCheck = { blockers: PurgeReference[]; bodyLinks: PurgeReference[] };
type PurgeNoteTarget = { frontmatter: { id: string; title: string }; contentHash: string };
type Call = <T>(url: string, options?: RequestInit) => Promise<T>;

/** Deletes the note through DELETE /notes/:id/permanent, guarded by its content hash. */
export async function purgeNote(note: PurgeNoteTarget, call: Call = api) {
  try {
    await call(`/api/v1/notes/${note.frontmatter.id}/permanent`, { method: "DELETE", body: JSON.stringify({ expectedHash: note.contentHash }) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && !/referenced/i.test(error.message)) throw new Error("This note was changed elsewhere, so it was not deleted. The latest version is loaded; try again.");
    throw error;
  }
}

function ReferenceList({ references, onOpen }: { references: PurgeReference[]; onOpen: (id: string) => void }) {
  return <ul>{references.map((reference) => <li key={reference.id}><button type="button" className="link-button" onClick={() => onOpen(reference.id)}>{reference.title}</button> <small className="muted">{reference.type.replace("-", " ")}</small></li>)}</ul>;
}

export function PermanentDeleteDialog({ title, check, busy, onConfirm, onCancel, onOpen }: {
  title: string;
  check: PurgeCheck;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onOpen: (id: string) => void;
}) {
  const blocked = check.blockers.length > 0;
  return <div className="purge-overlay">
    <div className="purge-dialog" role="dialog" aria-modal="true" aria-labelledby="purge-title">
      <h3 id="purge-title">Delete “{title}” permanently?</h3>
      <p>The Markdown file and its saved versions are removed. This <b>cannot be undone from the app</b>. Backups still hold it.</p>
      {blocked && <div className="purge-blockers">
        <p><b>It cannot be deleted yet:</b> it is still referenced by these items. Remove those links first.</p>
        <ReferenceList references={check.blockers} onOpen={onOpen} />
      </div>}
      {!blocked && check.bodyLinks.length > 0 && <div className="purge-warning">
        <p>These notes link to it; their links will show as missing.</p>
        <ReferenceList references={check.bodyLinks} onOpen={onOpen} />
      </div>}
      <div className="actions">
        <button type="button" onClick={onCancel}>{blocked ? "Close" : "Cancel"}</button>
        {!blocked && <button type="button" className="danger" disabled={busy} onClick={onConfirm}>Delete permanently</button>}
      </div>
    </div>
  </div>;
}

/** The Deleted tab's button and its confirmation pop-up. */
export function PermanentDeleteButton({ note, disabled, run, onOpen, onDeleted }: {
  note: PurgeNoteTarget;
  disabled: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  onOpen: (id: string) => void;
  /** Reloads the lists, after success or a conflict (someone else saved first). */
  onDeleted: (deleted: boolean) => Promise<void>;
}) {
  const [check, setCheck] = useState<PurgeCheck>();
  const [busy, setBusy] = useState(false);
  const load = () => api<PurgeCheck>(`/api/v1/notes/${note.frontmatter.id}/purge-check`);
  const start = () => void run(async () => setCheck(await load()), "Confirm the permanent delete");
  const confirm = async () => {
    setBusy(true);
    try {
      const deleted = await run(() => purgeNote(note), "Note deleted permanently");
      if (deleted) { setCheck(undefined); await onDeleted(true); return; }
      // Refused: show what references it now, or close and reload after a conflict.
      const latest = await load().catch(() => undefined);
      if (latest?.blockers.length) setCheck(latest);
      else { setCheck(undefined); await onDeleted(false); }
    } finally { setBusy(false); }
  };
  return <>
    <button type="button" className="danger" disabled={disabled} onClick={start}>Delete permanently</button>
    {check && <PermanentDeleteDialog title={note.frontmatter.title} check={check} busy={busy || disabled} onConfirm={() => void confirm()} onCancel={() => setCheck(undefined)} onOpen={(id) => { setCheck(undefined); onOpen(id); }} />}
  </>;
}
