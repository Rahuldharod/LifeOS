import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent, type CalendarEventReference } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class SyntheticCalendar implements CalendarConnector {
  readonly provider = "synthetic";
  readonly eventsById = new Map<string, CalendarEvent>();
  constructor(readonly events: CalendarEvent[]) {
    for (const event of events) this.eventsById.set(event.externalId, event);
  }
  async listEvents() { return this.events; }
  async getEventsByReference(references: CalendarEventReference[]) {
    return references.flatMap(({ externalId, calendarId }) => {
      const event = this.eventsById.get(externalId);
      return event && (!calendarId || event.calendarId === calendarId) ? [event] : [];
    });
  }
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

// #172 (ADR 0021): a recurring occurrence has its own Meeting and its own Note. The ADR 0019 shared-Note creation behaviour
// these tests used to cover (sections, split chains, previous-series links, title following, restore guard) no longer happens
// on creation; it survives only for stored Legacy shared Notes and goes with #178. Tests of that stored shape seed it directly.
describe("recurring meeting notes (#147, #172)", () => {
  it("gives simultaneous first edits of two occurrences one Note each and never lets a retry replace the text", async () => {
    const older = event({ externalId: "older-race", seriesId: "series-race", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const newer = event({ externalId: "newer-race", startsAt: "2026-10-12T08:00:00.000Z", endsAt: "2026-10-12T09:00:00.000Z", seriesId: "series-race", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const { app } = await setup([older, newer]);

    const [first, second] = await Promise.all([
      app.createMeetingFromEvent(older.externalId, undefined, undefined, older.calendarId, "Older tab words\n"),
      app.createMeetingFromEvent(newer.externalId, undefined, undefined, newer.calendarId, "Newer tab words\n")
    ]);

    expect(first.note?.frontmatter.id).not.toBe(second.note?.frontmatter.id);
    expect(app.notes()).toHaveLength(2);
    expect(first.note?.body).toBe("Older tab words\n");
    expect(second.note?.body).toBe("Newer tab words\n");
    expect(second.meeting.frontmatter.recurrence_occurrence_id).toContain("2026-10-12T08:00:00.000Z");

    const retry = await app.createMeetingFromEvent(newer.externalId, undefined, undefined, newer.calendarId, "Retry must not replace the first edit\n");
    expect(retry.note?.frontmatter.id).toBe(second.note?.frontmatter.id);
    expect(retry.note?.body).toBe("Newer tab words\n");
  });

  it("keeps one Meeting and one Note per occurrence, resolves a provider alias to the same Meeting, and restricts only the restricted Note", async () => {
    const first = event({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const moved = event({ externalId: "occurrence-2", startsAt: "2026-10-13T12:00:00.000Z", endsAt: "2026-10-13T13:00:00.000Z", seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const providerAlias = event({ externalId: "occurrence-1-new-provider-id", seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const { app } = await setup([first, moved, providerAlias]);

    const firstWorkspace = await app.createMeetingFromEvent(first.externalId, undefined, undefined, first.calendarId, "First notes\n");
    await app.setSensitivity(firstWorkspace.note!.frontmatter.id, "restricted", firstWorkspace.note!.contentHash);
    const secondWorkspace = await app.createMeetingFromEvent(moved.externalId, undefined, undefined, moved.calendarId, "Moved notes\n");
    const aliasedWorkspace = await app.createMeetingFromEvent(providerAlias.externalId, undefined, undefined, providerAlias.calendarId);

    expect((await app.listObjects()).filter((object) => object.frontmatter.type === "meeting")).toHaveLength(2);
    expect(app.notes()).toHaveLength(2);
    expect(secondWorkspace.note?.frontmatter.id).not.toBe(firstWorkspace.note?.frontmatter.id);
    expect(aliasedWorkspace.meeting.frontmatter.id).toBe(firstWorkspace.meeting.frontmatter.id);
    expect(secondWorkspace.note?.frontmatter.sensitivity).toBeUndefined();
    expect(secondWorkspace.note?.body).toBe("Moved notes\n");

    const retry = await app.createMeetingFromEvent(moved.externalId, undefined, undefined, moved.calendarId, "must not duplicate\n");
    expect(retry.note?.body).toBe("Moved notes\n");
  });

  it("keeps the same Meeting and Note when the provider reschedules an occurrence", async () => {
    const original = event({ externalId: "before-move", seriesId: "series-move", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const { app, calendar } = await setup([original]);
    const before = await app.createMeetingFromEvent(original.externalId, undefined, undefined, original.calendarId, "Keep these words\n");
    calendar.events.splice(0, 1, event({ externalId: "after-move", startsAt: "2026-10-06T13:00:00.000Z", endsAt: "2026-10-06T14:00:00.000Z", seriesId: "series-move", originalOccurrenceStartsAt: original.originalOccurrenceStartsAt }));

    const after = await app.createMeetingFromEvent("after-move", undefined, undefined, original.calendarId, "Must not replace notes\n");

    expect(after.meeting.frontmatter.id).toBe(before.meeting.frontmatter.id);
    expect(after.note?.frontmatter.id).toBe(before.note?.frontmatter.id);
    expect(after.note?.body).toBe("Keep these words\n");
    expect(after.meeting.frontmatter.starts_at).toBe(original.startsAt);
  });

  it("does not create a Note for a cancelled occurrence and marks an existing occurrence cancelled", async () => {
    const cancelled = event({ externalId: "cancelled-empty", seriesId: "series-cancel", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z", status: "cancelled" });
    const { app, calendar } = await setup([cancelled]);
    const preview = await app.previewMeetingFromEvent(cancelled.externalId, undefined, undefined, cancelled.calendarId);
    expect(preview.persisted).toBe(false);
    expect(app.notes()).toEqual([]);
    const untouched = await app.createMeetingFromEvent(cancelled.externalId, undefined, undefined, cancelled.calendarId);
    expect(untouched.persisted).toBe(false);
    expect((await app.listObjects()).filter((object) => object.frontmatter.type === "meeting" || object.frontmatter.type === "meeting-note")).toEqual([]);

    const confirmed = { ...cancelled, status: "confirmed" as const };
    calendar.events.splice(0, 1, confirmed);
    const written = await app.createMeetingFromEvent(confirmed.externalId, undefined, undefined, confirmed.calendarId, "Agenda notes\n");
    calendar.events.splice(0, 1, cancelled);
    const reopened = await app.createMeetingFromEvent(cancelled.externalId, undefined, undefined, cancelled.calendarId);

    expect(reopened.note?.frontmatter.id).toBe(written.note?.frontmatter.id);
    expect(reopened.note?.body).toBe("Agenda notes\n");
    expect(reopened.meeting.frontmatter.status).toBe("cancelled");
  });

  it("starts each occurrence of a provider-split series with its own Note and does not infer copied events as recurring", async () => {
    const before = event({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const after = event({ externalId: "occurrence-after-split", seriesId: "series-b", previousSeriesId: "series-a", originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z" });
    const copied = event({ externalId: "copied", title: "Copied standalone" });
    const { app } = await setup([before, after, copied]);
    const newSeries = await app.createMeetingFromEvent(after.externalId, undefined, undefined, undefined, "After split\n");
    const oldSeries = await app.createMeetingFromEvent(before.externalId, undefined, undefined, undefined, "Before split\n");
    const copy = await app.createMeetingFromEvent(copied.externalId, undefined, undefined, copied.calendarId, "plain body\n");

    expect(new Set([newSeries.note?.frontmatter.id, oldSeries.note?.frontmatter.id, copy.note?.frontmatter.id]).size).toBe(3);
    expect(newSeries.note?.frontmatter.previous_recurrence_series_id).toBeUndefined();
    expect(oldSeries.note?.frontmatter.previous_series_note_id).toBeUndefined();
    expect(copy.meeting.frontmatter.recurrence_series_id).toBeUndefined();
    expect(copy.note?.body).toBe("plain body\n");
  });

  it("recovers a pending create-meeting from the captured occurrence into the occurrence's own Note and resolves additive legacy redirects", async () => {
    const recurring = event({ seriesId: "series-a", originalOccurrenceStartsAt: "2026-10-05T08:00:00.000Z" });
    const { app, store } = await setup([]);
    const meetingId = uuidV7();
    const noteId = uuidV7();
    const operationId = uuidV7();
    await store.prepareOperation("create-meeting", { externalId: recurring.externalId, calendarId: recurring.calendarId, event: recurring, meetingId, noteId, body: "Recovered words\n" }, operationId);

    await app.recoverOperations();
    expect(app.object(meetingId).frontmatter.recurrence_occurrence_id).toContain(recurring.originalOccurrenceStartsAt);
    expect(app.object(noteId).body).toBe("Recovered words\n");
    expect(app.object(noteId).frontmatter.meeting_id).toBe(meetingId);
    expect((await app.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "meeting.created" && (object.frontmatter.metadata as { operation_id?: string }).operation_id === operationId)).toHaveLength(1);

    const legacyId = uuidV7();
    const current = app.object(noteId);
    await store.write({
      relativePath: `meetings/legacy-${legacyId}.md`,
      frontmatter: { ...current.frontmatter, id: legacyId, revision: 1, meeting_id: meetingId, redirect_to_note_id: noteId, redirect_to_section_id: "occurrence-2026-10-05t08-00-00-000z" },
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

  it("makes an exact pre-upgrade recurring Note available for reviewed migration after calendar sync", async () => {
    const legacyEvent = event({ externalId: "weekly-prio", title: "Weekly Prio" });
    const { app, calendar } = await setup([legacyEvent]);
    const legacy = await app.createMeetingFromEvent(legacyEvent.externalId, undefined, undefined, legacyEvent.calendarId, "Last week's details\n");
    calendar.eventsById.set(legacyEvent.externalId, event({
      externalId: legacyEvent.externalId,
      title: legacyEvent.title,
      seriesId: "weekly-prio-series",
      originalOccurrenceStartsAt: legacyEvent.startsAt
    }));
    calendar.events.splice(0, 1, event({
      externalId: "weekly-prio-next",
      title: legacyEvent.title,
      startsAt: "2026-10-12T08:00:00.000Z",
      endsAt: "2026-10-12T09:00:00.000Z",
      seriesId: "weekly-prio-series",
      originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z"
    }));

    await app.syncCalendar(new Date("2026-10-12T00:00:00.000Z"), new Date("2026-10-13T00:00:00.000Z"));

    expect(app.recurringMigrationPreview(legacy.meeting.frontmatter.id)).toMatchObject({
      requiresConfirmation: true,
      candidates: [{ noteId: legacy.note!.frontmatter.id, body: "Last week's details\n" }]
    });
  });

  it("previews migrated history on a new occurrence (as a Series view block) without writing until the first edit", async () => {
    const legacyEvent = event({ externalId: "weekly-prio", title: "Weekly Prio" });
    const currentEvent = event({
      externalId: "weekly-prio-next",
      title: "Weekly Prio",
      startsAt: "2026-10-12T08:00:00.000Z",
      endsAt: "2026-10-12T09:00:00.000Z",
      seriesId: "weekly-prio-series",
      originalOccurrenceStartsAt: "2026-10-12T08:00:00.000Z"
    });
    const { app, calendar } = await setup([legacyEvent]);
    const legacy = await app.createMeetingFromEvent(legacyEvent.externalId, undefined, undefined, legacyEvent.calendarId, "Last week's details\n");
    calendar.eventsById.set(legacyEvent.externalId, event({
      externalId: legacyEvent.externalId,
      title: legacyEvent.title,
      seriesId: "weekly-prio-series",
      originalOccurrenceStartsAt: legacyEvent.startsAt
    }));
    calendar.events.splice(0, 1, currentEvent);
    calendar.eventsById.set(currentEvent.externalId, currentEvent);
    await app.syncCalendar(new Date("2026-10-12T00:00:00.000Z"), new Date("2026-10-13T00:00:00.000Z"));
    const migration = app.recurringMigrationPreview(legacy.meeting.frontmatter.id);
    await app.confirmRecurringMigration(legacy.meeting.frontmatter.id, Object.fromEntries(migration.candidates.map((candidate) => [candidate.noteId, candidate.contentHash])));
    const before = await app.listObjects();

    const current = await app.previewMeetingFromEvent(currentEvent.externalId, undefined, undefined, currentEvent.calendarId);

    expect(current).toMatchObject({
      persisted: false,
      note: undefined,
      seriesView: { earlier: [{ kind: "legacy-shared", note: { body: expect.stringContaining("Last week's details") } }] }
    });
    expect(await app.listObjects()).toEqual(before);

    const sharedIds = (await app.listObjects()).filter((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.recurrence_series_id).map((object) => object.frontmatter.id);
    expect(sharedIds).toHaveLength(1);
    const sharedBefore = [app.object(sharedIds[0]!)];

    const saved = await app.createMeetingFromEvent(currentEvent.externalId, undefined, undefined, currentEvent.calendarId, "This week's details\n");
    // #172: the first edit makes this occurrence's own Note; the migrated Legacy shared Note is neither extended nor rewritten.
    expect(saved.note?.body).toBe("This week's details\n");
    expect(saved.note?.frontmatter.occurrence_sections).toBeUndefined();
    expect(saved.note?.frontmatter.id).not.toBe(sharedBefore[0]!.frontmatter.id);
    const sharedAfter = app.object(sharedBefore[0]!.frontmatter.id);
    expect(sharedAfter.contentHash).toBe(sharedBefore[0]!.contentHash);
    expect(sharedAfter.body).toBe(sharedBefore[0]!.body);
  });
});
