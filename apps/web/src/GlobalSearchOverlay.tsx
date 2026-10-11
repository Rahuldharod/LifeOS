import React, { useEffect, useMemo, useState } from "react";
import type { CalendarEvent, CalendarOffline, LifeObject } from "@lifeos/contracts";
import type { Route } from "./routes.js";
import { globalSearchResults, readRecentSearchIds, recordRecentSearchId, type GlobalSearchItem } from "./globalSearch.js";
import { OverlayDialog } from "./OverlayDialog.js";

function SearchGroup({ label, items, expanded, onExpand, onChoose, limited, unavailable }: { label: "Tasks" | "Calendar" | "Notes"; items: GlobalSearchItem[]; expanded: boolean; onExpand: () => void; onChoose: (item: GlobalSearchItem) => void; limited?: boolean; unavailable?: boolean }) {
  const limit = expanded ? 20 : 5;
  return <section className="global-search-group" data-search-group={label} aria-labelledby={`search-${label.toLowerCase()}`}>
    <h3 id={`search-${label.toLowerCase()}`}>{label}</h3>
    {limited && <p className="muted" role="status">Calendar search is limited to meetings already in LifeOS while offline.</p>}
    {unavailable && <p className="muted" role="status">Calendar search is unavailable while LifeOS reconnects.</p>}
    {!items.length && !unavailable && <p className="muted">No {label.toLowerCase()} found.</p>}
    {items.slice(0, limit).map((item) => <button type="button" className="global-search-result" key={item.id} onClick={() => onChoose(item)}>
      <span><b>{item.title}</b><small>{item.kind}</small></span><span aria-hidden="true">›</span>
    </button>)}
    {!expanded && items.length > 5 && <button type="button" className="global-search-more" onClick={onExpand}>Show more {label.toLowerCase()}</button>}
  </section>;
}

export function GlobalSearchOverlay({ open, tasks, notes, calendar = [], calendarOffline, calendarUnavailable, timeZone = "UTC", onClose, onOpen }: { open: boolean; tasks: LifeObject[]; notes: LifeObject[]; calendar?: CalendarEvent[]; calendarOffline?: CalendarOffline; calendarUnavailable?: boolean; timeZone?: string; onClose: () => void; onOpen: (route: Route) => void }) {
  const [query, setQuery] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [expanded, setExpanded] = useState({ Tasks: false, Calendar: false, Notes: false });
  useEffect(() => {
    if (!open) return;
    setQuery(""); setExpanded({ Tasks: false, Calendar: false, Notes: false }); setRecentIds(readRecentSearchIds());
  }, [open]);
  const groups = useMemo(() => globalSearchResults({ tasks, notes, calendar, query, recentIds, timeZone }), [tasks, notes, calendar, query, recentIds, timeZone]);
  const choose = (item: GlobalSearchItem) => {
    recordRecentSearchId(item.id);
    onClose();
    onOpen(item.route);
  };
  return <OverlayDialog open={open} label="Global Search" onClose={onClose}>
    <header className="global-search-header"><div><span>GLOBAL SEARCH</span><h2>Find your work</h2></div><button type="button" aria-label="Close Search" onClick={onClose}>×</button></header>
    <input data-overlay-autofocus autoComplete="off" aria-label="Search LifeOS" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks, calendar and notes…" />
    {!query.trim() && <p className="global-search-hint">Recently opened</p>}
    <div className="global-search-groups">
      <SearchGroup label="Tasks" items={groups.tasks} expanded={expanded.Tasks} onExpand={() => setExpanded((value) => ({ ...value, Tasks: true }))} onChoose={choose} />
      <SearchGroup label="Calendar" items={groups.calendar} expanded={expanded.Calendar} onExpand={() => setExpanded((value) => ({ ...value, Calendar: true }))} onChoose={choose} limited={Boolean(calendarOffline)} unavailable={calendarUnavailable} />
      <SearchGroup label="Notes" items={groups.notes} expanded={expanded.Notes} onExpand={() => setExpanded((value) => ({ ...value, Notes: true }))} onChoose={choose} />
    </div>
  </OverlayDialog>;
}
