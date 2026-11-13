// #230: People settings filters, selection bar and the bulk-action panel. The rules live in peopleBulkRules.ts.
import React, { useState } from "react";
import type { LifeObject } from "@lifeos/contracts";
import { bulkActionLabels, bulkApplies, describeBulkResult, type BulkResult, type PeopleBulkAction, type PeopleFilters } from "./peopleBulkRules.js";

export function PeopleFilterBar({ filters, onChange }: { filters: PeopleFilters; onChange: (filters: PeopleFilters) => void }) {
  const set = <K extends keyof PeopleFilters>(key: K, value: PeopleFilters[K]) => onChange({ ...filters, [key]: value });
  return <fieldset className="people-filters">
    <legend>Filter people</legend>
    <label><small>Review status</small><select aria-label="Review status filter" value={filters.review} onChange={(event) => set("review", event.target.value as PeopleFilters["review"])}>
      <option value="all">All</option><option value="unreviewed">Unreviewed</option><option value="reviewed">Reviewed</option></select></label>
    <label><small>Internal / External</small><select aria-label="Internal or external filter" value={filters.side} onChange={(event) => set("side", event.target.value as PeopleFilters["side"])}>
      <option value="all">All</option><option value="internal">Internal</option><option value="external">External</option></select></label>
    <label><small>Type</small><select aria-label="Type filter" value={filters.kind} onChange={(event) => set("kind", event.target.value as PeopleFilters["kind"])}>
      <option value="person">Person</option><option value="not-a-person">Not a person</option><option value="all">All</option></select></label>
  </fieldset>;
}

export function PeopleSelectionBar({ shown, selected, disabled, stacked, onSelectAll, onDeselectAll, onShowActions }: { shown: number; selected: number; disabled: boolean; stacked: boolean; onSelectAll: () => void; onDeselectAll: () => void; onShowActions: () => void }) {
  return <div className="people-selection">
    <span>{selected ? `${selected} selected` : `${shown} shown`}</span>
    <button type="button" className="link-button" disabled={disabled || !shown || selected === shown} onClick={onSelectAll}>Select all</button>
    <button type="button" className="link-button" disabled={disabled || !selected} onClick={onDeselectAll}>Deselect all</button>
    {stacked && selected > 0 && <button type="button" onClick={onShowActions}>Actions…</button>}
  </div>;
}

const groups: PeopleBulkAction[][] = [["internal", "external"], ["person", "not-a-person"], ["confirm"], ["archive", "delete"]];
const needsConfirmation = (action: PeopleBulkAction): action is "archive" | "delete" => action === "archive" || action === "delete";
const names = (people: LifeObject[]) => {
  const titles = people.map((person) => String(person.frontmatter.title));
  return titles.length > 5 ? `${titles.slice(0, 5).join(", ")} and ${titles.length - 5} more` : titles.join(", ");
};

/** The right-hand panel while people are selected. Archive and Delete ask first; the other actions run at once. */
export function PeopleBulkPanel({ selected, busy, readOnly, result, onRun, onBack }: { selected: LifeObject[]; busy: boolean; readOnly: boolean; result?: BulkResult; onRun: (action: PeopleBulkAction, people: LifeObject[]) => void; onBack?: () => void }) {
  const [confirming, setConfirming] = useState<"archive" | "delete">();
  const applies = (action: PeopleBulkAction) => selected.filter((person) => bulkApplies(action, person));
  const choose = (action: PeopleBulkAction) => needsConfirmation(action) ? setConfirming(action) : onRun(action, selected);
  const targets = confirming ? applies(confirming) : [];
  return <div className="people-bulk">
    <header className="reference-record-header">{onBack && <button className="reference-back" onClick={onBack}>Back to people</button>}<div><span>SELECTED PEOPLE</span><h3 data-detail-heading tabIndex={-1}>{selected.length} {selected.length === 1 ? "person" : "people"} selected</h3></div></header>
    <p className="people-bulk-names">{names(selected)}</p>
    {groups.map((group) => <div className="people-bulk-group" key={group.join()}>{group.map((action) => {
      const count = applies(action).length;
      return <button type="button" key={action} className={action === "delete" ? "danger" : undefined} disabled={busy || readOnly || !count} aria-label={`${bulkActionLabels[action].replace("…", "")} (${count} of ${selected.length})`} onClick={() => choose(action)}>{bulkActionLabels[action]} <small>{count}</small></button>;
    })}</div>)}
    <p className="people-bulk-hint">The number on each button is how many selected people it changes. You are never changed in bulk, and people already in that state are skipped.</p>
    {result && <PeopleBulkResult result={result} />}
    {confirming && <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="people-bulk-confirm-title" className="leave-dialog" onKeyDown={(event) => { if (event.key === "Escape") setConfirming(undefined); }}>
      <h3 id="people-bulk-confirm-title">{confirming === "archive" ? "Archive" : "Delete"} {targets.length} {targets.length === 1 ? "person" : "people"}?</h3>
      <p>{names(targets)}</p>
      <p>{confirming === "archive"
        ? "They leave lists and pickers, and their Markdown files are kept. There is no Unarchive button yet."
        : "They move to the deleted state. Their Markdown files are kept, but they no longer appear anywhere in LifeOS."}</p>
      <div><button className={confirming === "delete" ? "danger" : "primary"} disabled={busy} onClick={() => { const action = confirming; setConfirming(undefined); onRun(action, selected); }}>{confirming === "archive" ? "Archive" : "Delete"}</button><button autoFocus onClick={() => setConfirming(undefined)}>Cancel</button></div>
    </section></div>}
  </div>;
}

export function PeopleBulkResult({ result }: { result: BulkResult }) {
  return <div className="people-bulk-result" role="status">
    <p>{describeBulkResult(result)}</p>
    {result.failed.length > 0 && <ul>{result.failed.map((failure) => <li key={failure.title}><b>{failure.title}</b>: {failure.error}</li>)}</ul>}
  </div>;
}
