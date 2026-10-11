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
  const app = new LifeOSApplication(store, new MemoryIndex(), new SyntheticCalendar(events), undefined, "recurrence-test");
  await app.rebuildIndex();
  return { root, store, app };
}

describe("recurring meeting notes (#147)", () => {
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
