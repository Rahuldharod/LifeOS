// The Duplicate clean-up (CONTEXT.md) on the People settings: every likely duplicate at once, sure matches pre-ticked,
// a backup first, then only the ticked rows change. Nothing is written until the user presses the apply button.
import React, { useState } from "react";
import type { DuplicateCleanupChoice, DuplicateCleanupResult, DuplicateCleanupRow } from "@lifeos/contracts";

const reasons: Record<Extract<DuplicateCleanupRow, { kind: "merge" }>["match"], string> = {
  email: "Same email address",
  "name-address": "The name is the other's email address",
  "name-email": "The email fits the other's name",
  "email-local-part": "Same email on two internal domains",
  name: "Same name only: check before merging",
  manual: "Asked for earlier"
};

const rowKey = (row: DuplicateCleanupRow) => row.kind === "merge" ? `merge:${row.keepPersonId}:${row.mergePersonId}` : `repair:${row.personId}`;

export type DuplicateCleanupCardProps = {
  disabled: boolean;
  onLoad: () => Promise<DuplicateCleanupRow[]>;
  onApply: (choice: DuplicateCleanupChoice) => Promise<DuplicateCleanupResult>;
  /** Called after an apply so the rest of the app shows the merged People. */
  onApplied: () => void;
};

export function DuplicateCleanupCard({ disabled, onLoad, onApply, onApplied }: DuplicateCleanupCardProps) {
  const [rows, setRows] = useState<DuplicateCleanupRow[]>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<{ kind: "done" | "error"; text: string }>();

  const find = async () => {
    setWorking(true); setStatus(undefined);
    try {
      const found = await onLoad();
      setRows(found);
      setTicked(new Set(found.filter((row) => row.kind === "repair" || row.preTicked).map(rowKey)));
    } catch (error) { setStatus({ kind: "error", text: `Could not look for duplicates: ${error instanceof Error ? error.message : "unknown error"}` }); }
    finally { setWorking(false); }
  };

  const apply = async () => {
    if (!rows) return;
    const chosen = rows.filter((row) => ticked.has(rowKey(row)));
    const choice: DuplicateCleanupChoice = {
      merges: chosen.flatMap((row) => row.kind === "merge" ? [{ keepPersonId: row.keepPersonId, mergePersonId: row.mergePersonId }] : []),
      repairs: chosen.flatMap((row) => row.kind === "repair" ? [row.personId] : [])
    };
    setWorking(true); setStatus(undefined);
    try {
      const result = await onApply(choice);
      const skipped = result.skipped ? ` ${result.skipped} skipped (already done or no longer matching).` : "";
      setStatus({ kind: "done", text: `Backed up first. Merged ${result.merged}, repaired ${result.repaired}.${skipped}` });
      setRows(undefined);
      onApplied();
    } catch (error) { setStatus({ kind: "error", text: `Nothing was changed: ${error instanceof Error ? error.message : "unknown error"}` }); }
    finally { setWorking(false); }
  };

  const toggle = (key: string) => setTicked((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const count = rows?.filter((row) => ticked.has(rowKey(row))).length ?? 0;

  return <section className="duplicate-cleanup" aria-label="Clean up duplicates">
    <p>Finds likely duplicate People. Sure matches are ticked for you; check the others yourself. LifeOS takes a backup before it changes anything.</p>
    {!rows && <button type="button" disabled={disabled || working} onClick={() => void find()}>{working ? "Looking…" : "Find duplicates"}</button>}
    {rows && rows.length === 0 && <p role="status">No duplicates found.</p>}
    {rows && rows.length > 0 && <>
      <ul className="duplicate-cleanup-rows">
        {rows.map((row) => {
          const key = rowKey(row);
          const text = row.kind === "merge" ? `Merge "${row.mergeTitle}" into "${row.keepTitle}"` : `Add ${row.email} as the email of "${row.title}"`;
          const reason = row.kind === "merge" ? reasons[row.match] : "Named by an address that no one holds";
          return <li key={key}>
            <label><input type="checkbox" checked={ticked.has(key)} disabled={disabled || working} onChange={() => toggle(key)} /> <span>{text}</span></label>
            <small>{reason}</small>
          </li>;
        })}
      </ul>
      <div className="duplicate-cleanup-actions">
        <button type="button" disabled={disabled || working || count === 0} onClick={() => void apply()}>{working ? "Working…" : `Back up and apply ${count}`}</button>
        <button type="button" disabled={working} onClick={() => setRows(undefined)}>Cancel</button>
      </div>
    </>}
    {status && <p role={status.kind === "error" ? "alert" : "status"} className={status.kind === "error" ? "duplicate-cleanup-error" : undefined}>{status.text}</p>}
  </section>;
}
