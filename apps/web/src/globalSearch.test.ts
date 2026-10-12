import { describe, expect, it } from "vitest";
import type { CalendarEvent, LifeObject } from "@lifeos/contracts";
import { calendarSearchRange, globalSearchResults, readRecentSearchIds, recordRecentSearchId } from "./globalSearch.js";

const object = (id: string, type: string, title: string, body: string, updatedAt: string, extra: Record<string, unknown> = {}): LifeObject => ({
  frontmatter: { id, type, title, revision: 1, created_at: updatedAt, updated_at: updatedAt, ...extra },
  body,
  relativePath: `${type}s/${id}.md`,
  contentHash: id
});

describe("Global Search (#146)", () => {
  const tasks = [
    object("task-title", "task", "Prepare café", "Nothing here", "2026-10-01T09:00:00Z"),
    object("task-body", "task", "Other task", "Prepare cafe plan in the body", "2026-10-03T09:00:00Z"),
    object("task-newer", "task", "Prepare cafe plan later", "", "2026-10-02T09:00:00Z"),
    object("task-archived", "task", "Prepare cafe archive", "", "2026-10-04T09:00:00Z", { archived_at: "2026-10-04T10:00:00Z" })
  ];
  const notes = [
    object("note-restricted", "knowledge-note", "Café research", "Private plan", "2026-10-02T09:00:00Z", { sensitivity: "restricted" }),
    object("meeting", "meeting-note", "Café meeting", "", "2026-10-03T09:00:00Z"),
    object("note-deleted", "knowledge-note", "Café deleted", "", "2026-10-04T09:00:00Z", { deleted_at: "2026-10-04T10:00:00Z" })
  ];

  it("matches case and accents, ranks title before body, includes restricted, and excludes non-live notes", () => {
    const result = globalSearchResults({ tasks, notes, query: "PREPARE CAFE", recentIds: [] });
    expect(result.tasks.map((item) => item.id)).toEqual(["task-title", "task-newer", "task-body"]);
    expect(globalSearchResults({ tasks, notes, query: "cafe", recentIds: [] }).notes.map((item) => item.id)).toEqual(["meeting", "note-restricted"]);
  });

  it("uses device-local recent identifier order before typing and drops ineligible identifiers", () => {
    const result = globalSearchResults({ tasks, notes, query: "", recentIds: ["note-restricted", "task-archived", "task-title"] });
    expect([...result.tasks, ...result.notes].sort((a, b) => a.recentIndex - b.recentIndex).map((item) => item.id)).toEqual(["note-restricted", "task-title"]);
  });

  it("stores only deduplicated record identifiers, never queries", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    recordRecentSearchId("a", storage); recordRecentSearchId("b", storage); recordRecentSearchId("a", storage);
    expect(readRecentSearchIds(storage)).toEqual(["a", "b"]);
    expect([...values.values()].join(" ")).not.toContain("secret query");
  });

  it("uses the approved Calendar search window", () => {
    expect(calendarSearchRange(new Date("2026-10-11T12:00:00.000Z"))).toEqual({
      from: "2026-07-13T12:00:00.000Z",
      to: "2027-10-11T12:00:00.000Z"
    });
  });

  it("groups Calendar separately and suppresses an event represented by a live Meeting Note", () => {
    const calendar: CalendarEvent[] = [
      { externalId: "plain", calendarId: "work", title: "Roadmap customer review", startsAt: "2026-10-12T09:00:00Z", endsAt: "2026-10-12T10:00:00Z", timezone: "Europe/Paris", attendees: [] },
      { externalId: "noted", calendarId: "work", title: "Customer council", startsAt: "2026-10-13T09:00:00Z", endsAt: "2026-10-13T10:00:00Z", timezone: "Europe/Paris", attendees: ["ana@example.com"], hasNote: true, noteId: "meeting-note" }
    ];
    const meetingNote = object("meeting-note", "meeting-note", "Customer council notes", "Decided the rollout", "2026-10-13T10:00:00Z", { meeting_id: "meeting-1" });
    const result = globalSearchResults({ tasks: [], notes: [meetingNote], calendar, query: "customer", recentIds: [] });
    expect(result.calendar.map((item) => item.id)).toEqual(["calendar:work:plain"]);
    expect(result.notes.map((item) => item.id)).toEqual(["meeting-note"]);
    expect(result.calendar[0]?.route).toEqual({ view: "Calendar", date: "2026-10-12" });
  });

  it("matches Meeting Notes by event metadata and occurrence body, returning one result that opens the Note (no section routing, ADR 0021)", () => {
    const sections = [
      { section_id: "occurrence-2026-10-12", original_starts_at: "2026-10-12T09:00:00Z", starts_at: "2026-10-12T09:00:00Z", meeting_id: "meeting-new" },
      { section_id: "occurrence-2026-10-05", original_starts_at: "2026-10-05T09:00:00Z", starts_at: "2026-10-05T09:00:00Z", meeting_id: "meeting-old" }
    ];
    const recurring = object("series-note", "meeting-note", "Weekly planning notes", [
      "## Weekly planning — 2026-10-12", '<a id="occurrence-2026-10-12"></a>', "Discuss launch readiness.",
      "## Weekly planning — 2026-10-05", '<a id="occurrence-2026-10-05"></a>', "Discussed café pricing with Ana."
    ].join("\n"), "2026-10-12T10:00:00Z", { recurrence_series_id: "google:work:series", occurrence_sections: sections, meeting_ids: ["meeting-new", "meeting-old"] });
    const calendar: CalendarEvent[] = sections.map((section, index) => ({ externalId: `event-${index}`, calendarId: "work", title: "Weekly planning", startsAt: String(section.starts_at), endsAt: String(section.starts_at).replace("09:00", "10:00"), originalOccurrenceStartsAt: String(section.original_starts_at), seriesId: "series", timezone: "Europe/Paris", attendees: index ? ["ana@example.com"] : ["ben@example.com"], hasNote: true, noteId: "series-note", meetingId: String(section.meeting_id) }));
    const bodyMatch = globalSearchResults({ tasks: [], notes: [recurring], calendar, query: "cafe pricing", recentIds: [] });
    expect(bodyMatch.notes).toHaveLength(1);
    expect(bodyMatch.notes[0]?.route).toEqual({ view: "Notes", noteTab: "open", id: "series-note" });
    const metadataMatch = globalSearchResults({ tasks: [], notes: [recurring], calendar, query: "weekly planning", recentIds: [] });
    expect(metadataMatch.notes).toHaveLength(1);
    expect(metadataMatch.notes[0]?.route).toEqual({ view: "Notes", noteTab: "open", id: "series-note" });
    const attendeeMatch = globalSearchResults({ tasks: [], notes: [recurring], calendar, query: "ana@example.com", recentIds: [] });
    expect(attendeeMatch.notes[0]?.route).toEqual({ view: "Notes", noteTab: "open", id: "series-note" });
  });

  it("uses the display timezone for Calendar days and a Legacy shared Note is still one result", () => {
    const sections = [
      { section_id: "today", starts_at: "2026-10-12T00:30:00Z" },
      { section_id: "past", starts_at: "2026-10-05T00:30:00Z" }
    ];
    const recurring = object("series-timezone", "meeting-note", "Planning notes", [
      "## Today planning", '<a id="today"></a>', "Today notes.",
      "## Past planning", '<a id="past"></a>', "Past notes."
    ].join("\n"), "2026-10-12T01:00:00Z", { recurrence_series_id: "series", occurrence_sections: sections });
    const result = globalSearchResults({ tasks: [], notes: [recurring], calendar: [{ externalId: "midnight", title: "Late planning", startsAt: "2026-10-12T00:30:00Z", endsAt: "2026-10-12T01:00:00Z", timezone: "America/Los_Angeles", attendees: [] }], query: "past planning", recentIds: [], timeZone: "America/Los_Angeles" });
    expect(result.notes[0]?.route).toEqual({ view: "Notes", noteTab: "open", id: "series-timezone" });
    const calendar = globalSearchResults({ tasks: [], notes: [], calendar: [{ externalId: "midnight", title: "Late planning", startsAt: "2026-10-12T00:30:00Z", endsAt: "2026-10-12T01:00:00Z", timezone: "America/Los_Angeles", attendees: [] }], query: "late", recentIds: [], timeZone: "America/Los_Angeles" });
    expect(calendar.calendar[0]?.route).toEqual({ view: "Calendar", date: "2026-10-11" });
  });
});
