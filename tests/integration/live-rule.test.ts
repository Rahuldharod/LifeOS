import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #118: one Live rule (neither deleted nor archived) for lists, rollups and name matching, and one
// live-note-for-a-meeting lookup. An explicit ID still reaches an archived object, so old links keep working.
// Synthetic records on temp roots only.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const now = new Date("2026-10-05T07:00:00.000Z");
const from = new Date("2026-10-04T22:00:00.000Z");
const to = new Date("2026-10-05T22:00:00.000Z");
const at = (time: string) => `2026-10-05T${time}:00.000Z`;
const today = { date: "2026-10-05", now, timeZone: "Europe/Paris" };

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  failure?: Error;
  constructor(public events: CalendarEvent[] = []) {}
  async listEvents(start: Date, end: Date) {
    if (this.failure) throw this.failure;
    return this.events.filter((event) => Date.parse(event.startsAt) < end.getTime() && Date.parse(event.endsAt) > start.getTime());
  }
}

const event = (externalId: string, title: string, startsAt: string, endsAt: string): CalendarEvent =>
  ({ externalId, title, startsAt, endsAt, timezone: "Europe/Paris", isAllDay: false, attendees: [] }) as CalendarEvent;

async function vault(events: CalendarEvent[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-live-rule-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const calendar = new FakeCalendar(events);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, calendar, application };
}

async function seed(store: MarkdownObjectStore, type: string, title: string, extra: Record<string, unknown> = {}) {
  const id = uuidV7();
  const base = { id, type, schema_version: 1, revision: 1, title, created_at: at("06:00"), updated_at: at("06:00"), updated_by_device: "test" };
  const typeFields: Record<string, Record<string, unknown>> = {
    person: { given_name: title.split(" ")[0] }, project: { status: "Active" },
    meeting: { status: "confirmed", timezone: "Europe/Paris", attendee_ids: [] }
  };
  return store.write({ relativePath: `${type}/${id}.md`, frontmatter: { ...base, ...typeFields[type], ...extra } as LifeOSObject["frontmatter"], body: `# ${title}\n` });
}

const meeting = (store: MarkdownObjectStore, title: string, startsAt: string, endsAt: string, externalId?: string) =>
  seed(store, "meeting", title, { starts_at: startsAt, ends_at: endsAt, ...(externalId ? { external_refs: [{ provider: "fake", external_id: externalId }] } : {}) });
const note = (store: MarkdownObjectStore, meetingId: string, extra: Record<string, unknown> = {}) => seed(store, "meeting-note", "Notes", { meeting_id: meetingId, ...extra });

async function archive(application: LifeOSApplication, id: string) {
  const current = await application.object(id);
  await application.archiveObject(id, current.contentHash);
}

