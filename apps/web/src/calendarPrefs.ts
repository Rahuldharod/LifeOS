import type { CalendarOption, CalendarPreferences as CalendarPrefs } from "@lifeos/contracts";

/** Calendar preferences, stored in the synced data folder (settings/calendar-preferences.md) so every device shares them. */
export const noCalendarPrefs: CalendarPrefs = { disabledCalendarIds: [] };

/** Calendars offered in the Calendar view's drop-down: everything the account can view, minus the ones switched off. */
export function enabledCalendars(catalog: CalendarOption[], prefs: CalendarPrefs) {
  return catalog.filter((calendar) => !prefs.disabledCalendarIds.includes(calendar.id));
}

/** The default calendar if it is still enabled and visible to the account; otherwise "all". */
export function resolveDefaultFilter(enabled: CalendarOption[], prefs: CalendarPrefs) {
  return prefs.defaultCalendarId && enabled.some((calendar) => calendar.id === prefs.defaultCalendarId) ? prefs.defaultCalendarId : "all";
}

/** Keeps the current selection when it is still offered, otherwise falls back to "all". */
export function reconcileFilter(current: string, enabled: CalendarOption[]) {
  return current === "all" || enabled.some((calendar) => calendar.id === current) ? current : "all";
}
