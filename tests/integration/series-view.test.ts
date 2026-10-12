import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  const writeMeeting = async (n: number, event: CalendarEvent, recurring = true) => {
    const id = uuidV7();
    await store.write({ relativePath: `meetings/${id}.md`, frontmatter: {
      ...stamp(id, "meeting", event.title), status: "scheduled", starts_at: event.startsAt, ends_at: event.endsAt, timezone: "Europe/Paris", attendee_ids: [],
      ...(recurring ? { recurrence_series_id: SERIES, recurrence_occurrence_id: `${SERIES}:${day(n)}`, original_occurrence_starts_at: day(n) } : {}),
      external_refs: [{ provider: "synthetic", external_id: event.externalId, calendar_id: "work" }]
    }, body: "# Weekly planning\n" });
    return id;
  };
  /** A stored occurrence: its Meeting and, when `note` is given, its own live Meeting Note (the ADR 0021 shape). */
  const occurrence = async (n: number, note?: string, options: { title?: string; recurring?: boolean; restricted?: boolean } = {}) => {
    const event = calendarEvent(n, { ...(options.title ? { title: options.title } : {}), ...(options.recurring === false ? { seriesId: undefined, originalOccurrenceStartsAt: undefined } : {}) });
    events.push(event);
    const meetingId = await writeMeeting(n, event, options.recurring !== false);
    let noteId: string | undefined;
    if (note !== undefined) {
      noteId = uuidV7();
      await store.write({ relativePath: `meetings/${noteId}.md`, frontmatter: { ...stamp(noteId, "meeting-note", `${event.title} notes`), meeting_id: meetingId, ...(options.restricted ? { sensitivity: "restricted" } : {}) }, body: note });
    }
    return { event, meetingId, noteId };
  };
  /** An occurrence the provider reports but LifeOS has never stored (a new, not yet persisted occurrence). */
  const unsaved = (n: number) => { const event = calendarEvent(n); events.push(event); return event; };
  /** A Legacy shared Note (ADR 0019): one Note linked to several Meetings through meeting_ids. */
  const legacyShared = async (days: number[], body: string) => {
    const meetingIds: string[] = [];
    for (const n of days) { const event = calendarEvent(n); events.push(event); meetingIds.push(await writeMeeting(n, event)); }
    const noteId = uuidV7();
    await store.write({ relativePath: `meetings/${noteId}.md`, frontmatter: {
      ...stamp(noteId, "meeting-note", "Weekly planning notes"), meeting_id: meetingIds[0], meeting_ids: meetingIds, recurrence_series_id: SERIES,
      occurrence_sections: days.map((n, index) => ({ occurrence_id: `${SERIES}:${day(n)}`, section_id: `occurrence-${n}`, meeting_id: meetingIds[index], original_starts_at: day(n), starts_at: day(n) }))
    }, body });
    return { meetingIds, noteId };
  };
  return { root, app, occurrence, unsaved, legacyShared };
}

type View = { seriesView?: { earlier: Array<{ kind: string; startsAt: string; rangeStartsAt: string; rangeEndsAt: string; meetingIds: string[]; note: { body: string; frontmatter: { id: string } } }> } };
const bodies = (workspace: View) => workspace.seriesView?.earlier.map((entry) => entry.note.body.trim());
const snapshot = async (root: string) => {
  const entries = (await readdir(root, { recursive: true })).sort();
  return Promise.all(entries.map(async (entry) => [entry, await readFile(path.join(root, entry), "utf8").catch(() => "directory")]));
};
const preview = (app: LifeOSApplication, n: number) => app.previewMeetingFromEvent(`event-${n}`, undefined, undefined, "work") as Promise<View & { persisted: boolean }>;

