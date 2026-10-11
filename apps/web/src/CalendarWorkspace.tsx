import React, { Fragment, type ReactNode } from "react";
import type { CalendarEvent, CalendarOffline, CalendarOption } from "@lifeos/contracts";
import { CalendarOfflineBanner } from "./CalendarOffline.js";
import { useSplitPane } from "./splitPane.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";
import { zonedDateTime } from "./zonedTime.js";

function formatEventTime(value: string, timeZone: string) {
  return new Date(value).toLocaleTimeString([], { timeZone, hour: "2-digit", minute: "2-digit" });
}

function formatGap(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000); const hours = Math.floor(minutes / 60); const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ""} free` : `${minutes}m free`;
}

export function CalendarWorkspace({ selectedDate, displayTimeZone, events, offline, error, loading, filter, offered, busy, readOnly, detailOpen, detailKey, onPreviousDay, onToday, onNextDay, onDateChange, onFilterChange, onRetry, onSelectEvent, onBack, children }: {
  selectedDate: string; displayTimeZone: string; events: CalendarEvent[]; offline?: CalendarOffline; error?: string; loading: boolean;
  filter: string; offered: CalendarOption[]; busy: boolean; readOnly: boolean; detailOpen: boolean; detailKey?: string;
  onPreviousDay: () => void; onToday: () => void; onNextDay: () => void; onDateChange: (date: string) => void; onFilterChange: (calendarId: string) => void;
  onRetry: () => void; onSelectEvent: (event: CalendarEvent) => void; onBack: () => void; children: ReactNode;
}) {
  const split = useSplitPane("calendar"); const narrow = useNarrowWorkspace();
  const ref = useListDetailReturn(detailOpen ? detailKey ?? "open" : undefined);
  const allDayEvents = events.filter((event) => event.isAllDay); const timedEvents = events.filter((event) => !event.isAllDay);
  const dateLabel = zonedDateTime(selectedDate, "12:00", displayTimeZone).toLocaleDateString([], { dateStyle: "full", timeZone: displayTimeZone });
  return <div ref={ref} className={`calendar-workspace pane-workspace${detailOpen ? " detail-open" : ""}`} data-workspace="calendar" style={split.style}>
    <article className="event-list" data-pane="list" aria-label="Calendar timeline" hidden={narrow && detailOpen}>
      <div className="calendar-workspace-controls" aria-label="Calendar day controls">
        <div className="calendar-day-buttons"><button type="button" aria-label="Previous day" onClick={onPreviousDay}>Previous day</button><button type="button" onClick={onToday}>Today</button><button type="button" aria-label="Next day" onClick={onNextDay}>Next day</button></div>
        <div className="calendar-controls"><label><small>Date</small><input type="date" value={selectedDate} onChange={(event) => { if (event.target.value) onDateChange(event.target.value); }} /></label><label><small>Calendar</small><select value={filter} onChange={(event) => onFilterChange(event.target.value)}><option value="all">All calendars</option>{[...offered].sort((left, right) => left.name.localeCompare(right.name)).map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}</select></label></div>
      </div>
      <h3 className="timeline-date">{dateLabel}</h3>
      <CalendarOfflineBanner offline={offline} timeZone={displayTimeZone} busy={busy} onRetry={onRetry} />
      {loading ? <div className="timeline-empty" role="status"><b>Loading calendar…</b><small>Reading this day from the local LifeOS service.</small></div>
        : error ? <div className="timeline-empty timeline-error" role="alert"><b>Calendar could not be loaded</b><small>{error}</small></div>
        : !events.length && offline ? <div className="timeline-empty"><b>No meetings found in LifeOS</b><small>Events not previously opened in LifeOS are unavailable while Calendar is offline.</small></div>
        : !events.length ? <div className="timeline-empty"><b>No events</b><small>This calendar is clear for the selected day.</small></div> : null}
      {!loading && !error && <div className="timeline">
        {allDayEvents.map((event) => <TimelineEvent event={event} displayTimeZone={displayTimeZone} busy={busy} allDay onSelect={onSelectEvent} key={`${event.calendarId ?? "calendar"}:${event.externalId}`} />)}
        {timedEvents.map((event, index) => { const previousEnd = index ? Math.max(...timedEvents.slice(0, index).map((candidate) => Date.parse(candidate.endsAt))) : undefined; const gap = previousEnd === undefined ? 0 : Date.parse(event.startsAt) - previousEnd; return <Fragment key={`${event.calendarId ?? "calendar"}:${event.externalId}`}>{gap > 60_000 && <div className="timeline-gap"><span /><span className="gap-rail">•••</span><small>{formatGap(gap)}</small></div>}<TimelineEvent event={event} displayTimeZone={displayTimeZone} busy={busy} onSelect={onSelectEvent} /></Fragment>; })}
      </div>}
    </article>
    {!narrow && <div {...split.dividerProps} />}
    <div className="meeting-main" data-pane="detail" role="region" aria-label="Meeting detail" hidden={narrow && !detailOpen}>
      {detailOpen && <div className="calendar-detail-tools"><button type="button" className="narrow-back" onClick={onBack}>Back to calendar</button>{readOnly && <span role="status">Read-only on this Mac</span>}</div>}
      {children}
    </div>
  </div>;
}

function TimelineEvent({ event, displayTimeZone, busy, allDay = false, onSelect }: { event: CalendarEvent; displayTimeZone: string; busy: boolean; allDay?: boolean; onSelect: (event: CalendarEvent) => void }) {
  const time = allDay ? "All day" : formatEventTime(event.startsAt, displayTimeZone);
  return <div className="timeline-row"><span className="timeline-time">{time}</span><span className="timeline-rail"><i style={{ background: event.calendarColor ?? "var(--color-selection)" }} /></span><button type="button" aria-label={`Open event: ${event.title}`} className={`event${event.hasNote ? " has-note" : ""}`} disabled={busy} onClick={() => onSelect(event)}><span className="event-title"><b>{event.title}</b>{event.hasNote && <span className="note-badge">✓ Note created</span>}</span><small>{allDay ? event.calendarName ?? "Calendar" : `${formatEventTime(event.startsAt, displayTimeZone)}–${formatEventTime(event.endsAt, displayTimeZone)} · ${event.calendarName ?? "Calendar"}`}</small>{!allDay && <small>{event.attendees.length ? `${event.attendees.length} attendee${event.attendees.length === 1 ? "" : "s"}` : "No attendees"}</small>}</button></div>;
}
