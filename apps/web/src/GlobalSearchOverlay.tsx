import React, { useEffect, useMemo, useState } from "react";
import type { LifeObject } from "@lifeos/contracts";
import type { Route } from "./routes.js";
import { globalSearchResults, readRecentSearchIds, type GlobalSearchItem } from "./globalSearch.js";
import { OverlayDialog } from "./OverlayDialog.js";

function SearchGroup({ label, items, expanded, onExpand, onChoose }: { label: "Tasks" | "Notes"; items: GlobalSearchItem[]; expanded: boolean; onExpand: () => void; onChoose: (item: GlobalSearchItem) => void }) {
  const limit = expanded ? 20 : 5;
  return <section className="global-search-group" data-search-group={label} aria-labelledby={`search-${label.toLowerCase()}`}>
    <h3 id={`search-${label.toLowerCase()}`}>{label}</h3>
    {!items.length && <p className="muted">No {label.toLowerCase()} found.</p>}
    {items.slice(0, limit).map((item) => <button type="button" className="global-search-result" key={item.id} onClick={() => onChoose(item)}>
      <span><b>{item.title}</b><small>{item.kind}</small></span><span aria-hidden="true">›</span>
    </button>)}
    {!expanded && items.length > 5 && <button type="button" className="global-search-more" onClick={onExpand}>Show more {label.toLowerCase()}</button>}
  </section>;
}

export function GlobalSearchOverlay({ open, tasks, notes, onClose, onOpen }: { open: boolean; tasks: LifeObject[]; notes: LifeObject[]; onClose: () => void; onOpen: (route: Route) => void }) {
  const [query, setQuery] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [expanded, setExpanded] = useState({ Tasks: false, Notes: false });
  useEffect(() => {
    if (!open) return;
    setQuery(""); setExpanded({ Tasks: false, Notes: false }); setRecentIds(readRecentSearchIds());
  }, [open]);
  const groups = useMemo(() => globalSearchResults({ tasks, notes, query, recentIds }), [tasks, notes, query, recentIds]);
  const choose = (item: GlobalSearchItem) => {
    onClose();
    onOpen(item.kind === "Task" ? { view: "Tasks", id: item.id } : { view: "Notes", noteTab: "open", id: item.id });
  };
  return <OverlayDialog open={open} label="Global Search" onClose={onClose}>
    <header className="global-search-header"><div><span>GLOBAL SEARCH</span><h2>Find your work</h2></div><button type="button" aria-label="Close Search" onClick={onClose}>×</button></header>
    <input data-overlay-autofocus autoComplete="off" aria-label="Search LifeOS" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks and notes…" />
    {!query.trim() && <p className="global-search-hint">Recently opened</p>}
    <div className="global-search-groups">
      <SearchGroup label="Tasks" items={groups.tasks} expanded={expanded.Tasks} onExpand={() => setExpanded((value) => ({ ...value, Tasks: true }))} onChoose={choose} />
      <SearchGroup label="Notes" items={groups.notes} expanded={expanded.Notes} onExpand={() => setExpanded((value) => ({ ...value, Notes: true }))} onChoose={choose} />
    </div>
  </OverlayDialog>;
}
