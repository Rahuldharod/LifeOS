import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class SyntheticCalendar implements CalendarConnector {
  readonly provider = "synthetic";
  constructor(readonly events: CalendarEvent[]) {}
  async listEvents() { return this.events; }
}

const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  externalId: "occurrence-1", calendarId: "work", title: "Weekly planning",
  startsAt: "2026-10-05T08:00:00.000Z", endsAt: "2026-10-05T09:00:00.000Z",
  timezone: "Europe/Paris", attendees: [], ...overrides
});

async function setup(events: CalendarEvent[]) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-recurrence-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const calendar = new SyntheticCalendar(events);
  const app = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "recurrence-test");
  await app.rebuildIndex();
  return { root, store, app, calendar };
}

describe("recurring meeting notes (#147)", () => {
  it("serializes simultaneous first edits into one canonical Note with one stable section per occurrence", async () => {
    const older = event({ externalId: "older-race", seriesId: "series-race", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const newer = event({ externalId: "newer-race", startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z", seriesId: "series-race", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const { app } = await setup([older, newer]);

    const [first, second] = await Promise.all([
      app.createMeetingFromEvent(older.externalId, undefined, undefined, older.calendarId, "Older tab words\n"),
      app.createMeetingFromEvent(newer.externalId, undefined, undefined, newer.calendarId, "Newer tab words\n")
    ]);

    expect(first.note?.frontmatter.id).toBe(second.note?.frontmatter.id);
    expect(app.notes()).toHaveLength(1);
    const sections = second.note?.frontmatter.occurrence_sections as Array<{ occurrence_id: string; section_id: string }>;
    expect(new Set(sections.map(({ occurrence_id }) => occurrence_id)).size).toBe(2);
    expect(new Set(sections.map(({ section_id }) => section_id)).size).toBe(2);

    const retry = await app.createMeetingFromEvent(newer.externalId, undefined, undefined, newer.calendarId, "Retry must not replace the first edit\n");
    expect(retry.note?.body).toContain("Newer tab words");
    expect(retry.note?.body).not.toContain("Retry must not replace");
    expect(retry.note?.frontmatter.occurrence_sections).toHaveLength(2);
  });

  it("keeps one Meeting per occurrence and one Note per series with stable newest-first sections", async () => {
    const first = event({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const moved = event({ externalId: "occurrence-2", startsAt: "2026-10-13T12:00:00.000Z", endsAt: "2026-10-13T13:00:00.000Z", seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const providerAlias = event({ externalId: "occurrence-1-new-provider-id", seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const { app } = await setup([first, moved, providerAlias]);

    const firstWorkspace = await app.createMeetingFromEvent(first.externalId, undefined, undefined, first.calendarId, "First notes\n");
    await app.setSensitivity(firstWorkspace.note!.frontmatter.id, "restricted", firstWorkspace.note!.contentHash);
    const secondWorkspace = await app.createMeetingFromEvent(moved.externalId, undefined, undefined, moved.calendarId, "Moved notes\n");
    const aliasedWorkspace = await app.createMeetingFromEvent(providerAlias.externalId, undefined, undefined, providerAlias.calendarId);

    expect((await app.listObjects()).filter((object) => object.frontmatter.type === "meeting")).toHaveLength(2);
    expect(app.notes()).toHaveLength(1);
    expect(secondWorkspace.note?.frontmatter.id).toBe(firstWorkspace.note?.frontmatter.id);
    expect(aliasedWorkspace.meeting.frontmatter.id).toBe(firstWorkspace.meeting.frontmatter.id);
    expect(secondWorkspace.note?.frontmatter.sensitivity).toBe("restricted");
    expect((secondWorkspace.note?.frontmatter.meeting_ids as string[])).toEqual([secondWorkspace.meeting.frontmatter.id, firstWorkspace.meeting.frontmatter.id]);
    const sections = secondWorkspace.note?.frontmatter.occurrence_sections as Array<Record<string, string>>;
    expect(sections.map((section) => section.original_starts_at)).toEqual(["2026-10-12T08:00:00.000Z", "2026-10-05T08:00:00.000Z"]);
    expect(secondWorkspace.meeting.frontmatter.recurrence_occurrence_id).toContain("2026-10-12T08:00:00.000Z");
    expect(secondWorkspace.note?.body.indexOf("Moved notes")).toBeLessThan(secondWorkspace.note!.body.indexOf("First notes"));

    const retry = await app.createMeetingFromEvent(moved.externalId, undefined, undefined, moved.calendarId, "must not duplicate\n");
    expect((retry.note?.frontmatter.occurrence_sections as unknown[])).toHaveLength(2);
    expect(retry.note?.body).not.toContain("must not duplicate");
  });

  it("keeps occurrence metadata and body sections newest-first when older edits arrive later", async () => {
    const older = event({ externalId: "older", seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const newer = event({ externalId: "newer", startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z", seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const { app } = await setup([older, newer]);
    await app.createMeetingFromEvent(newer.externalId, undefined, undefined, newer.calendarId, "Newer words\n");
    const workspace = await app.createMeetingFromEvent(older.externalId, undefined, undefined, older.calendarId, "Older words\n");

    expect((workspace.note!.frontmatter.occurrence_sections as Array<{ original_starts_at: string }>).map((section) => section.original_starts_at)).toEqual([newer.originalOccurrenceStartsAt, older.originalOccurrenceStartsAt]);
    expect(workspace.note!.body.indexOf("Newer words")).toBeLessThan(workspace.note!.body.indexOf("Older words"));
  });

  it("orders sections by actual occurrence time while immutable original time keeps section identity", async () => {
    const movedLater = event({ externalId: "moved-later", startsAt: "2026-10-20T08:00:00.000Z", endsAt: "2026-10-20T09:00:00.000Z", seriesId: "series-moved", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const ordinary = event({ externalId: "ordinary", startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z", seriesId: "series-moved", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const { app } = await setup([movedLater, ordinary]);
    await app.createMeetingFromEvent(movedLater.externalId, undefined, undefined, movedLater.calendarId, "Moved later words\n");
    const workspace = await app.createMeetingFromEvent(ordinary.externalId, undefined, undefined, ordinary.calendarId, "Ordinary words\n");

    const sections = workspace.note!.frontmatter.occurrence_sections as Array<{ original_starts_at: string; starts_at: string }>;
    expect(sections.map(({ starts_at }) => starts_at)).toEqual([movedLater.startsAt, ordinary.startsAt]);
    expect(sections[0]!.original_starts_at).toBe(movedLater.originalOccurrenceStartsAt);
    expect(workspace.note!.body.indexOf("Moved later words")).toBeLessThan(workspace.note!.body.indexOf("Ordinary words"));
  });

  it("keeps the same Meeting, Note and section when the provider reschedules an occurrence", async () => {
    const original = event({ externalId: "before-move", seriesId: "series-move", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const { app, calendar } = await setup([original]);
    const before = await app.createMeetingFromEvent(original.externalId, undefined, undefined, original.calendarId, "Keep these words\n");
    const sectionId = (before.note!.frontmatter.occurrence_sections as Array<{ section_id: string }>)[0]!.section_id;
    calendar.events.splice(0, 1, event({ externalId: "after-move", startsAt: "2026-10-06T13:00:00.000Z", endsAt: "2026-10-06T14:00:00.000Z", seriesId: "series-move", originalOccurrenceStartsAt: original.originalOccurrenceStartsAt }));

    const after = await app.createMeetingFromEvent("after-move", undefined, undefined, original.calendarId, "Must not replace notes\n");

    expect(after.meeting.frontmatter.id).toBe(before.meeting.frontmatter.id);
    expect(after.note?.frontmatter.id).toBe(before.note?.frontmatter.id);
    expect((after.note!.frontmatter.occurrence_sections as Array<{ section_id: string }>)[0]!.section_id).toBe(sectionId);
    expect(after.note?.body).toContain("Keep these words");
    expect(after.note?.body).not.toContain("Must not replace notes");
    expect(after.meeting.frontmatter.starts_at).toBe(original.startsAt);
  });

  it("does not create an empty section for a cancelled occurrence and labels an existing section Cancelled", async () => {
    const cancelled = event({ externalId: "cancelled-empty", seriesId: "series-cancel", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z", status: "cancelled" });
    const { app, calendar } = await setup([cancelled]);
    const preview = await app.previewMeetingFromEvent(cancelled.externalId, undefined, undefined, cancelled.calendarId);
    expect(preview.persisted).toBe(false);
    expect(app.notes()).toEqual([]);

    const confirmed = { ...cancelled, status: "confirmed" as const };
    calendar.events.splice(0, 1, confirmed);
    const written = await app.createMeetingFromEvent(confirmed.externalId, undefined, undefined, confirmed.calendarId, "Agenda notes\n");
    calendar.events.splice(0, 1, cancelled);
    const reopened = await app.createMeetingFromEvent(cancelled.externalId, undefined, undefined, cancelled.calendarId);

    expect(reopened.note?.frontmatter.id).toBe(written.note?.frontmatter.id);
    expect(reopened.note?.frontmatter.occurrence_sections).toHaveLength(1);
    expect(reopened.meeting.frontmatter.status).toBe("cancelled");
  });

  it("follows Calendar title changes until the shared Note is manually renamed", async () => {
    const first = event({ externalId: "title-first", title: "Weekly planning", seriesId: "series-title", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const renamed = event({ externalId: "title-second", title: "Delivery planning", startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z", seriesId: "series-title", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const later = event({ externalId: "title-third", title: "Planning renamed again", startsAt: "2026-10-19T08:00:00.000Z", endsAt: "2026-10-19T09:00:00.000Z", seriesId: "series-title", originalOccurrenceStartsAt: "2026-10-19T08:00:00.000Z" });
    const { app } = await setup([first, renamed, later]);

    const created = await app.createMeetingFromEvent(first.externalId, undefined, undefined, first.calendarId, "First\n");
    const followed = await app.createMeetingFromEvent(renamed.externalId, undefined, undefined, renamed.calendarId, "Second\n");
    expect(followed.note?.frontmatter.title).toBe("Delivery planning notes");

    const custom = await app.updateNoteMetadata(followed.note!.frontmatter.id, { title: "My delivery journal" }, followed.note!.contentHash);
    expect(custom.frontmatter.title_manually_renamed).toBe(true);
    const preserved = await app.createMeetingFromEvent(later.externalId, undefined, undefined, later.calendarId, "Third\n");
    expect(preserved.note?.frontmatter.title).toBe("My delivery journal");
    expect(preserved.note?.frontmatter.id).toBe(created.note?.frontmatter.id);
  });

  it("starts a linked Note after a provider split and does not infer copied events as recurring", async () => {
    const before = event({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const after = event({ externalId: "occurrence-after-split", seriesId: "series-b", previousSeriesId: "series-a", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const copied = event({ externalId: "copied", title: "Copied standalone" });
    const { app } = await setup([before, after, copied]);
    const newSeries = await app.createMeetingFromEvent(after.externalId);
    expect(newSeries.note?.frontmatter.previous_recurrence_series_id).toBe("synthetic:work:series-a");
    expect(newSeries.note?.frontmatter.previous_series_note_id).toBeUndefined();
    const oldSeries = await app.createMeetingFromEvent(before.externalId);
    const copy = await app.createMeetingFromEvent(copied.externalId, undefined, undefined, copied.calendarId, "plain body\n");

    expect(newSeries.note?.frontmatter.id).not.toBe(oldSeries.note?.frontmatter.id);
    expect(app.object(newSeries.note!.frontmatter.id).frontmatter.previous_series_note_id).toBe(oldSeries.note?.frontmatter.id);
    expect(copy.note?.frontmatter.recurrence_series_id).toBeUndefined();
    expect(copy.note?.body).toBe("plain body\n");
  });

  it("keeps copied, moved and restarted lookalike series separate, then links a restart only on explicit request", async () => {
    const first = event({ externalId: "first-series", seriesId: "series-first", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z", attendees: ["same@example.com"] });
    const moved = event({ externalId: "moved-calendar", calendarId: "other", seriesId: "series-first", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z", attendees: ["same@example.com"] });
    const copied = event({ externalId: "copied-series", seriesId: "series-copy", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z", attendees: ["same@example.com"] });
    const restarted = event({ externalId: "restarted-series", seriesId: "series-restart", originalOccurrenceStartsAt: "2026-11-02T08:00:00.000Z", attendees: ["same@example.com"] });
    const { app } = await setup([first, moved, copied, restarted]);
    const prior = await app.createMeetingFromEvent(first.externalId, undefined, undefined, first.calendarId, "First\n");
    const movedWorkspace = await app.createMeetingFromEvent(moved.externalId, undefined, undefined, moved.calendarId, "Moved\n");
    const copiedWorkspace = await app.createMeetingFromEvent(copied.externalId, undefined, undefined, copied.calendarId, "Copied\n");
    const restart = await app.createMeetingFromEvent(restarted.externalId, undefined, undefined, restarted.calendarId, "Restarted\n");

    expect(new Set([prior.note?.frontmatter.id, movedWorkspace.note?.frontmatter.id, copiedWorkspace.note?.frontmatter.id, restart.note?.frontmatter.id]).size).toBe(4);
    expect(restart.note?.frontmatter.previous_series_note_id).toBeUndefined();
    const [linked, retry] = await Promise.all([
      app.linkPreviousSeriesNote(restart.note!.frontmatter.id, prior.note!.frontmatter.id, restart.note!.contentHash),
      app.linkPreviousSeriesNote(restart.note!.frontmatter.id, prior.note!.frontmatter.id, restart.note!.contentHash)
    ]);
    expect(linked.frontmatter.previous_series_note_id).toBe(prior.note?.frontmatter.id);
    expect(retry.frontmatter.previous_series_note_id).toBe(prior.note?.frontmatter.id);
    expect(app.object(restart.note!.frontmatter.id).frontmatter.previous_recurrence_series_id).toBe(prior.note?.frontmatter.recurrence_series_id);
  });

  it("refuses to restore a deleted series Note when any newer live canonical Note exists for the series", async () => {
    const first = event({ externalId: "restore-first", seriesId: "series-restore", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const later = event({ externalId: "restore-later", startsAt: "2026-10-12T08:00:00.000Z", seriesId: "series-restore", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const { app } = await setup([first, later]);
    const canonical = await app.createMeetingFromEvent(first.externalId, undefined, undefined, first.calendarId, "Old canonical\n");
    const deleted = await app.deleteNote(canonical.note!.frontmatter.id, canonical.note!.contentHash);
    const replacement = await app.createMeetingFromEvent(later.externalId, undefined, undefined, later.calendarId, "New canonical\n");

    expect(replacement.note?.frontmatter.id).not.toBe(canonical.note?.frontmatter.id);
    await expect(app.restoreNote(canonical.note!.frontmatter.id, deleted.contentHash)).rejects.toThrow("newer live canonical Note");
  });

  it("reconciles a split seen in a later day query using provider series identity", async () => {
    const before = event({ seriesId: "series-a", seriesUid: "provider-series", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const after = event({ externalId: "occurrence-after-split", seriesId: "series-b", seriesUid: "provider-series", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const calendar = new SyntheticCalendar([before]);
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-recurrence-days-"));
    roots.push(root);
    const app = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "recurrence-test");
    await app.rebuildIndex();
    const oldSeries = await app.createMeetingFromEvent(before.externalId);
    calendar.events.splice(0, calendar.events.length, after);

    const newSeries = await app.createMeetingFromEvent(after.externalId);

    expect(newSeries.note?.frontmatter.previous_recurrence_series_id).toBe("synthetic:work:series-a");
    expect(newSeries.note?.frontmatter.previous_series_note_id).toBe(oldSeries.note?.frontmatter.id);
  });

  it("converges a new-first, three-series split chain by occurrence chronology", async () => {
    const first = event({ externalId: "first", seriesId: "series-a", seriesUid: "provider-series", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const middle = event({ externalId: "middle", seriesId: "series-b", seriesUid: "provider-series", startsAt: "2026-10-12T08:00:00.000Z", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const newest = event({ externalId: "newest", seriesId: "series-c", seriesUid: "provider-series", startsAt: "2026-10-19T08:00:00.000Z", originalOccurrenceStartsAt: "2026-10-19T08:00:00.000Z" });
    const { app } = await setup([first, middle, newest]);
    const newestSeries = await app.createMeetingFromEvent(newest.externalId);
    const firstSeries = await app.createMeetingFromEvent(first.externalId);
    expect(app.object(newestSeries.note!.frontmatter.id).frontmatter.previous_series_note_id).toBe(firstSeries.note!.frontmatter.id);

    const middleSeries = await app.createMeetingFromEvent(middle.externalId);
    const repairedNewest = app.object(newestSeries.note!.frontmatter.id);
    expect(middleSeries.note!.frontmatter.previous_series_note_id).toBe(firstSeries.note!.frontmatter.id);
    expect(repairedNewest.frontmatter.previous_series_note_id).toBe(middleSeries.note!.frontmatter.id);
    expect(repairedNewest.frontmatter.previous_recurrence_series_id).toBe("synthetic:work:series-b");
  });

  it("replays an interrupted predecessor link repair without duplicating work", async () => {
    const before = event({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const after = event({ externalId: "occurrence-after-split", seriesId: "series-b", previousSeriesId: "series-a", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const { app, store } = await setup([before, after]);
    const oldSeries = await app.createMeetingFromEvent(before.externalId);
    const newSeries = await app.createMeetingFromEvent(after.externalId);
    const successor = app.object(newSeries.note!.frontmatter.id);
    await store.write({
      relativePath: successor.relativePath,
      expectedHash: successor.contentHash,
      frontmatter: { ...successor.frontmatter, revision: successor.frontmatter.revision + 1, previous_series_note_id: undefined },
      body: successor.body
    });
    const operationId = uuidV7();
    await store.prepareOperation("link-recurring-series", {
      seriesId: oldSeries.note!.frontmatter.recurrence_series_id,
      noteId: oldSeries.note!.frontmatter.id,
      now: "2026-10-11T10:00:00.000Z"
    }, operationId);
    await app.rebuildIndex();

    await app.recoverOperations();
    await app.recoverOperations();
    await app.rebuildIndex();

    expect(app.object(newSeries.note!.frontmatter.id).frontmatter.previous_series_note_id).toBe(oldSeries.note!.frontmatter.id);
    expect((await store.incompleteOperations()).find((operation) => operation.id === operationId)).toBeUndefined();
  });

  it("recovers from the captured occurrence and resolves additive legacy redirects", async () => {
    const recurring = event({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const { app, store } = await setup([]);
    const meetingId = uuidV7();
    const noteId = uuidV7();
    const operationId = uuidV7();
    await store.prepareOperation("create-meeting", { externalId: recurring.externalId, calendarId: recurring.calendarId, event: recurring, meetingId, noteId, body: "Recovered words\n" }, operationId);

    await app.recoverOperations();
    expect(app.object(meetingId).frontmatter.recurrence_occurrence_id).toContain(recurring.originalOccurrenceStartsAt);
    expect(app.object(noteId).body).toContain("Recovered words");
    expect((await app.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "meeting.created" && (object.frontmatter.metadata as { operation_id?: string }).operation_id === operationId)).toHaveLength(1);

    const legacyId = uuidV7();
    const current = app.object(noteId);
    await store.write({
      relativePath: `meetings/legacy-${legacyId}.md`,
      frontmatter: { ...current.frontmatter, id: legacyId, revision: 1, meeting_id: meetingId, redirect_to_note_id: noteId, redirect_to_section_id: (current.frontmatter.occurrence_sections as Array<{ section_id: string }>)[0]!.section_id },
      body: "Legacy content remains intact.\n"
    });
    await app.rebuildIndex();
    expect(app.resolveObjectLink(legacyId)).toMatchObject({ object: { frontmatter: { id: noteId } }, redirectedFrom: [legacyId] });
  });

  it("does not rewrite legacy one-off Markdown or drop unknown content", async () => {
    const oneOff = event({ externalId: "one-off", title: "One off" });
    const recurring = event({ externalId: "recurring", seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const { app, store, root } = await setup([oneOff, recurring]);
    const legacy = await app.createMeetingFromEvent(oneOff.externalId, undefined, undefined, oneOff.calendarId, "Legacy body exactly.\n");
    const withUnknown = await store.write({ relativePath: legacy.note!.relativePath, expectedHash: legacy.note!.contentHash, frontmatter: { ...legacy.note!.frontmatter, revision: 2, future_field: { keep: true } }, body: legacy.note!.body });
    const before = await readFile(path.join(root, withUnknown.relativePath), "utf8");
    await app.rebuildIndex();

    await app.createMeetingFromEvent(recurring.externalId);

    expect(await readFile(path.join(root, withUnknown.relativePath), "utf8")).toBe(before);
  });
});
