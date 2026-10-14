import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { LifeOSApplication, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import type { ObjectEnvelope } from "@lifeos/domain";

// #213: the user merges any two people from the People card; the crash-safe merge of ADR 0013 does the work.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

/** Fails the merge's last step (the tombstone) to simulate a crash part-way through. */
class CrashingStore extends MarkdownObjectStore {
  crashOnTombstone = false;
  override async write(input: { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string }) {
    if (this.crashOnTombstone && input.frontmatter.merged_into_person_id) throw new Error("disk unplugged");
    return super.write(input);
  }
}

function event(externalId: string, attendeeDetails: CalendarAttendee[]): CalendarEvent {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  return { externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: attendeeDetails.map((attendee) => attendee.displayName ?? attendee.email ?? ""), attendeeDetails };
}

async function setup(root?: string) {
  root ??= await mkdtemp(path.join(tmpdir(), "lifeos-person-merge-manual-"));
  if (!roots.includes(root)) roots.push(root);
  const store = new CrashingStore(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, calendar, application };
}

async function dropDraft(root: string, name: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ lifeos_draft: 1, kind: "person", origin: "agent-extracted", captured_at: "2026-10-04T09:15:00+02:00", ...fields })}---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

const mergeReviews = (application: LifeOSApplication) => application.reviews().filter((review) => review.frontmatter.review_type === "person-merge");

/** "John Doe" (made by the user, with a family name) and "Jdoe" (an email-only calendar attendee), both referenced. */
async function jdoeScenario() {
  const context = await setup();
  const { calendar, application } = context;
  const john = await application.createEntity("person", { title: "John Doe", given_name: "John", family_name: "Doe" });
  calendar.events = [event("e1", [{ email: "jdoe@example.com", displayName: "Jdoe" }])];
  const workspace = await application.createMeetingFromEvent("e1");
  const jdoe = application.entities("person").find((person) => person.frontmatter.title === "Jdoe")!;
  await application.updateBody(workspace.note!.frontmatter.id, `Ask [J](lifeos://object/${jdoe.frontmatter.id}) about it.\n`, workspace.note!.contentHash);
  const task = await application.createEntity("task", { title: "Send the deck", owner_person_id: jdoe.frontmatter.id });
  return { ...context, john, jdoe, meetingId: workspace.meeting.frontmatter.id, noteId: workspace.note!.frontmatter.id, taskId: task.frontmatter.id };
}
type Scenario = Awaited<ReturnType<typeof jdoeScenario>>;

function expectMergedInto(application: LifeOSApplication, s: Scenario, keptId: string, goneId: string) {
  expect(application.object(s.meetingId).frontmatter.attendee_ids).toEqual([keptId]);
  expect(application.object(s.noteId).frontmatter.people_ids).toEqual([keptId]);
  expect(application.object(s.noteId).body).toContain(`lifeos://object/${keptId}`);
  expect(application.object(s.taskId).frontmatter.owner_person_id).toBe(keptId);
  expect(application.object(goneId).frontmatter).toMatchObject({ merged_into_person_id: keptId, deleted_at: expect.any(String) });
}

