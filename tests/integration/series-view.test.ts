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
const day = (n: number) => new Date(Date.UTC(2026, 8, n, 8)).toISOString();
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
  const occurrence = async (n: number, note?: string, options: { series?: string; cancelled?: boolean; previousSeries?: string; title?: string; recurring?: boolean; restricted?: boolean; archivedMeeting?: boolean; deletedNote?: boolean; movedTo?: { startsAt: string; endsAt: string } } = {}) => {
    const event = calendarEvent(n, { ...(options.series ? { seriesId: options.series } : {}), ...(options.cancelled ? { status: "cancelled" as const } : {}), ...(options.previousSeries ? { previousSeriesId: options.previousSeries } : {}), ...(options.movedTo ?? {}), ...(options.title ? { title: options.title } : {}), ...(options.recurring === false ? { seriesId: undefined, originalOccurrenceStartsAt: undefined } : {}) });
    events.push(event);
    const meetingId = await writeMeeting(n, event, options.recurring !== false, { ...(options.archivedMeeting ? { archived_at: "2026-09-02T08:00:00.000Z" } : {}), ...(options.cancelled ? { status: "cancelled" } : {}), ...(options.previousSeries ? { previous_recurrence_series_id: `synthetic:work:${options.previousSeries}` } : {}) }, options.series ? `synthetic:work:${options.series}` : SERIES);
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

type View = { seriesView?: { earlier: Array<{ kind: string; range: { startsAt: string; endsAt: string }; note: { body: string; frontmatter: { id: string; sensitivity?: string } }; materials?: { summary?: string; sources: Array<{ title: string }> } }> } };
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
    expect(shared).toMatchObject({ kind: "legacy-shared", range: { startsAt: day(2), endsAt: day(4).replace("T08", "T09") } });
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

  it("still works for a new occurrence whose provider event has a series but no original start (anchors on startsAt)", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "week 1\n");
    await occurrence(2, "week 2\n");
    unsaved(5, { originalOccurrenceStartsAt: undefined });
    await app.rebuildIndex();

    expect(bodies(await preview(app, 5))).toEqual(["week 2", "week 1"]);
  });

  it("keeps a Legacy shared Note that also covers later Meetings, positioned at its newest earlier Meeting", async () => {
    const { app, occurrence, legacyShared, unsaved } = await setup();
    await occurrence(1, "separate week 1\n");
    await legacyShared([2, 3, 9], "shared legacy body\n");
    await occurrence(4, "separate week 4\n");
    unsaved(5);
    await app.rebuildIndex();

    const workspace = await preview(app, 5);

    expect(bodies(workspace)).toEqual(["separate week 4", "shared legacy body", "separate week 1"]);
  });

  it("builds a Legacy shared Note's date range only from linked Meetings of the same series", async () => {
    const { app, legacyShared, unsaved } = await setup();
    await legacyShared([3, 4], "shared legacy body\n", [1, 8]);
    unsaved(6);
    await app.rebuildIndex();

    const shared = (await preview(app, 6)).seriesView!.earlier[0]!;

    expect(shared.range).toEqual({ startsAt: day(3), endsAt: day(4).replace("T08", "T09") });
  });

  it("writes nothing when opening a stored occurrence whose series has a Legacy shared Note", async () => {
    const { app, root, legacyShared, occurrence } = await setup();
    await legacyShared([1, 2], "shared legacy body\n");
    await occurrence(3, "week 3\n");
    await app.rebuildIndex();
    const before = await snapshot(root);

    const workspace = await preview(app, 3);

    expect(bodies(workspace)).toEqual(["shared legacy body"]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("skips archived Meetings and deleted Notes", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "live week 1\n");
    await occurrence(2, "archived meeting\n", { archivedMeeting: true });
    await occurrence(3, "deleted note\n", { deletedNote: true });
    unsaved(5);
    await app.rebuildIndex();

    expect(bodies(await preview(app, 5))).toEqual(["live week 1"]);
  });

  it("lists a restricted Note and flags it as restricted", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "secret week\n", { restricted: true });
    unsaved(5);
    await app.rebuildIndex();

    const [entry] = (await preview(app, 5)).seriesView!.earlier;

    expect(entry!.note.frontmatter.sensitivity).toBe("restricted");
  });

  it("orders a moved occurrence by its original start, not its moved start", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(2, "original week 2, moved to the 20th\n", { movedTo: { startsAt: "2026-09-20T08:00:00.000Z", endsAt: "2026-09-20T09:00:00.000Z" } });
    await occurrence(3, "week 3\n");
    unsaved(5);
    await app.rebuildIndex();

    expect(bodies(await preview(app, 5))).toEqual(["week 3", "original week 2, moved to the 20th"]);
  });
});

