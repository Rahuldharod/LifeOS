// #88 (PRD story 86, PB-022b): when Google Calendar cannot be read, Today and the Calendar view list the meetings
// already stored in LifeOS under this banner, with a Retry that reloads the calendar without a page reload.
import React from "react";

export type CalendarOfflineReason = "network" | "auth" | "keychain-denied";
export type CalendarOffline = { reason: CalendarOfflineReason; error: string; lastSuccessfulSyncAt?: string };
/** `GET /api/v1/calendar/day` and `POST /api/v1/calendar/day/sync`. */
export type CalendarDay<Event> = { events: Event[]; offline?: CalendarOffline };

const reasonText: Record<CalendarOfflineReason, string> = {
  network: "Google Calendar could not be reached",
  auth: "Google no longer accepts the saved access; reconnect Google Calendar",
  "keychain-denied": "Keychain access was denied, so LifeOS cannot read the Google Calendar sign-in"
};

/** "Offline: showing meetings already in LifeOS (last synced 5 Oct 2026, 09:00)". */
export function calendarOfflineText(offline: CalendarOffline, timeZone?: string) {
  const at = offline.lastSuccessfulSyncAt;
  let when = "never";
  if (at) {
    try { when = new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }); }
    catch { when = new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
  }
  return `Offline: showing meetings already in LifeOS (last synced ${when})`;
}

/** Renders nothing while the calendar is online. Status is said in words, never by colour alone. */
export function CalendarOfflineBanner({ offline, timeZone, busy, onRetry }: { offline?: CalendarOffline; timeZone?: string; busy: boolean; onRetry: () => void }) {
  if (!offline) return null;
  return <div className="timeline-empty timeline-error calendar-offline" role="status">
    <b>{calendarOfflineText(offline, timeZone)}</b>
    <small>{reasonText[offline.reason]}{offline.reason === "network" && offline.error ? ` (${offline.error})` : ""}.</small>
    <button type="button" disabled={busy} onClick={onRetry}>Retry</button>
  </div>;
}