async function dropTaskDraft(root: string, name: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  const yaml = Object.entries({ lifeos_draft: 1, kind: "task", draft_key: name, origin: "user-dictated", title: "Send the deck", captured_at: "2026-10-05T09:15:00+02:00", ...fields })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(target, `---\n${yaml}\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

describe("the Live rule (#118)", () => {
  it("an archived duplicate meeting is not shown in Calendar (live and offline) or Today", async () => {
    const { store, calendar, application } = await vault([event("evt-1", "Weekly", at("09:00"), at("10:00"))]);
    const kept = await meeting(store, "Weekly", at("09:00"), at("10:00"), "evt-1");
    const duplicate = await meeting(store, "Weekly", at("09:00"), at("10:00"), "evt-1");
    await application.rebuildIndex();
    await archive(application, duplicate.frontmatter.id);

    expect((await application.listCalendarEvents(from, to)).map((entry) => entry.meetingId)).toEqual([kept.frontmatter.id]);
    expect((await application.todayPanels(today)).nextMeetings.map((entry) => entry.meetingId)).toEqual([kept.frontmatter.id]);
    calendar.failure = new Error("offline");
    expect((await application.calendarDay(from, to)).events.map((entry) => entry.meetingId)).toEqual([kept.frontmatter.id]);
    expect((await application.todayPanels(today)).nextMeetings.map((entry) => entry.meetingId)).toEqual([kept.frontmatter.id]);
  });

  it("a deleted or archived meeting note is hidden the same way in Calendar and Today", async () => {
    const { store, calendar, application } = await vault([event("evt-a", "Archived note", at("09:00"), at("10:00")), event("evt-d", "Deleted note", at("11:00"), at("12:00"))]);
    const withArchived = await meeting(store, "Archived note", at("09:00"), at("10:00"), "evt-a");
    const withDeleted = await meeting(store, "Deleted note", at("11:00"), at("12:00"), "evt-d");
    await note(store, withArchived.frontmatter.id, { archived_at: at("06:30") });
    await note(store, withDeleted.frontmatter.id, { deleted_at: at("06:30") });
    await application.rebuildIndex();

    const noNotes = (entries: Array<{ meetingId?: string; noteId?: string; hasNote?: boolean }>) => entries.map((entry) => [entry.meetingId, entry.noteId, entry.hasNote ?? false]);
    const expected = [[withArchived.frontmatter.id, undefined, false], [withDeleted.frontmatter.id, undefined, false]];
    expect(noNotes(await application.listCalendarEvents(from, to))).toEqual(expected);
    expect(noNotes((await application.todayPanels(today)).nextMeetings)).toEqual(expected);
    calendar.failure = new Error("offline");
    expect(noNotes((await application.calendarDay(from, to)).events)).toEqual(expected);
    expect(noNotes((await application.todayPanels(today)).nextMeetings)).toEqual(expected);
  });

  it("an archived Person or Project leaves lists and name matching but still resolves by ID", async () => {
    const { root, store, application } = await vault();
    const person = await seed(store, "person", "Alex Archived");
    const project = await seed(store, "project", "Old Relaunch");
    await application.rebuildIndex();
    await archive(application, person.frontmatter.id);
    await archive(application, project.frontmatter.id);

    expect(application.entities("person").map((entry) => entry.frontmatter.id)).not.toContain(person.frontmatter.id);
    expect(application.rollups("person").map((entry) => entry.entity.frontmatter.id)).not.toContain(person.frontmatter.id);
    expect(application.projects().map((entry) => entry.project.frontmatter.id)).not.toContain(project.frontmatter.id);
    expect((await application.object(person.frontmatter.id)).frontmatter.title).toBe("Alex Archived");

    await dropTaskDraft(root, "by-name.md", { owner: "Alex Archived", project: "Old Relaunch" });
    await dropTaskDraft(root, "by-id.md", { owner: person.frontmatter.id, project: project.frontmatter.id });
    await application.adoptDrafts();
    const tasks = (await application.listObjects()).filter((object) => object.frontmatter.type === "task");
    const byName = tasks.find((task) => task.frontmatter.owner_person_id !== person.frontmatter.id)!;
    const byId = tasks.find((task) => task.frontmatter.owner_person_id === person.frontmatter.id)!;
    expect(byName.frontmatter.primary_project_id).toBeUndefined();
    expect(byId.frontmatter.primary_project_id).toBe(project.frontmatter.id);
  });
});

async function dropDraft(root: string, name: string, fields: Record<string, unknown>, body = "") {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  const yaml = Object.entries({ lifeos_draft: 1, draft_key: name, origin: "user-dictated", captured_at: "2026-10-05T09:15:00+02:00", ...fields })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(target, `---\n${yaml}\n---\n${body}`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

// Decision 2026-10-10: an identifier (email, URL, merge by ID) works like an explicit ID, so it reaches an
// archived object (deleted ones stay out) and never creates a duplicate. The archived object stays archived.
describe("identifiers reach archived objects (#118)", () => {
  const ofType = async (application: LifeOSApplication, type: string) => (await application.listObjects()).filter((object) => object.frontmatter.type === type);

  it("a person draft whose email belongs to an archived person adopts as that person", async () => {
    const { root, store, application } = await vault();
    const person = await seed(store, "person", "Alex Archived", { identifiers: [{ kind: "email", value: "alex@example.com" }] });
    await application.rebuildIndex();
    await archive(application, person.frontmatter.id);

    await dropDraft(root, "alex.md", { kind: "person", title: "Alexander Archived", email: "ALEX@example.com" });
    const [result] = (await application.adoptDrafts()).drafts;
    expect(result).toMatchObject({ outcome: "adopted", objectIds: [person.frontmatter.id] });
    expect(await ofType(application, "person")).toHaveLength(1);
    expect((await application.object(person.frontmatter.id)).frontmatter.archived_at).toEqual(expect.any(String));
  });

  it("a calendar attendee or a draft reference by email reaches an archived person; a live one with the same email wins", async () => {
    const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    const attendeeEvent = { ...event("e2", "Catch-up", soon(60), soon(90)), attendeeDetails: [{ email: "sam@example.com", displayName: "Sam Archived" }] } as CalendarEvent;
    const { root, store, application } = await vault([attendeeEvent]);
    const person = await seed(store, "person", "Sam Archived", { identifiers: [{ kind: "email", value: "sam@example.com" }] });
    await application.rebuildIndex();
    await archive(application, person.frontmatter.id);

    const workspace = await application.createMeetingFromEvent("e2");
    expect(workspace.meeting.frontmatter.attendee_ids).toContain(person.frontmatter.id);
    expect((await ofType(application, "person")).filter((object) => object.frontmatter.is_self !== true).map((object) => object.frontmatter.title)).toEqual(["Sam Archived"]);

    await dropDraft(root, "task.md", { kind: "task", title: "Send the deck", owner: "sam@example.com" });
    await application.adoptDrafts();
    const task = (await ofType(application, "task"))[0]!;
    expect(task.frontmatter.owner_person_id).toBe(person.frontmatter.id);

    const live = await seed(store, "person", "Sam Live", { identifiers: [{ kind: "email", value: "sam@example.com" }] });
    await application.rebuildIndex();
    await dropDraft(root, "task-2.md", { kind: "task", title: "Book the room", owner: "sam@example.com" });
    await application.adoptDrafts();
    const second = (await ofType(application, "task")).find((object) => object.frontmatter.title === "Book the room")!;
    expect(second.frontmatter.owner_person_id).toBe(live.frontmatter.id);
  });

  it("a source draft whose URL belongs to an archived source reuses it; a deleted one is not reused", async () => {
    const { root, store, application } = await vault();
    const archived = await seed(store, "source", "Loyalty article", { source_type: "web-link", url: "https://example.com/loyalty", captured_at: at("06:00"), ingestion_status: "captured" });
    await seed(store, "source", "Gone article", { source_type: "web-link", url: "https://example.com/gone", captured_at: at("06:00"), ingestion_status: "captured", deleted_at: at("06:10") });
    await application.rebuildIndex();
    await archive(application, archived.frontmatter.id);

    await dropDraft(root, "again.md", { kind: "source", title: "Loyalty article again", url: "https://example.com/loyalty" });
    await dropDraft(root, "gone.md", { kind: "source", title: "Gone article again", url: "https://example.com/gone" });
    const { drafts } = await application.adoptDrafts();
    expect(drafts.map((draft) => draft.objectIds)).toContainEqual([archived.frontmatter.id]);
    const live = (await ofType(application, "source")).filter((source) => !source.frontmatter.deleted_at);
    expect(live.map((source) => source.frontmatter.url).sort()).toEqual(["https://example.com/gone", "https://example.com/loyalty"]);
    expect((await application.object(archived.frontmatter.id)).frontmatter.archived_at).toEqual(expect.any(String));
  });

  it("a person merge goes ahead when one side is archived", async () => {
    const meetingEvent = { ...event("e1", "Pilot", new Date(Date.now() + 3_600_000).toISOString(), new Date(Date.now() + 5_400_000).toISOString()), attendeeDetails: [{ email: "marie.curie@example.com", displayName: "Marie Curie" }] } as CalendarEvent;
    const { application } = await vault([meetingEvent]);
    const keep = await application.createEntity("person", { title: "Marie Curie" });
    await application.createMeetingFromEvent("e1");
    const dup = (await ofType(application, "person")).find((person) => person.frontmatter.origin === "calendar")!;
    const [reviewId] = await application.suggestPersonMerges();
    expect(reviewId).toBeDefined();
    const proposed = application.object(reviewId!).frontmatter.proposed_fields as Record<string, string>;
    await archive(application, proposed.merge_person_id === dup.frontmatter.id ? dup.frontmatter.id : keep.frontmatter.id);

    await application.acceptReviewItem(reviewId!);
    expect(application.object(proposed.merge_person_id!).frontmatter).toMatchObject({ merged_into_person_id: proposed.keep_person_id, deleted_at: expect.any(String) });
  });
});
