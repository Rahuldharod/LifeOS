// The Calendar view's data: the day's events, the offline state (#88), the whole-request-failed
// state (PB-022a), the calendar list and the synced preferences (which calendars are shown, which
// one opens by default). App reads the result and calls `syncDay`, `retry`, `savePrefs`; nothing
// else touches this state. `call` is the API seam (tests pass a fake).
import { useEffect, useRef, useState } from "react";
import type { CalendarDay, CalendarEvent, CalendarOffline, CalendarOption, CalendarPreferences as CalendarPrefs } from "@lifeos/contracts";
import { api, ApiError, type Api } from "./api.js";
import { CalendarStillOfflineError, retryCalendarDay } from "./CalendarOffline.js";
import { enabledCalendars, noCalendarPrefs, reconcileFilter, resolveDefaultFilter } from "./calendarPrefs.js";
import { dayRange } from "./zonedTime.js";

export type UseCalendarOptions = {
  selectedDate: string;
  displayTimeZone: string;
  /** The day could not be loaded at all; `text` is the message to show in the page status line. */
  onFailure: (text: string) => void;
  /** Google rejected the saved access (offline "auth" or a 401): refresh the connection status so Reconnect shows. */
  onGoogleStatusStale: () => void;
  call?: Api;
};

export type Calendar = {
  events: CalendarEvent[];
  /** Events for the selected calendar, earliest first. */
  filteredEvents: CalendarEvent[];
  allDayEvents: CalendarEvent[];
  timedEvents: CalendarEvent[];
  /** #88: the calendar could not be read; `events` are the meetings already in LifeOS. */
  offline: CalendarOffline | undefined;
  /** PB-022a: the whole request failed; shown instead of an "empty day". */
  error: string | undefined;
  /** "all" or a calendar id. */
  filter: string;
  setFilter: (value: string) => void;
  /** Calendars in the drop-down. */
  offered: CalendarOption[];
  catalog: CalendarOption[];
  catalogLoaded: boolean;
  prefs: CalendarPrefs;
  loadCatalog: () => Promise<void>;
  /** Resolves to an error message, or undefined on success. */
  savePrefs: (next: CalendarPrefs) => Promise<string | undefined>;
  /** Reads the calendar again (asking the Keychain first after a denial). Rejects while still offline. */
  retry: (steps: { reprobeKeychain: () => Promise<unknown> }) => Promise<void>;
  /** Syncs the selected day from Google and shows it. A failed request becomes `error` and rethrows. */
  syncDay: () => Promise<CalendarDay>;
  /** Patches events in place (a note was created or removed for one of them). */
  updateEvents: (change: (current: CalendarEvent[]) => CalendarEvent[]) => void;
};

export function useCalendar({ selectedDate, displayTimeZone, onFailure, onGoogleStatusStale, call = api }: UseCalendarOptions): Calendar {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string>();
  const [offline, setOffline] = useState<CalendarOffline>();
  const [filter, setFilter] = useState("all");
  const [sources, setSources] = useState<Record<string, { name: string; color?: string }>>({});
  const [catalog, setCatalog] = useState<CalendarOption[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [prefs, setPrefs] = useState<CalendarPrefs>(noCalendarPrefs);
  const defaultFilterApplied = useRef(false);
  const latest = useRef({ onFailure, onGoogleStatusStale });
  latest.current = { onFailure, onGoogleStatusStale };

  // Preferences live in the synced data folder; the calendar list comes from Google. Either may fail independently.
  const loadCatalog = async () => {
    const [nextCatalog, nextPrefs] = await Promise.all([
      call("GET /api/v1/calendar/calendars").catch(() => [] as CalendarOption[]),
      call("GET /api/v1/settings/calendar-preferences").catch(() => undefined)
    ]);
    setCatalog(nextCatalog);
    if (nextPrefs) setPrefs(nextPrefs);
    setCatalogLoaded(true);
  };

  const savePrefs = async (next: CalendarPrefs): Promise<string | undefined> => {
    try {
      setPrefs(await call("PUT /api/v1/settings/calendar-preferences", { body: { ...next, expectedHash: prefs.contentHash } }));
      return undefined;
    } catch (failure) {
      await loadCatalog();
      return failure instanceof ApiError && failure.status === 409 ? "These preferences were changed on another device. The latest version is loaded; make your change again." : failure instanceof Error ? failure.message : "Could not save calendar preferences";
    }
  };

  /** #88: an unreadable calendar answers with the meetings already in LifeOS and an offline state, not an error. */
  const showDay = (day: CalendarDay) => {
    setEvents(day.events);
    setError(undefined);
    setOffline(day.offline);
    if (day.offline?.reason === "auth") latest.current.onGoogleStatusStale();
  };

  const loadDay = async () => {
    const day = await call("GET /api/v1/calendar/day", { query: dayRange(selectedDate, displayTimeZone) });
    showDay(day);
    setSources((current) => {
      const next = { ...current };
      if (!day.offline) for (const event of day.events) if (event.calendarId) next[event.calendarId] = { name: event.calendarName ?? event.calendarId, color: event.calendarColor };
      return next;
    });
    return day;
  };

  const failed = (failure: unknown) => {
    const text = failure instanceof Error ? failure.message : "Calendar could not be loaded";
    setEvents([]);
    setOffline(undefined);
    setError(text);
    // A 401 means Google rejected the tokens; refresh status so the Reconnect banner appears.
    if (failure instanceof ApiError && failure.status === 401) latest.current.onGoogleStatusStale();
    return text;
  };

  const syncDay = async () => {
    let day: CalendarDay;
    try { day = await call("POST /api/v1/calendar/day/sync", { query: dayRange(selectedDate, displayTimeZone) }); }
    catch (failure) { failed(failure); throw failure; }
    showDay(day);
    return day;
  };

  const retry: Calendar["retry"] = async ({ reprobeKeychain }) => {
    try { await retryCalendarDay(offline, { reprobeKeychain, loadDay }); }
    catch (failure) {
      if (!(failure instanceof CalendarStillOfflineError)) failed(failure);
      throw failure;
    }
  };

  useEffect(() => { void loadCatalog(); }, []);

  useEffect(() => {
    loadDay().catch((failure: unknown) => latest.current.onFailure(failed(failure)));
  }, [selectedDate, displayTimeZone]);

  const offered: CalendarOption[] = catalog.length
    ? enabledCalendars(catalog, prefs)
    : Object.entries(sources).map(([id, source]) => ({ id, name: source.name, color: source.color })).filter((calendar) => !prefs.disabledCalendarIds.includes(calendar.id));

  // Open on the default calendar once the list is known; afterwards only drop a selection that is no longer offered.
  useEffect(() => {
    if (!catalogLoaded) return;
    if (!defaultFilterApplied.current) {
      defaultFilterApplied.current = true;
      setFilter(resolveDefaultFilter(offered, prefs));
    } else setFilter((current) => reconcileFilter(current, offered));
  }, [catalogLoaded, catalog, prefs]);

  const filteredEvents = events
    .filter((event) => !event.calendarId || !prefs.disabledCalendarIds.includes(event.calendarId))
    .filter((event) => filter === "all" || event.calendarId === filter)
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));

  return {
    events, filteredEvents,
    allDayEvents: filteredEvents.filter((event) => event.isAllDay),
    timedEvents: filteredEvents.filter((event) => !event.isAllDay),
    offline, error, filter, setFilter, offered, catalog, catalogLoaded, prefs,
    loadCatalog, savePrefs, retry, syncDay, updateEvents: setEvents
  };
}