describe("manual merge (#213)", () => {
  it("merges an email-only person into a named one: email moves, name becomes an alias, references follow, kept is reviewed", async () => {
    const s = await jdoeScenario();
    const kept = await s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id });
    expect(kept.frontmatter.id).toBe(s.john.frontmatter.id);
    expect(kept.frontmatter).toMatchObject({ title: "John Doe", identifiers: [{ kind: "email", value: "jdoe@example.com" }], aliases: ["Jdoe"], review_state: "reviewed" });
    expectMergedInto(s.application, s, s.john.frontmatter.id, s.jdoe.frontmatter.id);
    expect((await s.application.health()).diagnostics).toEqual([]);
    expect(s.application.entities("person").map((person) => person.frontmatter.id)).not.toContain(s.jdoe.frontmatter.id);
  });

  it("keeps the other name when asked, and the discarded name becomes an alias", async () => {
    const s = await jdoeScenario();
    const kept = await s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id, nameFromPersonId: s.jdoe.frontmatter.id });
    expect(kept.frontmatter).toMatchObject({ id: s.john.frontmatter.id, title: "Jdoe", aliases: ["John Doe"] });
    expect(kept.frontmatter.family_name).toBeUndefined();
  });

  it("lets the user keep the other person: the record survives and takes the name with a family name", async () => {
    const s = await jdoeScenario();
    const kept = await s.application.mergePeople({ personId: s.john.frontmatter.id, otherPersonId: s.jdoe.frontmatter.id, keepPersonId: s.jdoe.frontmatter.id });
    expect(kept.frontmatter).toMatchObject({ id: s.jdoe.frontmatter.id, title: "John Doe", given_name: "John", family_name: "Doe", aliases: ["Jdoe"], review_state: "reviewed" });
    expectMergedInto(s.application, s, s.jdoe.frontmatter.id, s.john.frontmatter.id);
  });

  it("previews the default survivor, the default name and what moves, without writing", async () => {
    const s = await jdoeScenario();
    const before = s.application.object(s.john.frontmatter.id).contentHash;
    const preview = await s.application.previewPersonMerge({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id });
    expect(preview).toMatchObject({ keepPersonId: s.john.frontmatter.id, nameFromPersonId: s.john.frontmatter.id, keepLocked: false, keptName: "John Doe", aliases: ["Jdoe"], emails: ["jdoe@example.com"], referenceCount: 3 });
    const swapped = await s.application.previewPersonMerge({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id, keepPersonId: s.jdoe.frontmatter.id, nameFromPersonId: s.jdoe.frontmatter.id });
    expect(swapped).toMatchObject({ keepPersonId: s.jdoe.frontmatter.id, keptName: "Jdoe", aliases: ["John Doe"] });
    expect(s.application.object(s.john.frontmatter.id).contentHash).toBe(before);
  });

  it("never lets the Self person be the merged-away side", async () => {
    const { calendar, application } = await setup();
    calendar.events = [event("e1", [{ self: true, displayName: "Rahul Example", email: "rahul@example.com" }])];
    await application.createMeetingFromEvent("e1");
    const self = application.entities("person").find((person) => person.frontmatter.is_self === true)!;
    const other = await application.createEntity("person", { title: "Rahul E." });
    await expect(application.mergePeople({ personId: self.frontmatter.id, otherPersonId: other.frontmatter.id, keepPersonId: other.frontmatter.id })).rejects.toThrow(/Self/);
    expect(application.object(self.frontmatter.id).frontmatter.deleted_at).toBeUndefined();
    expect((await application.previewPersonMerge({ personId: other.frontmatter.id, otherPersonId: self.frontmatter.id })).keepLocked).toBe(true);
    const kept = await application.mergePeople({ personId: other.frontmatter.id, otherPersonId: self.frontmatter.id });
    expect(kept.frontmatter.id).toBe(self.frontmatter.id);
    expect(kept.frontmatter.is_self).toBe(true);
    expect(application.object(other.frontmatter.id).frontmatter.merged_into_person_id).toBe(self.frontmatter.id);
  });

  it("refuses merging a person with itself, and a person that is already merged", async () => {
    const s = await jdoeScenario();
    await expect(s.application.mergePeople({ personId: s.john.frontmatter.id, otherPersonId: s.john.frontmatter.id })).rejects.toThrow(/itself/);
    await s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id });
    await expect(s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id })).rejects.toThrow(/no longer exists|already merged/);
  });

  it("reuses a pending suggestion for the same pair instead of leaving a stale one behind", async () => {
    const { root, application } = await setup();
    await dropDraft(root, "a.md", { draft_key: "a", title: "Ada Byron", email: "ada.byron@example.com" });
    await dropDraft(root, "b.md", { draft_key: "b", title: "Ada Byron", email: "ada@example.org" });
    await application.adoptDrafts();
    const [suggestion] = mergeReviews(application);
    expect(suggestion!.frontmatter.status).toBe("pending");
    const { keep_person_id: keepId, merge_person_id: mergeId } = suggestion!.frontmatter.proposed_fields as Record<string, string>;
    const kept = await application.mergePeople({ personId: keepId!, otherPersonId: mergeId! });
    expect(kept.frontmatter).toMatchObject({ id: keepId, review_state: "reviewed" });
    expect(mergeReviews(application).map((review) => review.frontmatter.status)).toEqual(["accepted"]);
  });

  it("accepting an Inbox merge suggestion also marks the kept person reviewed", async () => {
    const { root, application } = await setup();
    await dropDraft(root, "a.md", { draft_key: "a", title: "Ada Byron", email: "ada.byron@example.com" });
    await dropDraft(root, "b.md", { draft_key: "b", title: "Ada Byron", email: "ada@example.org" });
    await application.adoptDrafts();
    const [suggestion] = mergeReviews(application);
    const keepId = (suggestion!.frontmatter.proposed_fields as Record<string, string>).keep_person_id!;
    expect(application.object(keepId).frontmatter.review_state).toBe("unreviewed");
    await application.acceptReviewItem(suggestion!.frontmatter.id);
    expect(application.object(keepId).frontmatter.review_state).toBe("reviewed");
  });

  it("completes a manual merge interrupted mid-way on startup recovery", async () => {
    const s = await jdoeScenario();
    s.store.crashOnTombstone = true;
    await expect(s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id })).rejects.toThrow("disk unplugged");
    await s.application.rebuildIndex();
    expect(s.application.object(s.taskId).frontmatter.owner_person_id).toBe(s.john.frontmatter.id);
    expect(s.application.object(s.jdoe.frontmatter.id).frontmatter.deleted_at).toBeUndefined();

    const restarted = await setup(s.root);
    expect(await restarted.application.recoverOperations()).toHaveLength(1);
    expectMergedInto(restarted.application, s, s.john.frontmatter.id, s.jdoe.frontmatter.id);
    expect(restarted.application.object(s.john.frontmatter.id).frontmatter).toMatchObject({ aliases: ["Jdoe"], review_state: "reviewed" });
    expect(await restarted.application.recoverOperations()).toHaveLength(0);
    expect(mergeReviews(restarted.application).map((review) => review.frontmatter.status)).toEqual(["accepted"]);
  });

  it("rolls an interrupted manual merge back when a touched file changed, then lets the user merge again", async () => {
    const s = await jdoeScenario();
    s.store.crashOnTombstone = true;
    await expect(s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id })).rejects.toThrow("disk unplugged");
    const restarted = await setup(s.root);
    const other = await restarted.application.createEntity("person", { title: "Pierre Curie" });
    await restarted.application.updateTask(s.taskId, { owner_person_id: other.frontmatter.id }, restarted.application.object(s.taskId).contentHash);
    expect(await restarted.application.recoverOperations()).toHaveLength(1);
    const app = restarted.application;
    expect(app.object(s.meetingId).frontmatter.attendee_ids).toEqual([s.jdoe.frontmatter.id]);
    expect(app.object(s.jdoe.frontmatter.id).frontmatter.deleted_at).toBeUndefined();
    expect(app.object(s.john.frontmatter.id).frontmatter.identifiers).toBeUndefined();

    s.store.crashOnTombstone = false;
    await app.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id });
    expect(app.object(s.meetingId).frontmatter.attendee_ids).toEqual([s.john.frontmatter.id]);
    expect(app.object(s.taskId).frontmatter.owner_person_id).toBe(other.frontmatter.id);
    expect(mergeReviews(app).filter((review) => review.frontmatter.status === "pending")).toEqual([]);
  });

  it("retrying after a crash finishes the same merge without a second Review Item", async () => {
    const s = await jdoeScenario();
    s.store.crashOnTombstone = true;
    await expect(s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id })).rejects.toThrow("disk unplugged");
    s.store.crashOnTombstone = false;
    await s.application.mergePeople({ personId: s.jdoe.frontmatter.id, otherPersonId: s.john.frontmatter.id });
    expectMergedInto(s.application, s, s.john.frontmatter.id, s.jdoe.frontmatter.id);
    expect(mergeReviews(s.application)).toHaveLength(1);
  });
});
