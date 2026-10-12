import { describe, expect, it } from "vitest";
import type { CalendarConnector, CalendarEvent } from "@lifeos/application";
import { testApi } from "./test-api.js";

const events: CalendarEvent[] = [
  {
    externalId: "api-occurrence-1", calendarId: "work", title: "API weekly",
    startsAt: "2026-10-05T08:00:00.000Z", endsAt: "2026-10-05T09:00:00.000Z", timezone: "Europe/Paris", attendees: [],
    seriesId: "api-series", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z", location: "Room Atlas", joinUrl: "https://meet.example.test/weekly"
  },
  {
    externalId: "api-occurrence-2", calendarId: "work", title: "API weekly",
    startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z", timezone: "Europe/Paris", attendees: [],
    seriesId: "api-series", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z"
  }
];

const calendar: CalendarConnector = { provider: "synthetic", listEvents: async () => events };
const calendars = {
  calendar,
  get google() { return undefined; },
  useGoogle() { throw new Error("Google is not used by this synthetic API test"); },
  async probe() {}
};
const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" };

describe("per-occurrence recurring Note API (#148, #172)", () => {
  it("keeps preview read-only, gives two-tab first edits one Note each, retries safely and rejects stale whole-file writes", async () => {
    const { call, send, start } = await testApi({ calendars });
    await start();
    const before = await call("GET /api/v1/objects");

    const preview = await call("GET /api/v1/meetings/preview", { query: { externalId: events[0]!.externalId, calendarId: "work", ...range } });
    expect(preview.persisted).toBe(false);
    expect(preview.note).toBeUndefined();
    expect(await call("GET /api/v1/objects")).toEqual(before);

    const created = await Promise.all(events.map((event, index) => call("POST /api/v1/meetings/from-event", {
      body: { externalId: event.externalId, calendarId: event.calendarId, body: `${index ? "Newer" : "Older"} API words\n`, ...range }
    })));
    const older = created[0]!;
    const newer = created[1]!;
    expect(older.note?.frontmatter.id).not.toBe(newer.note?.frontmatter.id);
    expect(older.meeting.frontmatter).toMatchObject({ location: "Room Atlas", join_url: "https://meet.example.test/weekly" });

    const notes = await call("GET /api/v1/notes", { query: {} });
    expect(notes).toHaveLength(2);
    expect(notes.map((note) => note.body).sort()).toEqual(["Newer API words\n", "Older API words\n"]);
    expect(notes.every((note) => note.frontmatter.occurrence_sections === undefined && note.frontmatter.meeting_ids === undefined)).toBe(true);

    await call("POST /api/v1/meetings/from-event", { body: { externalId: events[1]!.externalId, calendarId: "work", body: "duplicate retry", ...range } });
    const retried = (await call("GET /api/v1/notes", { query: {} })).find((note) => note.frontmatter.id === newer.note!.frontmatter.id)!;
    expect(retried.body).toBe("Newer API words\n");

    const staleHash = retried.contentHash;
    const saved = await call("PUT /api/v1/objects/:id/body", { params: { id: retried.frontmatter.id }, body: { body: `${retried.body}\nFresh edit`, expectedHash: staleHash } });
    expect(saved.body).toContain("Fresh edit");
    const conflict = await send("PUT", `/api/v1/objects/${retried.frontmatter.id}/body`, { body: "Stale edit", expectedHash: staleHash });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: expect.stringContaining("changed") });
    // Saving one occurrence's Note never touches the other's.
    expect((await call("GET /api/v1/notes", { query: {} })).find((note) => note.frontmatter.id === older.note!.frontmatter.id)!.body).toBe("Older API words\n");
  });

  it("applies cancellation to the existing occurrence and keeps its own Note", async () => {
    const cancelledEvents: CalendarEvent[] = [{ ...events[0]! }];
    const cancelledCalendar: CalendarConnector = { provider: "synthetic", listEvents: async () => cancelledEvents };
    const { call, start } = await testApi({ calendars: { calendar: cancelledCalendar, get google() { return undefined; }, useGoogle() { throw new Error("Google is not used by this synthetic API test"); }, async probe() {} } });
    await start();
    const prior = await call("POST /api/v1/meetings/from-event", { body: { externalId: events[0]!.externalId, calendarId: "work", body: "Prior words\n", ...range } });

    cancelledEvents[0] = { ...cancelledEvents[0]!, status: "cancelled" };
    const cancelled = await call("POST /api/v1/meetings/from-event", { body: { externalId: events[0]!.externalId, calendarId: "work", ...range } });
    expect(cancelled.meeting.frontmatter.status).toBe("cancelled");
    expect(cancelled.note?.frontmatter.id).toBe(prior.note!.frontmatter.id);
    expect(cancelled.note?.body).toBe("Prior words\n");
  });

  it("keeps the same Meeting and Note when the provider reschedules, and writes nothing for a cancelled occurrence with no Note", async () => {
    const lifecycleEvents: CalendarEvent[] = [];
    const lifecycleCalendar: CalendarConnector = { provider: "synthetic", listEvents: async () => lifecycleEvents };
    const lifecycleCalendars = { calendar: lifecycleCalendar, get google() { return undefined; }, useGoogle() { throw new Error("Google is not used by this synthetic API test"); }, async probe() {} };
    const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" };
    const occurrence = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
      externalId: "lifecycle-first", calendarId: "work", title: "Lifecycle weekly",
      startsAt: "2026-10-05T08:00:00.000Z", endsAt: "2026-10-05T09:00:00.000Z", timezone: "Europe/Paris",
      attendees: ["same@example.com"], seriesId: "lifecycle-a", seriesUid: "lifecycle-family",
      originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z", ...overrides
    });
    lifecycleEvents.push(occurrence({}));
    const { call, start } = await testApi({ calendars: lifecycleCalendars });
    await start();
    const first = await call("POST /api/v1/meetings/from-event", { body: { externalId: "lifecycle-first", calendarId: "work", body: "Original words\n", ...window } });

    lifecycleEvents.splice(0, 1, occurrence({ externalId: "lifecycle-moved", startsAt: "2026-10-06T13:00:00.000Z", endsAt: "2026-10-06T14:00:00.000Z" }));
    const rescheduled = await call("POST /api/v1/meetings/from-event", { body: { externalId: "lifecycle-moved", calendarId: "work", body: "Must not duplicate\n", ...window } });
    expect(rescheduled.meeting.frontmatter.id).toBe(first.meeting.frontmatter.id);
    expect(rescheduled.note?.frontmatter.id).toBe(first.note!.frontmatter.id);
    expect(rescheduled.note?.body).toBe("Original words\n");

    lifecycleEvents.push(occurrence({ externalId: "lifecycle-cancelled-empty", seriesId: "lifecycle-cancelled", seriesUid: undefined, status: "cancelled", startsAt: "2026-11-02T08:00:00.000Z", endsAt: "2026-11-02T09:00:00.000Z", originalOccurrenceStartsAt: "2026-11-02T08:00:00.000Z" }));
    const untouched = await call("POST /api/v1/meetings/from-event", { body: { externalId: "lifecycle-cancelled-empty", calendarId: "work", ...window } });
    expect(untouched.persisted).toBe(false);
  });
});
