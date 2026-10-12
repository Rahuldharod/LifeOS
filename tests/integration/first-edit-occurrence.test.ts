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

const SERIES = "synthetic:work:first-edit";
const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}T08:00:00.000Z`;
const calendarEvent = (n: number): CalendarEvent => ({
  externalId: `event-${n}`, calendarId: "work", title: "Weekly planning", startsAt: day(n), endsAt: day(n).replace("T08", "T09"),
  timezone: "Europe/Paris", attendees: [], seriesId: "first-edit", originalOccurrenceStartsAt: day(n)
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-first-edit-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const events: CalendarEvent[] = [];
  const app = new LifeOSApplication(store, new MemoryIndex(), new SyntheticCalendar(events), undefined, "first-edit-test");
  const stamp = (id: string, type: ObjectEnvelope["type"], title: string) => ({ id, type, schema_version: 1, revision: 1, title, created_at: "2026-09-01T08:00:00.000Z", updated_at: "2026-09-01T08:00:00.000Z", updated_by_device: "first-edit-test", origin: "app" as const });
  const writeMeeting = async (n: number) => {
    const id = uuidV7();
    const event = calendarEvent(n);
    events.push(event);
    await store.write({ relativePath: `meetings/${id}.md`, frontmatter: {
      ...stamp(id, "meeting", event.title), status: "scheduled", starts_at: event.startsAt, ends_at: event.endsAt, timezone: "Europe/Paris", attendee_ids: [],
      recurrence_series_id: SERIES, recurrence_occurrence_id: `${SERIES}:${day(n)}`, original_occurrence_starts_at: day(n),
      external_refs: [{ provider: "synthetic", external_id: event.externalId, calendar_id: "work" }]
    }, body: "# Weekly planning\n" });
    return id;
  };
  /** An earlier occurrence with its own Note (the ADR 0021 shape). */
  const occurrence = async (n: number, body: string) => {
    const meetingId = await writeMeeting(n);
    const noteId = uuidV7();
    await store.write({ relativePath: `meetings/${noteId}.md`, frontmatter: { ...stamp(noteId, "meeting-note", "Weekly planning notes"), meeting_id: meetingId }, body });
    return { meetingId, noteId };
  };
  /** A Legacy shared Note (ADR 0019) covering the given days. */
  const legacyShared = async (days: number[], body: string) => {
    const meetingIds: string[] = [];
    for (const n of days) meetingIds.push(await writeMeeting(n));
    const noteId = uuidV7();
    await store.write({ relativePath: `meetings/${noteId}.md`, frontmatter: {
      ...stamp(noteId, "meeting-note", "Weekly planning notes"), meeting_id: meetingIds[0], meeting_ids: meetingIds, recurrence_series_id: SERIES,
      occurrence_sections: days.map((n, index) => ({ occurrence_id: `${SERIES}:${day(n)}`, section_id: `occurrence-${n}`, meeting_id: meetingIds[index], original_starts_at: day(n), starts_at: day(n) }))
    }, body });
    return { meetingIds, noteId };
  };
  const unsaved = (n: number) => { const event = calendarEvent(n); events.push(event); return event; };
  return { root, app, occurrence, legacyShared, unsaved };
}

const snapshot = async (root: string) => {
  const files = (await readdir(root, { recursive: true })).sort();
  const entries = await Promise.all(files.map(async (file) => [file, await readFile(path.join(root, file), "utf8").catch(() => undefined)] as const));
  return new Map(entries.filter(([, content]) => content !== undefined) as Array<[string, string]>);
};
const diff = (before: Map<string, string>, after: Map<string, string>) => ({
  added: [...after.keys()].filter((file) => !before.has(file)).sort(),
  changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)).sort(),
  removed: [...before.keys()].filter((file) => !after.has(file)).sort()
});
const meetingFiles = (files: string[]) => files.filter((file) => file.startsWith("meetings/"));

describe("first edit of a new recurring occurrence (#172)", () => {
  it("writes exactly one Meeting and one Meeting Note and leaves every other file byte-identical", async () => {
    const { root, app, occurrence, unsaved } = await setup();
    await occurrence(1, "week 1\n");
    await occurrence(2, "week 2\n");
    const event = unsaved(3);
    const before = await snapshot(root);

    const workspace = await app.createMeetingFromEvent(event.externalId, undefined, undefined, "work", "week 3 words\n");

    const changes = diff(before, await snapshot(root));
    expect(changes.changed).toEqual([]);
    expect(changes.removed).toEqual([]);
    // Meeting + Note, plus the bookkeeping the store legitimately writes for exactly those two objects:
    // their version snapshots, the create-meeting operation journal and one `meeting.created` audit entry.
    expect(meetingFiles(changes.added)).toHaveLength(2);
    const bookkeeping = changes.added.filter((file) => !file.startsWith("meetings/"));
    expect(bookkeeping.filter((file) => file.startsWith(".lifeos/versions/"))).toHaveLength(2);
    expect(bookkeeping.filter((file) => file.startsWith(".lifeos/operations/"))).toHaveLength(1);
    expect(bookkeeping.filter((file) => file.startsWith("audit/"))).toHaveLength(1);
    expect(bookkeeping).toHaveLength(4);
    expect(workspace.note?.body).toBe("week 3 words\n");
    expect(workspace.note?.frontmatter.meeting_id).toBe(workspace.meeting.frontmatter.id);
    expect(workspace.note?.frontmatter.recurrence_series_id).toBeUndefined();
    expect(workspace.note?.frontmatter.occurrence_sections).toBeUndefined();
    expect(workspace.note?.frontmatter.meeting_ids).toBeUndefined();
  });

  it("gives a series with a Legacy shared Note its own Note and leaves the legacy file byte-identical", async () => {
    const { root, app, legacyShared, unsaved } = await setup();
    const legacy = await legacyShared([1, 2], "legacy words\n");
    const event = unsaved(3);
    const before = await snapshot(root);

    const workspace = await app.createMeetingFromEvent(event.externalId, undefined, undefined, "work", "week 3 words\n");

    const changes = diff(before, await snapshot(root));
    expect(changes.changed).toEqual([]);
    expect(meetingFiles(changes.added)).toHaveLength(2);
    expect(workspace.note?.frontmatter.id).not.toBe(legacy.noteId);
    expect(workspace.note?.body).toBe("week 3 words\n");
    const view = await app.meetingWorkspace(workspace.meeting.frontmatter.id) as { seriesView?: { earlier: Array<{ kind: string; note: { frontmatter: { id: string } } }> } };
    expect(view.seriesView?.earlier.map((entry) => [entry.kind, entry.note.frontmatter.id])).toEqual([["legacy-shared", legacy.noteId]]);
  });

  it("is idempotent on retry and keeps one Note per occurrence under concurrent first edits", async () => {
    const { root, app, occurrence, unsaved } = await setup();
    await occurrence(1, "week 1\n");
    const three = unsaved(3);
    const four = unsaved(4);

    const [a, b] = await Promise.all([
      app.createMeetingFromEvent(three.externalId, undefined, undefined, "work", "three words\n"),
      app.createMeetingFromEvent(four.externalId, undefined, undefined, "work", "four words\n")
    ]);
    expect(a.note?.frontmatter.id).not.toBe(b.note?.frontmatter.id);
    expect(a.note?.body).toBe("three words\n");
    expect(b.note?.body).toBe("four words\n");

    const before = await snapshot(root);
    const retry = await app.createMeetingFromEvent(three.externalId, undefined, undefined, "work", "retry must not overwrite\n");
    expect(retry.meeting.frontmatter.id).toBe(a.meeting.frontmatter.id);
    expect(retry.note?.frontmatter.id).toBe(a.note?.frontmatter.id);
    expect(retry.note?.body).toBe("three words\n");
    // A retry may refresh this occurrence's own two files; no other file may change.
    const own = [a.meeting.frontmatter.id, a.note!.frontmatter.id];
    expect(diff(before, await snapshot(root)).changed.filter((file) => !own.some((id) => file.includes(id)))).toEqual([]);
    expect(app.notes()).toHaveLength(3);
  });
});
