import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent, type CalendarEventReference } from "@lifeos/application";
import { uuidV7, type ObjectEnvelope } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class SyntheticCalendar implements CalendarConnector {
  readonly provider = "synthetic";
  constructor(readonly events: CalendarEvent[]) {}
  async listEvents() { return this.events; }
  async getEventsByReference(references: CalendarEventReference[]) {
    return references.flatMap(({ externalId, calendarId }) => this.events.filter((event) => event.externalId === externalId && (!calendarId || event.calendarId === calendarId)));
  }
}

const SERIES = "synthetic:work:series-view";
const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}T08:00:00.000Z`;
const calendarEvent = (n: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  externalId: `event-${n}`, calendarId: "work", title: "Weekly planning", startsAt: day(n), endsAt: day(n).replace("T08", "T09"),
  timezone: "Europe/Paris", attendees: [], seriesId: "series-view", originalOccurrenceStartsAt: day(n), ...overrides
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-series-view-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const events: CalendarEvent[] = [];
  const app = new LifeOSApplication(store, new MemoryIndex(), new SyntheticCalendar(events), undefined, "series-view-test");
  const stamp = (id: string, type: ObjectEnvelope["type"], title: string) => ({ id, type, schema_version: 1, revision: 1, title, created_at: "2026-09-01T08:00:00.000Z", updated_at: "2026-09-01T08:00:00.000Z", updated_by_device: "series-view-test", origin: "app" as const });
  const writeMeeting = async (n: number, event: CalendarEvent, recurring = true, extra: Record<string, unknown> = {}, series = SERIES) => {
    const id = uuidV7();
    await store.write({ relativePath: `meetings/${id}.md`, frontmatter: {
      ...stamp(id, "meeting", event.title), status: "scheduled", starts_at: event.startsAt, ends_at: event.endsAt, timezone: "Europe/Paris", attendee_ids: [],
      ...(recurring ? { recurrence_series_id: series, recurrence_occurrence_id: `${series}:${day(n)}`, original_occurrence_starts_at: day(n) } : {}),
      ...extra,
      external_refs: [{ provider: "synthetic", external_id: event.externalId, calendar_id: "work" }]
    }, body: "# Weekly planning\n" });
    return id;
  };
  /** A stored occurrence: its Meeting and, when `note` is given, its own live Meeting Note (the ADR 0021 shape). */
  const occurrence = async (n: number, note?: string, options: { title?: string; recurring?: boolean; restricted?: boolean; archivedMeeting?: boolean; deletedNote?: boolean; movedTo?: { startsAt: string; endsAt: string } } = {}) => {
    const event = calendarEvent(n, { ...(options.movedTo ?? {}), ...(options.title ? { title: options.title } : {}), ...(options.recurring === false ? { seriesId: undefined, originalOccurrenceStartsAt: undefined } : {}) });
    events.push(event);
    const meetingId = await writeMeeting(n, event, options.recurring !== false, options.archivedMeeting ? { archived_at: "2026-09-02T08:00:00.000Z" } : {});
    let noteId: string | undefined;
    if (note !== undefined) {
      noteId = uuidV7();
      await store.write({ relativePath: `meetings/${noteId}.md`, frontmatter: { ...stamp(noteId, "meeting-note", `${event.title} notes`), meeting_id: meetingId, ...(options.restricted ? { sensitivity: "restricted" } : {}), ...(options.deletedNote ? { deleted_at: "2026-09-02T08:00:00.000Z" } : {}) }, body: note });
    }
    return { event, meetingId, noteId };
  };
  /** An occurrence the provider reports but LifeOS has never stored (a new, not yet persisted occurrence). */
  const unsaved = (n: number, overrides: Partial<CalendarEvent> = {}) => { const event = calendarEvent(n, overrides); events.push(event); return event; };
  /** A Legacy shared Note (ADR 0019): one Note linked to several Meetings through meeting_ids. */
  const legacyShared = async (days: number[], body: string, otherSeriesDays: number[] = []) => {
    const meetingIds: string[] = [];
    for (const n of days) { const event = calendarEvent(n); events.push(event); meetingIds.push(await writeMeeting(n, event)); }
    // Meetings linked by the Note but belonging to another provider series.
    for (const n of otherSeriesDays) { const event = calendarEvent(n, { seriesId: "other-series" }); events.push(event); meetingIds.push(await writeMeeting(n, event, true, {}, "synthetic:work:other-series")); }
    const noteId = uuidV7();
    await store.write({ relativePath: `meetings/${noteId}.md`, frontmatter: {
      ...stamp(noteId, "meeting-note", "Weekly planning notes"), meeting_id: meetingIds[0], meeting_ids: meetingIds, recurrence_series_id: SERIES,
      occurrence_sections: [...days, ...otherSeriesDays].map((n, index) => ({ occurrence_id: `${SERIES}:${day(n)}`, section_id: `occurrence-${n}`, meeting_id: meetingIds[index], original_starts_at: day(n), starts_at: day(n) }))
    }, body });
    return { meetingIds, noteId };
  };
  return { root, app, occurrence, unsaved, legacyShared };
}

type View = { seriesView?: { earlier: Array<{ kind: string; range: { startsAt: string; endsAt: string }; note: { body: string; contentHash: string; frontmatter: { id: string; sensitivity?: string } } }> } };
const bodies = (workspace: View) => workspace.seriesView?.earlier.map((entry) => entry.note.body.trim());
const preview = (app: LifeOSApplication, n: number) => app.previewMeetingFromEvent(`event-${n}`, undefined, undefined, "work") as Promise<View & { persisted: boolean }>;

describe("Editing earlier occurrences in place (#173)", () => {
  it("saves an earlier Note to its own file only, leaving the other Notes untouched", async () => {
    const { app, root, occurrence, unsaved } = await setup();
    const one = await occurrence(1, "week 1\n");
    const two = await occurrence(2, "week 2\n");
    unsaved(5);
    await app.rebuildIndex();
    const entries = (await preview(app, 5)).seriesView!.earlier;
    const earlierTwo = entries.find((entry) => entry.note.frontmatter.id === two.noteId)!.note;
    const untouched = await readFile(path.join(root, `meetings/${one.noteId}.md`), "utf8");

    await app.updateBody(two.noteId!, "week 2 edited\n", earlierTwo.contentHash);

    expect(await readFile(path.join(root, `meetings/${two.noteId}.md`), "utf8")).toContain("week 2 edited");
    expect(await readFile(path.join(root, `meetings/${one.noteId}.md`), "utf8")).toBe(untouched);
  });

  it("refuses a save made against a stale hash, so a conflict on one Note cannot overwrite it", async () => {
    const { app, occurrence, unsaved } = await setup();
    const one = await occurrence(1, "week 1\n");
    unsaved(5);
    await app.rebuildIndex();
    const stale = (await preview(app, 5)).seriesView!.earlier[0]!.note;
    await app.updateBody(one.noteId!, "changed on another device\n", stale.contentHash);

    await expect(app.updateBody(one.noteId!, "my older draft\n", stale.contentHash)).rejects.toThrow();
    expect(bodies(await preview(app, 5))).toEqual(["changed on another device"]);
  });

  it("saves a Legacy shared Note as one whole body and keeps its sections metadata", async () => {
    const { app, root, legacyShared, unsaved } = await setup();
    const legacy = await legacyShared([1, 2], "shared line 1\nshared line 2\n");
    unsaved(5);
    await app.rebuildIndex();
    const entry = (await preview(app, 5)).seriesView!.earlier[0]!;
    expect(entry.kind).toBe("legacy-shared");

    await app.updateBody(legacy.noteId, "shared line 1\nshared line 2\nthird line\n", entry.note.contentHash);

    const stored = await readFile(path.join(root, `meetings/${legacy.noteId}.md`), "utf8");
    expect(stored).toContain("third line");
    expect(stored).toContain("occurrence_sections");
    expect(bodies(await preview(app, 5))).toEqual(["shared line 1\nshared line 2\nthird line"]);
  });
});
