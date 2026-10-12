import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent, type CalendarEventReference } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { occurrenceNotes, replaceOccurrenceNotes } from "../../apps/web/src/RecurringOccurrenceWorkspace.js";
import { CrashingStore } from "./crash-store.js";
import { seedLegacySharedNote } from "./legacy-shared-note.js";

// #172 review: ADR 0021 says a Legacy shared Note "stays as is". Nothing the app does on its own (Calendar sync, re-opening a
// Meeting, a first-edit retry, replaying an old journal) may rewrite that file; only the user's own edit of it may.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class SyntheticCalendar implements CalendarConnector {
  readonly provider = "synthetic";
  constructor(public events: CalendarEvent[]) {}
  async listEvents() { return this.events; }
  async getEventsByReference(references: CalendarEventReference[]) {
    return references.flatMap(({ externalId, calendarId }) => this.events.filter((event) => event.externalId === externalId && (!calendarId || event.calendarId === calendarId)));
  }
}

const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}T08:00:00.000Z`;
const occurrence = (n: number, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  externalId: `event-${n}`, calendarId: "work", title: "Weekly planning", startsAt: day(n), endsAt: day(n).replace("T08", "T09"),
  timezone: "Europe/Paris", attendees: [], seriesId: "stays", originalOccurrenceStartsAt: day(n), ...overrides
});

async function setup(events: CalendarEvent[]) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-legacy-stays-"));
  roots.push(root);
  const calendar = new SyntheticCalendar(events);
  const store = new CrashingStore(root);
  const app = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "legacy-stays-test");
  return { root, app, calendar, store };
}
const read = (root: string, noteId: string) => readdir(path.join(root, "meetings")).then((files) => readFile(path.join(root, "meetings", files.find((file) => file.includes(noteId))!), "utf8"));
const window = { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-10-01T00:00:00.000Z") };

describe("a Legacy shared Note is never rewritten by the app on its own (#172, ADR 0021)", () => {
  it("stays byte-identical across Calendar sync, re-opening and a first-edit retry, even when the Calendar title changed", async () => {
    const one = occurrence(1);
    const two = occurrence(2);
    const { root, app, calendar } = await setup([one, two]);
    const legacy = await seedLegacySharedNote(root, "synthetic", [{ event: one, body: "one\n" }, { event: two, body: "two\n" }]);
    await app.rebuildIndex();
    const before = await read(root, legacy.noteId);

    calendar.events = [occurrence(1, { title: "Renamed planning" }), occurrence(2, { title: "Renamed planning" })];
    await app.syncCalendar(window.from, window.to);
    await app.createMeetingFromEvent("event-2", window.from, window.to, "work");
    await app.createMeetingFromEvent("event-2", window.from, window.to, "work", "retry body must be ignored\n");
    await app.previewMeetingFromEvent("event-1", window.from, window.to, "work");
    await app.rebuildIndex();

    expect(await read(root, legacy.noteId)).toBe(before);
  });

  it("never updates a Legacy successor when its predecessor series is opened, and writes no link-recurring-series journal", async () => {
    const before = occurrence(1, { seriesId: "series-a" });
    const after = occurrence(2, { seriesId: "series-b", previousSeriesId: "series-a" });
    const { root, app, store } = await setup([before, after]);
    await seedLegacySharedNote(root, "synthetic", [{ event: before, body: "old series\n" }]);
    const successor = await seedLegacySharedNote(root, "synthetic", [{ event: after, body: "new series\n" }], { previous_recurrence_series_id: "synthetic:work:series-a", previous_recurrence_series_source: "provider" });
    await app.rebuildIndex();
    const successorBefore = await read(root, successor.noteId);

    store.arm();
    await app.createMeetingFromEvent("event-1", window.from, window.to, "work");
    await app.rebuildIndex();

    expect(await read(root, successor.noteId)).toBe(successorBefore);
    expect(store.log.filter((entry) => entry.includes("link-recurring-series"))).toEqual([]);
  });

  it("still recovers an old pending link-recurring-series journal: closes it and leaves the Legacy Notes untouched", async () => {
    const before = occurrence(1, { seriesId: "series-a" });
    const after = occurrence(2, { seriesId: "series-b", previousSeriesId: "series-a" });
    const { root, app, store } = await setup([before, after]);
    const predecessor = await seedLegacySharedNote(root, "synthetic", [{ event: before, body: "old series\n" }]);
    const successor = await seedLegacySharedNote(root, "synthetic", [{ event: after, body: "new series\n" }], { previous_recurrence_series_id: "synthetic:work:series-a", previous_recurrence_series_source: "provider" });
    const operationId = uuidV7();
    await store.prepareOperation("link-recurring-series", { seriesId: "synthetic:work:series-a", noteId: predecessor.noteId, now: "2026-10-11T10:00:00.000Z" }, operationId);
    await app.rebuildIndex();
    const [predecessorBefore, successorBefore] = [await read(root, predecessor.noteId), await read(root, successor.noteId)];

    await app.recoverOperations();
    await app.recoverOperations();

    expect((await store.incompleteOperations()).find((operation) => operation.id === operationId)).toBeUndefined();
    expect((await app.health()).diagnostics.filter((line) => line.startsWith("Recovery of"))).toEqual([]);
    expect(await read(root, predecessor.noteId)).toBe(predecessorBefore);
    expect(await read(root, successor.noteId)).toBe(successorBefore);
  });

  it("opens a stored occurrence of a Legacy shared Note with its section workspace, and saving a section saves the whole Note", async () => {
    const one = occurrence(1);
    const two = occurrence(2);
    const { root, app } = await setup([one, two]);
    const legacy = await seedLegacySharedNote(root, "synthetic", [{ event: one, body: "first week\n" }, { event: two, body: "second week\n" }]);
    await app.rebuildIndex();
    const older = legacy.items.find((item) => item.event === one)!;

    const workspace = await app.meetingWorkspace(older.meetingId);
    expect(workspace.note?.frontmatter.id).toBe(legacy.noteId);
    const items = workspace.occurrences ?? [];
    expect(items.map((item) => item.sectionId)).toEqual(legacy.items.map((item) => item.sectionId));
    expect(occurrenceNotes(workspace.note!.body, items, older.sectionId).trim()).toBe("first week");

    const edited = replaceOccurrenceNotes(workspace.note!.body, items, older.sectionId, "first week, edited");
    const saved = await app.updateBody(legacy.noteId, edited, workspace.note!.contentHash);

    expect(saved.body).toContain("first week, edited");
    expect(saved.body).toContain("second week");
    expect(saved.frontmatter.occurrence_sections).toEqual(workspace.note!.frontmatter.occurrence_sections);
    expect(saved.frontmatter.meeting_ids).toEqual(workspace.note!.frontmatter.meeting_ids);
    expect(await read(root, legacy.noteId)).toContain("first week, edited");
  });
});

describe("create-meeting crash replay (#172, ADR 0013)", () => {
  it("replays a first edit crashed after the Meeting but before the Note into the occurrence's own Note, whatever the crash point", async () => {
    const one = occurrence(1);
    const next = occurrence(3);
    const crashPoints: string[] = [];
    let changes = 0;
    for (let crashAfter: number | undefined = undefined, attempt = 0; attempt === 0 || (crashAfter ?? 0) <= changes; crashAfter = (crashAfter ?? 0) + 1, attempt += 1) {
      const { root, app, store, calendar } = await setup([one, next]);
      const legacy = await seedLegacySharedNote(root, "synthetic", [{ event: one, body: "legacy\n" }]);
      await app.rebuildIndex();
      const legacyBefore = await read(root, legacy.noteId);
      store.arm(crashAfter);
      await app.createMeetingFromEvent("event-3", window.from, window.to, "work", "crash-proof words\n").catch(() => undefined);
      if (crashAfter === undefined) changes = store.changes;
      else crashPoints.push(store.log.at(-1)!);

      const restarted = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "legacy-stays-test");
      await restarted.rebuildIndex();
      await restarted.recoverOperations();
      await restarted.rebuildIndex();
      const workspace = await restarted.createMeetingFromEvent("event-3", window.from, window.to, "work", "crash-proof words\n");

      const at = `crash after change ${crashAfter ?? "none"}`;
      expect.soft(await read(root, legacy.noteId), `${at}: Legacy Note untouched`).toBe(legacyBefore);
      expect.soft(workspace.note?.body, at).toBe("crash-proof words\n");
      expect.soft(workspace.note?.frontmatter.id, at).not.toBe(legacy.noteId);
      expect.soft(workspace.note?.frontmatter.occurrence_sections, at).toBeUndefined();
      expect.soft(restarted.notes().filter((note) => note.frontmatter.meeting_id === workspace.meeting.frontmatter.id), `${at}: one Note for the occurrence`).toHaveLength(1);
      expect.soft((await restarted.listObjects()).filter((object) => object.frontmatter.type === "meeting"), `${at}: Meetings`).toHaveLength(2);
    }
    // At least one crash point left the Meeting written and the Note not.
    expect(crashPoints.some((entry) => entry.startsWith("write meeting \""))).toBe(true);
  });
});
