import React, { useEffect, useId, useRef, useState } from "react";
import { searchOptions, type SearchOption } from "./searchOptions.js";
import { bulkFieldLabel, priorities, sharedValue, type BulkFieldKey } from "./bulkEditModel.js";
import type { InboxReview, ReviewChoices } from "./inboxModel.js";

const dayLabel = (value: string) => {
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`)) : value;
};
/** What "no value" reads as: a proposal without an owner is the user's own. */
const emptyLabel = (key: BulkFieldKey) => key === "owner_person_id" ? "Me" : key === "due_on" ? "No due date" : "None";

/**
 * PB-043 Bulk edit: one button per field the ticked items share, in the bulk bar. Each opens a small picker; the value picked
 * is set on every ticked item that has the field. Keyboard: Enter or Space opens, type to filter, ↑/↓ move, Enter applies,
 * Esc closes. Keys inside a picker never reach the Inbox keys. `disabled` (a read-only Mac) switches the buttons off; `pending`
 * (a save is running) only makes them inert, so keyboard focus stays on the button just used.
 */
export function InboxBulkEdit({ items, fields, choices, personName, contextName, disabled, pending, onApply }: {
  items: InboxReview[]; fields: BulkFieldKey[]; choices: ReviewChoices;
  personName: (id: string) => string | undefined; contextName: (id: string) => string | undefined;
  disabled: boolean; pending: boolean; onApply: (key: BulkFieldKey, value: string) => void;
}) {
  const [openKey, setOpenKey] = useState<BulkFieldKey>();
  useEffect(() => { if (disabled || pending || (openKey && !fields.includes(openKey))) setOpenKey(undefined); }, [disabled, pending, fields, openKey]);
  if (!fields.length) return null;
  const nameOf = (key: BulkFieldKey, value: string) => {
    if (!value) return emptyLabel(key);
    if (key === "owner_person_id") return personName(value) ?? "Unknown person";
    if (key === "due_on") return dayLabel(value);
    if (key === "priority") return value;
    return contextName(value) ?? `Unknown ${bulkFieldLabel[key].toLowerCase()}`;
  };
  const optionsFor = (key: BulkFieldKey): SearchOption[] => {
    if (key === "owner_person_id") return choices.people.map((person) => ({ id: person.id, title: personName(person.id) ?? person.title }));
    if (key === "priority") return priorities.map((value) => ({ id: value, title: value }));
    return choices[key === "primary_project_id" ? "projects" : key === "primary_client_id" ? "clients" : "products"];
  };
  return <span className="inbox-bulk-edit" role="group" aria-label="Set a field on the selected proposals">
    {fields.map((key) => {
      const shared = sharedValue(items, key);
      return <BulkFieldPicker key={key} field={key} label={bulkFieldLabel[key]} current={shared === undefined ? "Mixed" : nameOf(key, shared)} sharedValue={shared}
        options={key === "due_on" ? [] : optionsFor(key)} emptyLabel={emptyLabel(key)} searchable={key !== "priority" && key !== "due_on"}
        open={openKey === key} disabled={disabled} pending={pending} onOpen={(open) => setOpenKey(open ? key : undefined)} onApply={(value) => { setOpenKey(undefined); onApply(key, value); }} />;
    })}
  </span>;
}

function BulkFieldPicker({ field, label, current, sharedValue, options, emptyLabel, searchable, open, disabled, pending, onOpen, onApply }: {
  field: BulkFieldKey; label: string; current: string; sharedValue?: string; options: SearchOption[]; emptyLabel: string; searchable: boolean;
  open: boolean; disabled: boolean; pending: boolean; onOpen: (open: boolean) => void; onApply: (value: string) => void;
}) {
  const root = useRef<HTMLSpanElement>(null); const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [query, setQuery] = useState(""); const [active, setActive] = useState(0); const [day, setDay] = useState("");
  const rows: SearchOption[] = [...(query.trim() ? [] : [{ id: "", title: emptyLabel }]), ...(searchable ? searchOptions(options, query) : options)];
  useEffect(() => { if (!open) { setQuery(""); setDay(""); return; } setActive(0); }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) onOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, onOpen]);
  /** Esc closes and gives focus back to the field's button. */
  const close = () => { onOpen(false); button.current?.focus(); };
  const apply = (value: string) => { onApply(value); button.current?.focus(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation(); // the Inbox keys (A, R, X, ↑/↓, 1–6, Esc) must not act while a picker is open
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") { onOpen(false); return; }
    if (field === "due_on") { if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") { event.preventDefault(); if (day) apply(day); } return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, rows.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(rows.length - 1); }
    else if (event.key === "Enter") { event.preventDefault(); const row = rows[active]; if (row) apply(row.id); }
  };
  const activeId = rows[active] ? `${listId}-${active}` : undefined;
  const list = <ul className="search-select-list inbox-bulk-list" role="listbox" id={listId} aria-label={label} tabIndex={searchable ? -1 : 0} aria-activedescendant={searchable ? undefined : activeId} ref={(node) => { if (node && !searchable && open && globalThis.document.activeElement === button.current) node.focus(); }}>
    {rows.length === 0 && <li className="empty" role="presentation">No match</li>}
    {rows.map((option, index) => <li key={option.id || "none"} id={`${listId}-${index}`} role="option" aria-selected={sharedValue === option.id} className={index === active ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); apply(option.id); }} onMouseEnter={() => setActive(index)}>{option.title}</li>)}
  </ul>;
  return <span className="inbox-bulk-field" ref={root} onKeyDown={open ? onKeyDown : undefined}>
    <button ref={button} type="button" aria-haspopup={field === "due_on" ? "dialog" : "listbox"} aria-expanded={open} disabled={disabled} aria-disabled={pending || undefined} title={`Set ${label} on every selected proposal that has it`} onClick={() => { if (!pending) onOpen(!open); }}>
      {label}: <b className={current === "Mixed" ? "mixed" : undefined}>{current}</b> <span aria-hidden>▾</span>
    </button>
    {open && <span className="inbox-bulk-popover">
      {field === "due_on" ? <span className="inbox-bulk-due" role="group" aria-label={`Set ${label}`}>
        <input type="date" aria-label="Due date" autoFocus value={day} onChange={(event) => setDay(event.target.value)} />
        <button type="button" className="primary" disabled={!day} onClick={() => apply(day)}>Apply</button>
        <button type="button" onClick={() => apply("")}>{emptyLabel}</button>
      </span> : <>
        {searchable && <input className="inbox-bulk-search" role="combobox" aria-label={`Find ${label.toLowerCase()}`} placeholder={`Find ${label.toLowerCase()}…`} autoFocus aria-expanded aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId} value={query} onChange={(event) => setQuery(event.target.value)} />}
        {list}
      </>}
    </span>}
  </span>;
}
