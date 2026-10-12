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

describe("shared recurring Note API (#148)", () => {
  it("keeps preview read-only, serializes two-tab first edits, retries safely and rejects stale whole-file writes", async () => {
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
    expect(older.note?.frontmatter.id).toBe(newer.note?.frontmatter.id);

    const notes = await call("GET /api/v1/notes", { query: {} });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.frontmatter.occurrence_sections).toHaveLength(2);
    expect(notes[0]!.body.indexOf("Newer API words")).toBeLessThan(notes[0]!.body.indexOf("Older API words"));

    const occurrenceWorkspace = await call("GET /api/v1/meetings/:id/workspace", { params: { id: older.meeting.frontmatter.id } });
    expect(occurrenceWorkspace.occurrences?.map((item) => item.sectionId)).toEqual((notes[0]!.frontmatter.occurrence_sections as Array<{ section_id: string }>).map((item) => item.section_id));
    expect(occurrenceWorkspace.occurrences?.[1]?.meeting.frontmatter).toMatchObject({ location: "Room Atlas", join_url: "https://meet.example.test/weekly" });
    expect(occurrenceWorkspace.occurrences?.[1]?.meeting.frontmatter.attendee_snapshot).toEqual([]);

    await call("POST /api/v1/meetings/from-event", { body: { externalId: events[1]!.externalId, calendarId: "work", body: "duplicate retry", ...range } });
    const retried = (await call("GET /api/v1/notes", { query: {} }))[0]!;
    expect(retried.frontmatter.occurrence_sections).toHaveLength(2);
    expect(retried.body).not.toContain("duplicate retry");

    const staleHash = retried.contentHash;
    const saved = await call("PUT /api/v1/objects/:id/body", { params: { id: retried.frontmatter.id }, body: { body: `${retried.body}\nFresh edit`, expectedHash: staleHash } });
    expect(saved.body).toContain("Fresh edit");
    const conflict = await send("PUT", `/api/v1/objects/${retried.frontmatter.id}/body`, { body: "Stale edit", expectedHash: staleHash });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: expect.stringContaining("changed") });

    await call("POST /api/v1/objects/:id/archive", { params: { id: older.meeting.frontmatter.id }, body: { expectedHash: older.meeting.contentHash } });
    const afterArchive = await call("GET /api/v1/meetings/:id/workspace", { params: { id: newer.meeting.frontmatter.id } });
    expect(afterArchive.occurrences?.map((item) => item.meeting.frontmatter.id)).toEqual([newer.meeting.frontmatter.id]);
  });

  it("links a restarted series explicitly and applies cancellation to the existing occurrence", async () => {
    const restarted: CalendarEvent = {
      ...events[1]!, externalId: "api-restarted", seriesId: "api-series-restarted",
      startsAt: "2026-11-02T08:00:00.000Z", endsAt: "2026-11-02T09:00:00.000Z", originalOccurrenceStartsAt: "2026-11-02T08:00:00.000Z"
    };
    events.push(restarted);
    try {
      const { call, start } = await testApi({ calendars });
      await start();
      const prior = await call("POST /api/v1/meetings/from-event", { body: { externalId: events[0]!.externalId, calendarId: "work", body: "Prior words\n", ...range } });
      const next = await call("POST /api/v1/meetings/from-event", { body: { externalId: restarted.externalId, calendarId: "work", body: "Restarted words\n", from: range.from, to: "2026-11-05T00:00:00.000Z" } });
      const linked = await call("POST /api/v1/notes/:id/previous-series", {
        params: { id: next.note!.frontmatter.id },
        body: { previousNoteId: prior.note!.frontmatter.id, expectedHash: next.note!.contentHash }
      });
      expect(linked.frontmatter.previous_series_note_id).toBe(prior.note!.frontmatter.id);

      events[0] = { ...events[0]!, status: "cancelled" };
      const cancelled = await call("POST /api/v1/meetings/from-event", { body: { externalId: events[0]!.externalId, calendarId: "work", ...range } });
      expect(cancelled.meeting.frontmatter.status).toBe("cancelled");
      expect(cancelled.note?.frontmatter.occurrence_sections).toHaveLength(1);
    } finally {
      events[0] = { ...events[0]!, status: undefined };
      events.pop();
    }
  });

  it("covers reschedule, split, copy, rename, delete, restore and concurrent lifecycle retries through the API", async () => {
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
    const original = occurrence({});
    lifecycleEvents.push(original);
    const { call, start } = await testApi({ calendars: lifecycleCalendars });
    await start();
    const first = await call("POST /api/v1/meetings/from-event", { body: { externalId: original.externalId, calendarId: "work", body: "Original words\n", ...window } });
    const sectionId = (first.note!.frontmatter.occurrence_sections as Array<{ section_id: string }>)[0]!.section_id;

    const moved = occurrence({ externalId: "lifecycle-moved", startsAt: "2026-10-06T13:00:00.000Z", endsAt: "2026-10-06T14:00:00.000Z" });
    lifecycleEvents.splice(0, 1, moved);
    const rescheduled = await call("POST /api/v1/meetings/from-event", { body: { externalId: moved.externalId, calendarId: "work", body: "Must not duplicate\n", ...window } });
    expect(rescheduled.meeting.frontmatter.id).toBe(first.meeting.frontmatter.id);
    expect((rescheduled.note!.frontmatter.occurrence_sections as Array<{ section_id: string }>)[0]!.section_id).toBe(sectionId);

    const renamed = occurrence({ externalId: "lifecycle-renamed", title: "Lifecycle renamed", startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    lifecycleEvents.push(renamed);
    const renamedWorkspace = await call("POST /api/v1/meetings/from-event", { body: { externalId: renamed.externalId, calendarId: "work", body: "Renamed occurrence\n", ...window } });
    expect(renamedWorkspace.note?.frontmatter.title).toBe("Lifecycle renamed notes");

    const split = occurrence({ externalId: "lifecycle-split", seriesId: "lifecycle-b", previousSeriesId: "lifecycle-a", startsAt: "2026-10-19T08:00:00.000Z", endsAt: "2026-10-19T09:00:00.000Z", originalOccurrenceStartsAt: "2026-10-19T08:00:00.000Z" });
    const copied = occurrence({ externalId: "lifecycle-copy", seriesId: undefined, seriesUid: undefined, originalOccurrenceStartsAt: undefined, startsAt: "2026-10-20T08:00:00.000Z", endsAt: "2026-10-20T09:00:00.000Z" });
    lifecycleEvents.push(split, copied);
    const splitWorkspace = await call("POST /api/v1/meetings/from-event", { body: { externalId: split.externalId, calendarId: "work", body: "Split words\n", ...window } });
    const copyWorkspace = await call("POST /api/v1/meetings/from-event", { body: { externalId: copied.externalId, calendarId: "work", body: "Copied words\n", ...window } });
    expect(splitWorkspace.note?.frontmatter.previous_series_note_id).toBe(first.note!.frontmatter.id);
    expect(copyWorkspace.note?.frontmatter.id).not.toBe(first.note!.frontmatter.id);
    expect(copyWorkspace.note?.frontmatter.id).not.toBe(splitWorkspace.note!.frontmatter.id);

    const deleted = await call("DELETE /api/v1/notes/:id", { params: { id: splitWorkspace.note!.frontmatter.id }, body: { expectedHash: splitWorkspace.note!.contentHash } });
    const replacementEvent = occurrence({ externalId: "lifecycle-replacement", seriesId: "lifecycle-b", previousSeriesId: "lifecycle-a", startsAt: "2026-10-26T08:00:00.000Z", endsAt: "2026-10-26T09:00:00.000Z", originalOccurrenceStartsAt: "2026-10-26T08:00:00.000Z" });
    lifecycleEvents.push(replacementEvent);
    const [replacement, retry] = await Promise.all([
      call("POST /api/v1/meetings/from-event", { body: { externalId: replacementEvent.externalId, calendarId: "work", body: "Replacement words\n", ...window } }),
      call("POST /api/v1/meetings/from-event", { body: { externalId: replacementEvent.externalId, calendarId: "work", body: "Retry words\n", ...window } })
    ]);
    expect(replacement.note?.frontmatter.id).toBe(retry.note?.frontmatter.id);
    await expect(call("POST /api/v1/notes/:id/restore", { params: { id: splitWorkspace.note!.frontmatter.id }, body: { expectedHash: (deleted as { contentHash: string }).contentHash } })).rejects.toThrow("newer live canonical Note");

    const cancelled = occurrence({ externalId: "lifecycle-cancelled-empty", seriesId: "lifecycle-cancelled", seriesUid: undefined, status: "cancelled", startsAt: "2026-11-02T08:00:00.000Z", endsAt: "2026-11-02T09:00:00.000Z", originalOccurrenceStartsAt: "2026-11-02T08:00:00.000Z" });
    lifecycleEvents.push(cancelled);
    const untouched = await call("POST /api/v1/meetings/from-event", { body: { externalId: cancelled.externalId, calendarId: "work", ...window } });
    expect(untouched.persisted).toBe(false);
  });
});
