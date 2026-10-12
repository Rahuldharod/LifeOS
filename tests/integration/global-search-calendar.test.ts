import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { globalSearchResults } from "../../apps/web/src/globalSearch.js";
import { seedLegacySharedNote } from "./legacy-shared-note.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class SyntheticCalendar implements CalendarConnector {
  readonly provider = "synthetic";
  constructor(readonly events: CalendarEvent[]) {}
  async listEvents(from: Date, to: Date) { return this.events.filter((event) => Date.parse(event.startsAt) < to.getTime() && Date.parse(event.endsAt) > from.getTime()); }
}

const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  externalId: "event", calendarId: "work", title: "Weekly planning", startsAt: "2026-10-05T09:00:00.000Z", endsAt: "2026-10-05T10:00:00.000Z", timezone: "Europe/Paris", attendees: [], ...overrides
});

describe("Global Search Calendar integration (#152)", () => {
  it("groups unnoted events separately, suppresses represented events, and deep-links a shared Note occurrence", async () => {
    const older = event({ externalId: "older", title: "Planning customer review", seriesId: "series", originalOccurrenceStartsAt: "2026-10-05T09:00:00.000Z", attendees: ["ana@example.com"] });
    const newer = event({ externalId: "newer", title: "Planning customer review", startsAt: "2026-10-12T09:00:00.000Z", endsAt: "2026-10-12T10:00:00.000Z", seriesId: "series", originalOccurrenceStartsAt: "2026-10-12T09:00:00.000Z", attendees: ["ben@example.com"] });
    const plain = event({ externalId: "plain", title: "Planning customer backlog", startsAt: "2026-10-10T09:00:00.000Z", endsAt: "2026-10-10T10:00:00.000Z" });
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-global-search-"));
    roots.push(root);
    const app = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new SyntheticCalendar([older, newer, plain]), undefined, "search-test");
    await app.rebuildIndex();
    const from = new Date("2026-07-13T12:00:00.000Z"); const to = new Date("2027-10-11T12:00:00.000Z");
    // #172: new occurrences get their own Notes, so the shared Note whose sections search deep-links to is a Legacy shared Note.
    const { items } = await seedLegacySharedNote(root, "synthetic", [{ event: older, body: "Older customer decision\n" }, { event: newer, body: "Newer customer decision\n" }]);
    await app.rebuildIndex();
    const oldWorkspace = await app.meetingWorkspace(items.find((item) => item.event === older)!.meetingId);
    const calendar = await app.listCalendarEvents(from, to);
    const note = app.notes()[0]!;

    const grouped = globalSearchResults({ tasks: [], notes: [note], calendar, query: "planning customer", recentIds: [], now: new Date("2026-10-06T12:00:00.000Z"), timeZone: "Europe/Paris" });
    expect(grouped.calendar.map((item) => item.title)).toEqual(["Planning customer backlog"]);
    expect(grouped.notes.map((item) => item.id)).toEqual([note.frontmatter.id]);

    const occurrence = globalSearchResults({ tasks: [], notes: [note], calendar, query: "older customer decision", recentIds: [], now: new Date("2026-10-12T12:00:00.000Z"), timeZone: "Europe/Paris" });
    expect(occurrence.notes[0]?.route).toEqual({ view: "Notes", noteTab: "open", id: note.frontmatter.id, section: (note.frontmatter.occurrence_sections as Array<{ meeting_id: string; section_id: string }>).find((section) => section.meeting_id === oldWorkspace.meeting.frontmatter.id)?.section_id });
  });
});
