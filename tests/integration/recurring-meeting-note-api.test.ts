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
  });
});