type Page = { earlier: Array<{ kind: string; cancelled?: boolean; note: { body: string } }>; nextCursor?: string };
type Paged = { seriesView?: Page & { newer?: { meetingId: string; startsAt: string } } };
const pageBodies = (page: Page) => page.earlier.map((entry) => entry.note.body.trim());
/** Reads every further page the way "Load older" does. */
async function loadAll(app: LifeOSApplication, first: Page) {
  const pages = [pageBodies(first)];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await app.seriesViewPage(cursor) as Page;
    pages.push(pageBodies(page));
    cursor = page.nextCursor;
  }
  return pages;
}

describe("Series view paging and splits (#180)", () => {
  it("pages 4 earlier Notes at a time through a cursor until none remain", async () => {
    const { app, occurrence, unsaved } = await setup();
    for (let n = 1; n <= 10; n += 1) await occurrence(n, `week ${n}\n`);
    await occurrence(11); // no Note: never counted
    unsaved(12);
    await app.rebuildIndex();

    const first = ((await preview(app, 12)) as Paged).seriesView!;

    expect(await loadAll(app, first)).toEqual([["week 10", "week 9", "week 8", "week 7"], ["week 6", "week 5", "week 4", "week 3"], ["week 2", "week 1"]]);
  });

  it("has no cursor when everything fits in the first page", async () => {
    const { app, occurrence, unsaved } = await setup();
    for (let n = 1; n <= 4; n += 1) await occurrence(n, `week ${n}\n`);
    unsaved(6);
    await app.rebuildIndex();

    expect(((await preview(app, 6)) as Paged).seriesView!.nextCursor).toBeUndefined();
  });

  it("counts occurrences, not weeks: a monthly series pages the same way", async () => {
    const { app, occurrence, unsaved } = await setup();
    for (let m = 0; m < 6; m += 1) await occurrence(1 + m * 30, `month ${m}\n`);
    unsaved(1 + 6 * 30);
    await app.rebuildIndex();

    const first = ((await preview(app, 181)) as Paged).seriesView!;

    expect(await loadAll(app, first)).toEqual([["month 5", "month 4", "month 3", "month 2"], ["month 1", "month 0"]]);
  });

  it("shows a Legacy shared Note once across pages", async () => {
    const { app, occurrence, legacyShared, unsaved } = await setup();
    await occurrence(1, "week 1\n");
    await legacyShared([2, 3, 4], "shared legacy\n");
    for (let n = 5; n <= 8; n += 1) await occurrence(n, `week ${n}\n`);
    unsaved(10);
    await app.rebuildIndex();

    const pages = await loadAll(app, ((await preview(app, 10)) as Paged).seriesView!);

    expect(pages).toEqual([["week 8", "week 7", "week 6", "week 5"], ["shared legacy", "week 1"]]);
  });

  it("does not write when paging", async () => {
    const { app, root, occurrence, unsaved } = await setup();
    for (let n = 1; n <= 6; n += 1) await occurrence(n, `week ${n}\n`);
    unsaved(8);
    await app.rebuildIndex();
    const first = ((await preview(app, 8)) as Paged).seriesView!;
    const before = await snapshot(root);

    await app.seriesViewPage(first.nextCursor!);

    expect(await snapshot(root)).toEqual(before);
  });

  it("rejects a malformed cursor", async () => {
    const { app } = await setup();
    await expect(app.seriesViewPage("not-a-cursor")).rejects.toThrow(/cursor/i);
  });

  it("flags newer occurrences with a Note and points at the latest, only when they exist", async () => {
    const { app, occurrence } = await setup();
    await occurrence(1, "week 1\n");
    await occurrence(2, "week 2\n");
    await occurrence(3, "week 3\n");
    const latest = await occurrence(4, "week 4\n");
    await occurrence(5); // newer but without a Note: ignored
    await app.rebuildIndex();

    const old = ((await preview(app, 2)) as Paged).seriesView!;
    expect(old.newer).toEqual({ meetingId: latest.meetingId, startsAt: day(4), endsAt: day(4).replace("T08", "T09"), timezone: "Europe/Paris" });
    expect(((await preview(app, 4)) as Paged).seriesView!.newer).toBeUndefined();
    expect(((await preview(app, 5)) as Paged).seriesView!.newer).toBeUndefined();
  });

  it("continues into the previous series, after the current one, when the provider links them", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "old 1\n", { series: "old-series" });
    await occurrence(2, "old 2\n", { series: "old-series" });
    await occurrence(3, "lookalike, unlinked\n", { series: "unrelated-series" });
    await occurrence(6, "new 6\n", { series: "new-series", previousSeries: "old-series" });
    unsaved(8, { seriesId: "new-series", previousSeriesId: "old-series" });
    await app.rebuildIndex();

    const first = ((await preview(app, 8)) as Paged).seriesView!;

    expect(await loadAll(app, first)).toEqual([["new 6", "old 2", "old 1"]]);
  });

  it("follows the previous-series link of a stored occurrence and across pages", async () => {
    const { app, occurrence } = await setup();
    for (let n = 1; n <= 5; n += 1) await occurrence(n, `old ${n}\n`, { series: "old-series" });
    for (let n = 6; n <= 8; n += 1) await occurrence(n, `new ${n}\n`, { series: "new-series", previousSeries: "old-series" });
    await app.rebuildIndex();

    const first = ((await preview(app, 8)) as Paged).seriesView!;

    expect(await loadAll(app, first)).toEqual([["new 7", "new 6", "old 5", "old 4"], ["old 3", "old 2", "old 1"]]);
  });

  it("never joins series by title when no provider link exists", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "old 1\n", { series: "old-series" });
    unsaved(8, { seriesId: "new-series" });
    await app.rebuildIndex();

    expect(bodies(await preview(app, 8))).toEqual([]);
  });

  it("shows a cancelled occurrence marked cancelled when it has a Note, and hides it when it has none", async () => {
    const { app, occurrence, unsaved } = await setup();
    await occurrence(1, "kept week\n");
    await occurrence(2, "cancelled but noted\n", { cancelled: true });
    await occurrence(3, undefined, { cancelled: true });
    unsaved(5);
    await app.rebuildIndex();

    const { earlier } = ((await preview(app, 5)) as Paged).seriesView!;

    expect(earlier.map((entry) => [entry.note.body.trim(), entry.cancelled])).toEqual([["cancelled but noted", true], ["kept week", false]]);
  });
});

