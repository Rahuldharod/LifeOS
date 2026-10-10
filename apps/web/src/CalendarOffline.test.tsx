import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarOfflineBanner, calendarOfflineText, retryCalendarDay, type CalendarOffline } from "./CalendarOffline.js";
import { TodayPage, type TodayPanels } from "./TodayPage.js";

const offline: CalendarOffline = { reason: "network", error: "fetch failed", lastSuccessfulSyncAt: "2026-10-05T07:00:00.000Z" };

afterEach(() => { vi.unstubAllGlobals(); });

describe("calendar offline banner (#88)", () => {
  it("says the meetings shown are already in LifeOS, with the last sync time in the display time zone", () => {
    const text = calendarOfflineText(offline, "Europe/Paris");
    expect(text).toMatch(/^Offline: showing meetings already in LifeOS \(last synced .+\)$/);
    expect(text).toMatch(/\b0?9:00\b/);
    expect(calendarOfflineText({ reason: "auth", error: "expired" })).toBe("Offline: showing meetings already in LifeOS (last synced never)");
  });

  it("offers Retry, names the reason in words, and renders nothing while online", () => {
    const html = renderToStaticMarkup(<CalendarOfflineBanner offline={offline} timeZone="Europe/Paris" busy={false} onRetry={() => undefined} />);
    expect(html).toContain("Offline: showing meetings already in LifeOS");
    expect(html).toContain('role="status"');
    expect(html).toContain(">Retry</button>");
    expect(html).toContain("could not be reached (fetch failed)");
    expect(renderToStaticMarkup(<CalendarOfflineBanner offline={{ reason: "keychain-denied", error: "Keychain access denied" }} busy={false} onRetry={() => undefined} />)).toContain("Keychain access was denied");
    expect(renderToStaticMarkup(<CalendarOfflineBanner busy={false} onRetry={() => undefined} />)).toBe("");
  });

  it("shows on Today's Next meetings panel, above the stored meetings", () => {
    vi.stubGlobal("localStorage", { getItem: () => "Europe/Paris" });
    const panels = {
      date: "2026-10-05", overdue: [], dueToday: [], upcomingHighPriority: [], waitingByPerson: [],
      nextMeetings: [{ title: "Client review", startsAt: "2026-10-05T11:00:00.000Z", endsAt: "2026-10-05T12:00:00.000Z", inProgress: false, meetingId: "m1", restricted: false }],
      meetingHours: 1, meetingHeavy: false, calendarOffline: offline,
      openPointsForMeetings: [], reviewCount: 0, inbox: { awaiting: 0, drafts: 0, patches: 0 }, failedDrafts: [], staleWorkOrders: [],
      settings: { meetingHoursThreshold: 5, briefTime: "06:00", briefTimeZone: "Europe/Paris", briefDays: ["mon"] }
    } as TodayPanels;
    const noop = async () => undefined;
    const html = renderToStaticMarkup(<TodayPage today={{ tasks: [], overdue: [], dueToday: [], upcoming: [], waiting: [], topThree: [], reviewCount: 0 }} panels={panels}
      enrichment={{ proposedGaveUp: [], staleWorkOrders: [] }} eventCount={0} capture="" busy={false} readOnly={false} timeZone="Europe/Paris"
      onCaptureChange={() => undefined} onCapture={() => undefined} onReplan={noop} onChangeFocus={noop} onEnrich={noop} onGiveUp={async () => true}
      onOpenInbox={() => undefined} onOpenSettingsCard={() => undefined} onRetryCalendar={() => undefined} />);
    expect(html).toContain("Offline: showing meetings already in LifeOS (last synced");
    expect(html).toContain(">Retry</button>");
    expect(html.indexOf("Offline:")).toBeLessThan(html.indexOf("Client review"));
  });
});

describe("Retry on the offline banner (#94)", () => {
  const denied: CalendarOffline = { reason: "keychain-denied", error: "Keychain access denied" };

  it("asks the Keychain again first, then fails while the calendar is still offline (no success message)", async () => {
    const calls: string[] = [];
    const retry = retryCalendarDay(denied, {
      reprobeKeychain: async () => { calls.push("reprobe"); },
      loadDay: async () => { calls.push("load"); return { events: [], offline: denied }; }
    });
    await expect(retry).rejects.toThrow("Calendar is still offline: Keychain access was denied, so LifeOS cannot read the Google Calendar sign-in");
    expect(calls).toEqual(["reprobe", "load"]);
  });

  it("succeeds only when the calendar is back, and re-asks the Keychain only after a Keychain denial", async () => {
    const calls: string[] = [];
    const day = await retryCalendarDay(offline, {
      reprobeKeychain: async () => { calls.push("reprobe"); },
      loadDay: async () => { calls.push("load"); return { events: [{ title: "Standup" }] }; }
    });
    expect(day.events).toEqual([{ title: "Standup" }]);
    expect(calls).toEqual(["load"]);
  });

  it("still loads the day when re-asking the Keychain is denied again", async () => {
    const retry = retryCalendarDay(denied, { reprobeKeychain: async () => { throw new Error("Keychain access denied"); }, loadDay: async () => ({ events: [], offline: denied }) });
    await expect(retry).rejects.toThrow("Calendar is still offline");
  });
});
