import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";

// #40: person drafts arrive unreviewed; likely duplicates become person-merge Review Items; accepting merges recoverably.

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
  root ??= await mkdtemp(path.join(tmpdir(), "lifeos-person-merge-"));
  if (!roots.includes(root)) roots.push(root);
  const store = new CrashingStore(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, calendar, application };
}

async function dropDraft(root: string, name: string, fields: Record<string, unknown>, body = "") {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ lifeos_draft: 1, kind: "person", origin: "user-dictated", captured_at: "2026-10-04T09:15:00+02:00", ...fields })}---\n${body}`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

const ofType = async (application: LifeOSApplication, type: string) => (await application.listObjects()).filter((object) => object.frontmatter.type === type);
const people = async (application: LifeOSApplication) => (await ofType(application, "person")).filter((person) => person.frontmatter.is_self !== true);
const merges = async (application: LifeOSApplication) => application.reviews().filter((review) => review.frontmatter.review_type === "person-merge");
const proposal = (review: LifeOSObject) => review.frontmatter.proposed_fields as Record<string, string>;
const operationFiles = async (root: string) => Promise.all((await readdir(path.join(root, ".lifeos", "operations")).catch(() => [] as string[])).map(async (name) => JSON.parse(await readFile(path.join(root, ".lifeos", "operations", name), "utf8")) as { kind: string; status: string }));

describe("person drafts (#40)", () => {
  it("creates an unreviewed Person from a dictated or agent-extracted draft", async () => {
    const { root, application } = await setup();
    await dropDraft(root, "lea.md", { draft_key: "p1", title: "Léa Martin-Dubois", email: "Lea.Martin@Acme-Corp.fr", job_title: "Buyer", tags: ["retail"] }, "Met at the Paris trade show.\n");
    await dropDraft(root, "kim.md", { draft_key: "p2", origin: "agent-extracted", title: "Kim", given_name: "Kim", family_name: "Lee", emails: ["kim.lee@eagleeye.com", "kim@gmail.com"] });

    const batch = await application.adoptDrafts();
    expect(batch.drafts.map((draft) => draft.outcome)).toEqual(["adopted", "adopted"]);
    const kim = (await people(application)).find((person) => person.frontmatter.given_name === "Kim")!;
    const lea = (await people(application)).find((person) => person.frontmatter.given_name === "Léa")!;
    expect(lea.frontmatter).toMatchObject({ title: "Léa Martin-Dubois", family_name: "Martin-Dubois", origin: "user-dictated", review_state: "unreviewed", is_external: true, organization_name: "Acme-Corp", job_title: "Buyer", tags: ["retail"], identifiers: [{ kind: "email", value: "lea.martin@acme-corp.fr" }] });
    expect(lea.relativePath).toMatch(/^people\/.*lea-martin-dubois--/);
    expect(application.object(lea.frontmatter.id).body).toContain("Met at the Paris trade show.");
    expect(kim.frontmatter).toMatchObject({ title: "Kim", family_name: "Lee", origin: "agent-extracted", review_state: "unreviewed", is_external: false, identifiers: [{ kind: "email", value: "kim.lee@eagleeye.com" }, { kind: "email", value: "kim@gmail.com" }] });
    expect(await merges(application)).toHaveLength(0);
  });

  it("fails a draft with a bad email, path-aware, and adopts a known email as the existing person", async () => {
    const { root, application } = await setup();
    await dropDraft(root, "bad.md", { draft_key: "bad", title: "Bad Mail", email: "not-an-email", is_external: "yes" });
    const failed = (await application.adoptDrafts()).drafts[0]!;
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toContain('email: not an email address ("not-an-email")');
    expect(failed.reason).toContain("is_external: must be true or false");

    await dropDraft(root, "first.md", { draft_key: "a", title: "Alex Morgan", email: "alex.morgan@acme.com" });
    const [first] = (await application.adoptDrafts()).drafts;
    await dropDraft(root, "again.md", { draft_key: "b", title: "Alexander Morgan", email: "ALEX.MORGAN@acme.com" });
    const [again] = (await application.adoptDrafts()).drafts;
    expect(again).toMatchObject({ outcome: "adopted", objectIds: [first!.objectIds[0]] });
    expect(await people(application)).toHaveLength(1);
  });
});

describe("person-merge suggestions (#40)", () => {
  it("suggests merging a drafted person whose name matches an older person, without merging", async () => {
    const { root, application } = await setup();
    const older = await application.createEntity("person", { title: "Joel Smith" });
    await dropDraft(root, "joel.md", { draft_key: "j", title: "joël  SMITH" });

    const [result] = (await application.adoptDrafts()).drafts;
    const drafted = (await people(application)).find((person) => person.frontmatter.id !== older.frontmatter.id)!;
    const [review] = await merges(application);
    expect(review!.frontmatter).toMatchObject({ status: "pending", target_object_type: "person", confidence_label: "Medium" });
    expect(proposal(review!)).toMatchObject({ keep_person_id: older.frontmatter.id, merge_person_id: drafted.frontmatter.id, match: "name" });
    // The review item is reported with the draft (one audit per object or review item created).
    expect(result!.objectIds).toEqual([drafted.frontmatter.id, review!.frontmatter.id]);
    // Never merged automatically: both people are still live.
    expect((await people(application)).filter((person) => !person.frontmatter.deleted_at)).toHaveLength(2);
  });

  it("suggests a merge when the email local part matches across internal domains, but not across other domains", async () => {
    const { root, calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "joel.smith@eagleeye.com" }, { email: "sam.lee@acme.com" }])];
    await application.createMeetingFromEvent("e1");
    await dropDraft(root, "j.md", { draft_key: "j", title: "J. Smith", email: "Joel.Smith@untienots.com" });
    await dropDraft(root, "s.md", { draft_key: "s", title: "S. Lee", email: "sam.lee@other.com" });
    await application.adoptDrafts();

    const reviews = await merges(application);
    expect(reviews).toHaveLength(1);
    expect(proposal(reviews[0]!)).toMatchObject({ match: "email-local-part", keep_title: "Joel Smith", merge_title: "J. Smith" });
    expect(reviews[0]!.frontmatter.confidence_label).toBe("High");
  });

  it("covers calendar-created people against older people, once per pair, and never re-proposes a rejected pair", async () => {
    const { calendar, application } = await setup();
    const older = await application.createEntity("person", { title: "Marie Curie" });
    calendar.events = [event("e1", [{ email: "marie.curie@eagleeye.com" }])];
    await application.createMeetingFromEvent("e1");

    const created = await application.suggestPersonMerges();
    expect(created).toHaveLength(1);
    expect(proposal((await merges(application))[0]!)).toMatchObject({ keep_person_id: older.frontmatter.id, match: "name" });
    expect(await application.suggestPersonMerges()).toEqual([]);
    // Concurrent sweeps agree on one suggestion.
    await application.rejectReviewItem(created[0]!);
    expect(await Promise.all([application.suggestPersonMerges(), application.suggestPersonMerges()])).toEqual([[], []]);
    expect(await merges(application)).toHaveLength(1);

    // Two people the user made themselves (neither unreviewed) are left alone.
    await application.createEntity("person", { title: "Ada Lovelace" });
    await application.createEntity("person", { title: "Ada Lovelace" });
    expect(await application.suggestPersonMerges()).toEqual([]);
  });
});

describe("accepting a person merge (#40)", () => {
  /** An older person and a calendar duplicate, referenced from a meeting, its note (fields and a body link), a task and a client. */
  async function duplicateScenario() {
    const context = await setup();
    const { calendar, application } = context;
    const keep = await application.createEntity("person", { title: "Marie Curie" });
    calendar.events = [event("e1", [{ displayName: "Marie Curie" }, { email: "marie.curie@eagleeye.com", displayName: "Marie Curie" }])];
    const workspace = await application.createMeetingFromEvent("e1");
    const dup = (await people(application)).find((person) => person.frontmatter.origin === "calendar")!;
    expect(workspace.meeting.frontmatter.attendee_ids).toEqual([keep.frontmatter.id, dup.frontmatter.id]);
    await application.updateBody(workspace.note!.frontmatter.id, `Ask [Marie](lifeos://object/${dup.frontmatter.id}) about the pilot.\n`, workspace.note!.contentHash);
    const task = await application.createEntity("task", { title: "Send Marie the deck", owner_person_id: dup.frontmatter.id });
    const client = await application.createEntity("client", { title: "Radium Labs", primary_contact_person_id: dup.frontmatter.id });
    const [review] = await application.suggestPersonMerges();
    return { ...context, keep, dup, meetingId: workspace.meeting.frontmatter.id, noteId: workspace.note!.frontmatter.id, taskId: task.frontmatter.id, clientId: client.frontmatter.id, reviewId: review! };
  }

  function expectMerged(application: LifeOSApplication, s: Awaited<ReturnType<typeof duplicateScenario>>) {
    const { keep, dup } = s;
    expect(application.object(s.meetingId).frontmatter.attendee_ids).toEqual([keep.frontmatter.id]);
    expect(application.object(s.noteId).frontmatter.people_ids).toEqual([keep.frontmatter.id]);
    expect(application.object(s.noteId).body).toContain(`lifeos://object/${keep.frontmatter.id}`);
    expect(application.object(s.taskId).frontmatter.owner_person_id).toBe(keep.frontmatter.id);
    expect(application.object(s.clientId).frontmatter.primary_contact_person_id).toBe(keep.frontmatter.id);
    expect(application.object(dup.frontmatter.id).frontmatter).toMatchObject({ merged_into_person_id: keep.frontmatter.id, deleted_at: expect.any(String) });
    expect(application.object(keep.frontmatter.id).frontmatter).toMatchObject({ identifiers: [{ kind: "email", value: "marie.curie@eagleeye.com" }], family_name: "Curie" });
    expect(application.object(s.reviewId).frontmatter).toMatchObject({ status: "accepted", resolved_object_id: keep.frontmatter.id });
    expect(application.entities("person").map((person) => person.frontmatter.id)).not.toContain(dup.frontmatter.id);
  }

  it("re-points every reference, tombstones the merged person and completes the operation", async () => {
    const s = await duplicateScenario();
    const { application, root, keep, dup } = s;
    const kept = await application.acceptReviewItem(s.reviewId);
    expect(kept.frontmatter.id).toBe(keep.frontmatter.id);
    expectMerged(application, s);
    expect((await operationFiles(root)).filter((operation) => operation.kind === "merge-person")).toEqual([expect.objectContaining({ status: "completed" })]);
    const audit = (await ofType(application, "audit-event")).find((event) => event.frontmatter.action === "person.merged");
    expect(audit!.frontmatter).toMatchObject({ object_id: keep.frontmatter.id, metadata: { merged_person_id: dup.frontmatter.id } });
    // History is not rewritten, and nothing points at a missing object.
    expect((await application.health()).diagnostics).toEqual([]);
    // Retrying the accept is a no-op; a stale suggestion involving the merged person is refused.
    expect((await application.acceptReviewItem(s.reviewId)).frontmatter.id).toBe(keep.frontmatter.id);
    expect(application.object(dup.frontmatter.id).frontmatter.revision).toBe(2);
  });

  it("completes an interrupted merge on startup recovery", async () => {
    const s = await duplicateScenario();
    s.store.crashOnTombstone = true;
    await expect(s.application.acceptReviewItem(s.reviewId)).rejects.toThrow("disk unplugged");
    // Crashed half-way: on disk the task already points at the kept person, the duplicate is not yet tombstoned.
    await s.application.rebuildIndex();
    expect(s.application.object(s.taskId).frontmatter.owner_person_id).toBe(s.keep.frontmatter.id);
    expect(s.application.object(s.dup.frontmatter.id).frontmatter.deleted_at).toBeUndefined();

    const restarted = await setup(s.root);
    expect(await restarted.application.recoverOperations()).toHaveLength(1);
    expectMerged(restarted.application, s);
    expect(await restarted.application.recoverOperations()).toHaveLength(0);
  });

  it("rolls an interrupted merge back when a file it touches changed before recovery", async () => {
    const s = await duplicateScenario();
    s.store.crashOnTombstone = true;
    await expect(s.application.acceptReviewItem(s.reviewId)).rejects.toThrow("disk unplugged");
    const restarted = await setup(s.root);
    // Meanwhile the user hands the task to someone else.
    const other = await restarted.application.createEntity("person", { title: "Pierre Curie" });
    const task = restarted.application.object(s.taskId);
    await restarted.application.updateTask(s.taskId, { owner_person_id: other.frontmatter.id }, task.contentHash);

    expect(await restarted.application.recoverOperations()).toHaveLength(1);
    const app = restarted.application;
    expect(app.object(s.meetingId).frontmatter.attendee_ids).toEqual([s.keep.frontmatter.id, s.dup.frontmatter.id]);
    expect(app.object(s.noteId).body).toContain(`lifeos://object/${s.dup.frontmatter.id}`);
    expect(app.object(s.clientId).frontmatter.primary_contact_person_id).toBe(s.dup.frontmatter.id);
    expect(app.object(s.keep.frontmatter.id).frontmatter.identifiers).toBeUndefined();
    expect(app.object(s.dup.frontmatter.id).frontmatter.deleted_at).toBeUndefined();
    expect(app.object(s.taskId).frontmatter.owner_person_id).toBe(other.frontmatter.id);
    const review = app.object(s.reviewId);
    expect(review.frontmatter.status).toBe("pending");
    expect(String(review.frontmatter.merge_problem)).toMatch(/^tasks\/.*changed while the merge was in progress/);
    expect(await app.recoverOperations()).toHaveLength(0);

    // The user can accept again: a fresh plan with the task as it now is.
    s.store.crashOnTombstone = false;
    await app.acceptReviewItem(s.reviewId);
    expect(app.object(s.meetingId).frontmatter.attendee_ids).toEqual([s.keep.frontmatter.id]);
    expect(app.object(s.taskId).frontmatter.owner_person_id).toBe(other.frontmatter.id);
    expect(app.object(s.dup.frontmatter.id).frontmatter.deleted_at).toEqual(expect.any(String));
  });

  it("refuses a suggestion whose person was already merged, and rejecting changes nothing", async () => {
    const { calendar, application } = await setup();
    const keep = await application.createEntity("person", { title: "Ada Byron" });
    calendar.events = [event("e1", [{ email: "ada.byron@eagleeye.com" }, { email: "ada.byron@untienots.com" }])];
    await application.createMeetingFromEvent("e1");
    await application.suggestPersonMerges();
    const reviews = await merges(application);
    expect(reviews).toHaveLength(3);
    const first = reviews.find((review) => proposal(review).keep_person_id === keep.frontmatter.id)!;
    await application.acceptReviewItem(first.frontmatter.id);
    const stale = (await merges(application)).find((review) => review.frontmatter.status === "pending" && [proposal(review).keep_person_id, proposal(review).merge_person_id].includes(proposal(first).merge_person_id))!;
    await expect(application.acceptReviewItem(stale.frontmatter.id)).rejects.toThrow(/already merged; reject this suggestion/);
    const rejected = await application.rejectReviewItem(stale.frontmatter.id);
    expect(rejected.frontmatter.status).toBe("rejected");
  });
});

it("keeps persisted merge files parseable Markdown", async () => {
  const s = await (async () => {
    const { root, application } = await setup();
    await application.createEntity("person", { title: "Joel Smith" });
    await dropDraft(root, "j.md", { draft_key: "j", title: "Joel Smith" });
    await application.adoptDrafts();
    return { root, application };
  })();
  const [review] = await merges(s.application);
  const fm = parse((await readFile(path.join(s.root, review!.relativePath), "utf8")).split("---")[1]!) as Record<string, unknown>;
  expect(fm).toMatchObject({ review_type: "person-merge", status: "pending" });
});