describe("Series view (#179)", () => {
  it("gives a new occurrence the 4 most recent earlier Notes, newest first, skipping occurrences without a Note", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "week 1\n");
    await occurrence(2, "week 2\n");
    await occurrence(3); // no Note: skipped and not counted
    await occurrence(4, "week 4\n");
    await occurrence(5, "week 5\n");
    await occurrence(6, "week 6\n");
    unsaved(8);
    await app.rebuildIndex();

    const workspace = await preview(app, 8);

    expect(workspace.persisted).toBe(false);
    expect(bodies(workspace)).toEqual(["week 6", "week 5", "week 4", "week 2"]);
  });


  it("gives a stored occurrence the same view and never lists its own Note", async () => {
    const { app, occurrence } = await setup();
    await occurrence(1, "week 1\n");
    await occurrence(2, "week 2\n");
    await occurrence(3, "week 3\n");
    await occurrence(4, "week 4 (opened)\n");
    await app.rebuildIndex();

    const workspace = await preview(app, 4);

    expect(workspace.persisted).toBe(true);
    expect(bodies(workspace)).toEqual(["week 3", "week 2", "week 1"]);
  });

  it("shows the 4 before an older occurrence, not the latest 4", async () => {
    const { app, occurrence } = await setup();
    for (let n = 1; n <= 9; n += 1) await occurrence(n, `week ${n}\n`);
    await app.rebuildIndex();

    expect(bodies(await preview(app, 9))).toEqual(["week 8", "week 7", "week 6", "week 5"]);
    expect(bodies(await preview(app, 6))).toEqual(["week 5", "week 4", "week 3", "week 2"]);
    expect(bodies(await preview(app, 1))).toEqual([]);
  });

  it("returns an empty Series view for a recurring occurrence with no history, and none for a one-off event", async () => {
    const { app, occurrence, unsaved } = await setup();
    unsaved(1);
    await occurrence(2, "one-off notes\n", { recurring: false });
    await app.rebuildIndex();

    expect((await preview(app, 1)).seriesView).toEqual({ earlier: [] });
    expect((await preview(app, 2)).seriesView).toBeUndefined();
  });

  it("lists a Legacy shared Note once, labelled with the date range of its Meetings, at its newest Meeting", async () => {
    const { app, occurrence, legacyShared, unsaved } = await setup();
    await occurrence(1, "separate week 1\n");
    const legacy = await legacyShared([2, 3, 4], "shared legacy body\n");
    await occurrence(6, "separate week 6\n");
    unsaved(8);
    await app.rebuildIndex();

    const workspace = await preview(app, 8);

    expect(bodies(workspace)).toEqual(["separate week 6", "shared legacy body", "separate week 1"]);
    const shared = workspace.seriesView!.earlier[1]!;
    expect(shared).toMatchObject({ kind: "legacy-shared", startsAt: day(4), rangeStartsAt: day(2), rangeEndsAt: day(4).replace("T08", "T09") });
    expect(shared.meetingIds.sort()).toEqual([...legacy.meetingIds].sort());
    expect(shared.note.frontmatter.id).toBe(legacy.noteId);
  });

  it("does not repeat the opened occurrence's own Legacy shared Note", async () => {
    const { app, legacyShared, occurrence } = await setup();
    await occurrence(1, "separate week 1\n");
    const legacy = await legacyShared([2, 3], "shared legacy body\n");
    await app.rebuildIndex();

    const workspace = await app.meetingWorkspace(legacy.meetingIds[1]!) as unknown as View;

    expect(bodies(workspace)).toEqual(["separate week 1"]);
  });

  it("uses only provider recurrence identity: another series or lookalike titles never join", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "same series\n");
    await occurrence(2, "lookalike without recurrence identity\n", { recurring: false });
    await occurrence(3, "other title, same series\n", { title: "Totally different title" });
    unsaved(5);
    await app.rebuildIndex();

    expect(bodies(await preview(app, 5))).toEqual(["other title, same series", "same series"]);
  });

  it("writes nothing when opening a new or a stored occurrence", async () => {
    const { app, root, occurrence, unsaved } = await setup();
    await occurrence(1, "week 1\n");
    await occurrence(2, "week 2\n");
    unsaved(3);
    await app.rebuildIndex();
    const before = await snapshot(root);

    await preview(app, 3);
    await preview(app, 2);
    await app.rebuildIndex();

    expect(await snapshot(root)).toEqual(before);
  });
});
