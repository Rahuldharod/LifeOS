// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { CalendarDay, CalendarEvent } from "@lifeos/contracts";
import { ApiError } from "./api.js";
import { fakeApi } from "./fakeApi.js";
import { useCalendar, type Calendar } from "./useCalendar.js";

// The calendar seam: what the Calendar view and App read and call, driven by a fake API.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({ externalId: "e1", title: "Standup", startsAt: "2026-10-05T07:00:00.000Z", endsAt: "2026-10-05T07:30:00.000Z", calendarId: "work", calendarName: "Work", ...over } as CalendarEvent);

type Answers = { day?: () => CalendarDay; catalog?: unknown; prefs?: unknown; save?: () => unknown; sync?: () => CalendarDay };

// Runs a call inside act and hands back what it threw, so a rejection never leaves act half-closed.
async function attempt(run: () => Promise<unknown>) {
  let thrown: unknown;
  await act(async () => { try { await run(); } catch (error) { thrown = error; } });
  return thrown;
}

async function setup(answers: Answers) {
  const calls: string[] = [];
  const failures: string[] = [];
  let staleCount = 0;
  let calendar: Calendar | undefined;
  const call = fakeApi((endpoint) => {
    calls.push(endpoint);
    if (endpoint === "GET /api/v1/calendar/day") return answers.day!();
    if (endpoint === "POST /api/v1/calendar/day/sync") return answers.sync!();
    if (endpoint === "GET /api/v1/calendar/calendars") { if (answers.catalog instanceof Error) throw answers.catalog; return answers.catalog ?? []; }
    if (endpoint === "GET /api/v1/settings/calendar-preferences") { if (answers.prefs instanceof Error) throw answers.prefs; return answers.prefs; }
    if (endpoint === "PUT /api/v1/settings/calendar-preferences") return answers.save!();
    throw new Error(`unexpected ${endpoint}`);
  });
  function Harness() {
    calendar = useCalendar({ selectedDate: "2026-10-05", displayTimeZone: "Europe/Paris", call, onFailure: (text) => failures.push(text), onGoogleStatusStale: () => { staleCount += 1; } });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  await act(async () => { for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { calendar: () => calendar!, calls, failures, stale: () => staleCount };
}

describe("useCalendar", () => {
  it("shows the day's events, sorted, and splits all-day from timed", async () => {
    const page = await setup({ day: () => ({ events: [event({ externalId: "b", startsAt: "2026-10-05T09:00:00.000Z" }), event({ externalId: "a" }), event({ externalId: "c", isAllDay: true })] }) });
    expect(page.calendar().events).toHaveLength(3);
    expect(page.calendar().timedEvents.map((e) => e.externalId)).toEqual(["a", "b"]);
    expect(page.calendar().allDayEvents.map((e) => e.externalId)).toEqual(["c"]);
    expect(page.calendar().offline).toBeUndefined();
    expect(page.calendar().error).toBeUndefined();
  });

  it("offline (#88): keeps the stored meetings, exposes the offline state, and does not learn calendars from them", async () => {
    const offline = { reason: "network" as const, error: "fetch failed" };
    const page = await setup({ day: () => ({ events: [event({ stored: true, calendarId: "stored-only" })], offline }) });
    expect(page.calendar().offline).toEqual(offline);
    expect(page.calendar().error).toBeUndefined();
    expect(page.calendar().offered).toEqual([]);
    expect(page.stale()).toBe(0);
  });

  it("offline with the auth reason asks App to refresh the Google status", async () => {
    const page = await setup({ day: () => ({ events: [], offline: { reason: "auth", error: "expired" } }) });
    expect(page.stale()).toBe(1);
  });

  it("whole request failed (PB-022a): error text, no events, no offline state, reported once", async () => {
    const page = await setup({ day: () => { throw new ApiError("boom", 500); } });
    expect(page.calendar().error).toBe("boom");
    expect(page.calendar().events).toEqual([]);
    expect(page.calendar().offline).toBeUndefined();
    expect(page.failures).toEqual(["boom"]);
    expect(page.stale()).toBe(0);
  });

  it("a 401 also asks App to refresh the Google status", async () => {
    const page = await setup({ day: () => { throw new ApiError("Unauthorized", 401); } });
    expect(page.stale()).toBe(1);
  });

  it("retry: while still offline it rejects and keeps the banner; when back it clears it", async () => {
    const offline = { reason: "keychain-denied" as const, error: "denied" };
    let back = false;
    let reprobed = 0;
    const page = await setup({ day: () => (back ? { events: [event({})] } : { events: [], offline }) });
    expect(String(await attempt(() => page.calendar().retry({ reprobeKeychain: async () => { reprobed += 1; } })))).toContain("Calendar is still offline");
    expect(reprobed).toBe(1);
    expect(page.calendar().offline).toEqual(offline);
    expect(page.calendar().error).toBeUndefined();
    back = true;
    await act(() => page.calendar().retry({ reprobeKeychain: async () => undefined }));
    expect(page.calendar().offline).toBeUndefined();
    expect(page.calendar().events).toHaveLength(1);
  });

  it("syncDay shows the synced day; a failed sync becomes the error state and rethrows", async () => {
    let fail = false;
    const page = await setup({ day: () => ({ events: [] }), sync: () => { if (fail) throw new ApiError("sync broke", 500); return { events: [event({})] }; } });
    await act(async () => { await page.calendar().syncDay(); });
    expect(page.calendar().events).toHaveLength(1);
    fail = true;
    expect(String(await attempt(() => page.calendar().syncDay()))).toContain("sync broke");
    expect(page.calendar().error).toBe("sync broke");
    expect(page.calendar().events).toEqual([]);
  });

  it("opens on the default calendar once the catalog loads, and drops a selection that is no longer offered", async () => {
    const catalog = [{ id: "work", name: "Work" }, { id: "home", name: "Home" }];
    const page = await setup({ day: () => ({ events: [event({}), event({ externalId: "h", calendarId: "home" })] }), catalog, prefs: { disabledCalendarIds: [], defaultCalendarId: "home" } });
    expect(page.calendar().filter).toBe("home");
    expect(page.calendar().filteredEvents.map((e) => e.externalId)).toEqual(["h"]);
    expect(page.calendar().catalogLoaded).toBe(true);
  });

  it("without a catalog (calendar unavailable) it offers the calendars seen in loaded events, minus disabled ones", async () => {
    const page = await setup({ day: () => ({ events: [event({}), event({ externalId: "h", calendarId: "home", calendarName: "Home" })] }), catalog: new Error("offline"), prefs: { disabledCalendarIds: ["home"] } });
    expect(page.calendar().offered.map((c) => c.id)).toEqual(["work"]);
    expect(page.calendar().filteredEvents.map((e) => e.externalId)).toEqual(["e1"]);
  });

  it("savePrefs resolves undefined on success; a 409 reloads the latest and explains", async () => {
    let conflict = false;
    const page = await setup({ day: () => ({ events: [] }), catalog: [], prefs: { disabledCalendarIds: [], contentHash: "h1" }, save: () => { if (conflict) throw new ApiError("hash", 409); return { disabledCalendarIds: ["x"], contentHash: "h2" }; } });
    let result: string | undefined = "unset";
    await act(async () => { result = await page.calendar().savePrefs({ disabledCalendarIds: ["x"] }); });
    expect(result).toBeUndefined();
    expect(page.calendar().prefs.disabledCalendarIds).toEqual(["x"]);
    conflict = true;
    const before = page.calls.filter((c) => c === "GET /api/v1/settings/calendar-preferences").length;
    await act(async () => { result = await page.calendar().savePrefs({ disabledCalendarIds: ["y"] }); });
    expect(result).toBe("These preferences were changed on another device. The latest version is loaded; make your change again.");
    expect(page.calls.filter((c) => c === "GET /api/v1/settings/calendar-preferences").length).toBe(before + 1);
  });
});