describe("Series view review fixes (#180)", () => {
  it("points `newer` at a successor series after a split, and at the latest of all", async () => {
    const { app, occurrence } = await setup();
    await occurrence(1, "old 1\n", { series: "old-series" });
    await occurrence(2, "old 2\n", { series: "old-series" });
    await occurrence(6, "new 6\n", { series: "new-series", previousSeries: "old-series" });
    const latest = await occurrence(7, "new 7\n", { series: "new-series", previousSeries: "old-series" });
    await occurrence(9, undefined, { series: "new-series", previousSeries: "old-series" }); // no Note: ignored
    await app.rebuildIndex();

    expect(((await preview(app, 1)) as Paged).seriesView!.newer?.meetingId).toBe(latest.meetingId);
    expect(((await preview(app, 7)) as Paged).seriesView!.newer).toBeUndefined();
  });

  it("does not treat an unlinked series as a successor", async () => {
    const { app, occurrence } = await setup();
    await occurrence(1, "old 1\n", { series: "old-series" });
    await occurrence(6, "lookalike\n", { series: "other-series" });
    await app.rebuildIndex();

    expect(((await preview(app, 1)) as Paged).seriesView!.newer).toBeUndefined();
  });

  it("refuses a crafted cursor: invented, tampered or pointing at another series", async () => {
    const { app, occurrence, unsaved } = await setup();
    for (let n = 1; n <= 6; n += 1) await occurrence(n, `week ${n}\n`);
    for (let n = 11; n <= 12; n += 1) await occurrence(n, `foreign ${n}\n`, { series: "foreign-series" });
    unsaved(8);
    await app.rebuildIndex();
    const genuine = ((await preview(app, 8)) as Paged).seriesView!.nextCursor!;
    const [payload, ...rest] = genuine.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    const forge = (changes: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...decoded, ...changes })).toString("base64url");

    await expect(app.seriesViewPage(`${forge({ seriesId: "synthetic:work:foreign-series" })}.${rest.join(".")}`)).rejects.toThrow(/cursor/i);
    await expect(app.seriesViewPage(forge({ seriesId: "synthetic:work:foreign-series" }))).rejects.toThrow(/cursor/i);
    await expect(app.seriesViewPage(`${forge({ seriesId: "synthetic:work:foreign-series" })}.AAAA`)).rejects.toThrow(/cursor/i);
    expect((await app.seriesViewPage(genuine) as Page).earlier.length).toBeGreaterThan(0);
  });

  it("stores the provider's previous series on a Meeting created from an event", async () => {
    const { app, unsaved } = await setup();
    unsaved(8, { seriesId: "new-series", previousSeriesId: "old-series" });
    await app.rebuildIndex();

    const created = await app.createMeetingFromEvent("event-8", undefined, undefined, "work", "first words");

    expect(created.meeting.frontmatter.previous_recurrence_series_id).toBe("synthetic:work:old-series");
  });

  it("adds the previous series to an existing Meeting on sync, and a second sync changes nothing", async () => {
    const { app, root, occurrence } = await setup();
    const stored = await occurrence(6, "new 6\n", { series: "new-series" });
    stored.event.previousSeriesId = "old-series";
    await app.rebuildIndex();
    const file = path.join(root, `meetings/${stored.meetingId}.md`);
    expect(await readFile(file, "utf8")).not.toContain("previous_recurrence_series_id");

    await app.syncCalendar(new Date(day(1)), new Date(day(30)));
    const afterFirst = await snapshot(root);
    expect(await readFile(file, "utf8")).toContain("previous_recurrence_series_id: synthetic:work:old-series");

    await app.syncCalendar(new Date(day(1)), new Date(day(30)));
    expect(await snapshot(root)).toEqual(afterFirst);
  });

  it("shows each earlier occurrence's own Sources and accepted summary, never another's, and nothing when restricted (#176)", async () => {
    const { root, app, occurrence, unsaved } = await setup();
    const store = new MarkdownObjectStore(root);
    const first = await occurrence(1, "week 1\n");
    const second = await occurrence(2, "week 2\n");
    const third = await occurrence(3, "week 3 (restricted)\n", { restricted: true });
    unsaved(5);
    await app.rebuildIndex();
    const stamp = (id: string, title: string) => ({ id, type: "source" as const, schema_version: 1, revision: 1, title, created_at: "2026-09-01T08:00:00.000Z", updated_at: "2026-09-01T08:00:00.000Z", updated_by_device: "series-view-test", origin: "app" as const });
    const addMaterials = async (meetingId: string, summary: string, sourceTitle: string) => {
      const sourceId = uuidV7();
      await store.write({ relativePath: `sources/${sourceId}.md`, frontmatter: { ...stamp(sourceId, sourceTitle), source_type: "meet-transcript", captured_at: "2026-09-01T08:00:00.000Z", ingestion_status: "processed", meeting_id: meetingId, url: `https://example.com/${sourceId}`, retrieved_at: "2026-09-01T08:00:00.000Z" } as ObjectEnvelope, body: "" });
      const meeting = await store.read(`meetings/${meetingId}.md`);
      await store.write({ relativePath: meeting.relativePath, expectedHash: meeting.contentHash, frontmatter: { ...meeting.frontmatter, revision: meeting.frontmatter.revision + 1 }, body: `${meeting.body}\n<!-- lifeos:summary:start -->\n\n## Summary\n\n${summary}\n\n<!-- lifeos:summary:end -->\n` });
    };
    await addMaterials(first.meetingId, "Week one summary.", "Week one transcript");
    await addMaterials(third.meetingId, "Secret summary.", "Secret transcript");
    await app.rebuildIndex();

    const workspace = await preview(app, 5) as View & { seriesView: NonNullable<View["seriesView"]> };
    const byBody = (text: string) => workspace.seriesView.earlier.find((entry) => entry.note.body.includes(text))!;

    expect(byBody("week 1").materials).toMatchObject({ summary: "Week one summary.", sources: [{ title: "Week one transcript" }] });
    expect(byBody("week 2").materials).toBeUndefined();
    expect(byBody("restricted").materials).toBeUndefined();
    expect(second.meetingId).not.toBe(first.meetingId);
  });
});
