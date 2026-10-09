// Searchable dropdown for the note header (PB-006). Single mode picks one option (or none);
// multi mode builds a list of chips. Follows the ARIA combobox pattern: arrow keys move, Enter
// picks, Escape closes, typing filters.
import React, { useEffect, useId, useRef, useState } from "react";
import { ExtSuffix } from "./PersonName.js";
import { searchOptions, type SearchOption } from "./searchOptions.js";

// `describe` labels a stored value that is not offered as an option (PB-010: an archived or missing
// link keeps its stored name and a tag). `clearable: false` drops the "Not linked" row for a required link.
type Common = { label: string; options: SearchOption[]; disabled?: boolean; placeholder?: string; describe?: (id: string) => SearchOption | undefined; clearable?: boolean };
export type SearchSelectProps = Common & (
  | { multi?: false; value: string; onChange: (value: string) => void }
  | { multi: true; value: string[]; onChange: (value: string[]) => void }
);

export function SearchSelect(props: SearchSelectProps) {
  const { label, options, disabled, placeholder, describe, clearable = true } = props;
  const selected = props.multi ? props.value : props.value ? [props.value] : [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionOf = (id: string) => options.find((option) => option.id === id) ?? describe?.(id);
  const titleOf = (id: string) => optionOf(id)?.title ?? "Unknown (removed)";
  const tagOf = (id: string) => optionOf(id)?.tag;
  /** Full text, suffix and tag included, where styling is impossible (input value, aria-label). */
  const textOf = (id: string) => titleOf(id) + (optionOf(id)?.suffix ?? "") + (tagOf(id) ? ` (${tagOf(id)})` : "");
  const matches = searchOptions(options, query, props.multi ? selected : []);
  // Single mode offers "Not linked" first, so a link can be cleared from the same list.
  const rows: SearchOption[] = props.multi || query.trim() || !clearable ? matches : [{ id: "", title: "Not linked" }, ...matches];

  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setQuery(""); } };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function pick(option: SearchOption | undefined) {
    if (!option) return;
    if (props.multi) { props.onChange([...props.value, option.id]); setQuery(""); }
    else { if (option.id !== props.value) props.onChange(option.id); setOpen(false); setQuery(""); }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((index) => Math.min(index + 1, rows.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === "Enter" && open) { event.preventDefault(); pick(rows[active]); }
    else if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); setQuery(""); }
    else if (event.key === "Backspace" && props.multi && !query && props.value.length) props.onChange(props.value.slice(0, -1));
  }

  const shown = open ? query : props.multi ? "" : selected[0] ? textOf(selected[0]) : "";
  return (
    <div className={`search-select${props.multi ? " multi" : ""}`} ref={root}>
      <small>{label}</small>
      <div className="search-select-box">
        {props.multi && props.value.map((id) => <span className="chip" key={id}>{titleOf(id)}<ExtSuffix suffix={optionOf(id)?.suffix} /><LinkTag tag={tagOf(id)} /><button type="button" disabled={disabled} aria-label={`Remove ${textOf(id)}`} onClick={() => props.onChange(props.value.filter((candidate) => candidate !== id))}>×</button></span>)}
        <input
          role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined}
          disabled={disabled} value={shown} placeholder={props.multi ? (props.value.length ? "Add…" : placeholder ?? "Add…") : selected[0] ? "" : placeholder ?? "Not linked"}
          onFocus={(event) => { setOpen(true); if (!props.multi) event.currentTarget.select(); }}
          onChange={(event) => { setOpen(true); setQuery(event.target.value); }}
          onKeyDown={onKeyDown}
        />
        {!props.multi && !open && selected[0] && <LinkTag tag={tagOf(selected[0])} />}
      </div>
      {open && <ul className="search-select-list" role="listbox" id={listId}>
        {rows.length === 0 && <li className="empty" role="presentation">No match</li>}
        {rows.map((option, index) => <li key={option.id || "none"} id={`${listId}-${index}`} role="option" aria-selected={selected.includes(option.id) || (!props.multi && !props.value && option.id === "")} className={index === active ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); pick(option); }} onMouseEnter={() => setActive(index)}>{option.title}<ExtSuffix suffix={option.suffix} /></li>)}
      </ul>}
    </div>
  );
}

/** "archived" or "missing" beside a stored link whose target is no longer live (PB-010), in words, not colour alone. */
function LinkTag({ tag }: { tag?: string }) {
  return tag ? <span className="link-tag" title={`This link points at a ${tag} object; it is kept until you change it`}>{tag}</span> : null;
}
