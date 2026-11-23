import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { isReviewActionUndoable } from "@lifeos/shared";
import { FilesystemInboxStore } from "@lifeos/object-store-markdown";
import { CrashingStore } from "./crash-store.js";

// #242 (ADR 0025): undo for the Review actions that change more than one object: Merge, Keep separate, a link resolution and
// Apply change. Each puts back what the accept recorded, is refused (409, nothing written) when something it touched was edited
// since, and survives a crash at every step (ADR 0013).

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

async function open(root?: string, calendar: CalendarConnector = new FakeCalendar()) {
  root ??= await mkdtemp(path.join(tmpdir(), "lifeos-undo-decisions-"));
  if (!roots.includes(root)) roots.push(root);
  const store = new CrashingStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, calendar, application };
}
type Context = Awaited<ReturnType<typeof open>>;

const audits = async (application: LifeOSApplication, action: string) => (await application.rebuildIndex(), await application.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action);
/** What an object holds apart from its bookkeeping, so "as they were" is a plain equality. */
const snapshot = (application: LifeOSApplication, ids: string[]) => Object.fromEntries(ids.map((id) => {
  const object = application.object(id);
  const { revision: _revision, updated_at: _updatedAt, updated_by_device: _device, ...rest } = object.frontmatter;
  return [id, { ...rest, body: object.body }];
}));

/** Rewrites the front matter of the file at `relativePath` with `change`, to make a record look like one an older build wrote. */
async function rewrite(root: string, relativePath: string, change: (frontmatter: Record<string, unknown>) => void) {
  const target = path.join(root, relativePath);
  const [, yaml, body] = (await readFile(target, "utf8")).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)!;
  const frontmatter = parse(yaml!) as Record<string, unknown>;
  change(frontmatter);
  await writeFile(target, `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`);
}

/** Runs `scenario` once to count the changes `act` makes, then again crashing after each one; `verify` checks the restarted vault. */
async function everyCrashPoint<S>(scenario: () => Promise<S & { context: Context }>, act: (state: S) => Promise<unknown>, verify: (restarted: Context, state: S, at: string) => Promise<void>) {
  const clean = await scenario();
  clean.context.store.arm(Number.MAX_SAFE_INTEGER);
  await act(clean);
  const changes = clean.context.store.changes;
  expect(changes).toBeGreaterThanOrEqual(3);
  for (let crashAfter = 1; crashAfter < changes; crashAfter += 1) {
    const state = await scenario();
    state.context.store.arm(crashAfter);
    await expect(act(state), `crash after change ${crashAfter}`).rejects.toThrow(/simulated crash/);
    const restarted = await open(state.context.root, state.context.calendar);
    await restarted.application.recoverOperations();
    await restarted.application.rebuildIndex();
    await verify(restarted, state, `crash after change ${crashAfter}`);
    expect(await restarted.store.incompleteOperations(), `crash after change ${crashAfter}`).toEqual([]);
    expect(await restarted.application.recoverOperations(), `crash after change ${crashAfter}`).toEqual([]);
  }
}

// ---------------------------------------------------------------------------------------------------------- Merge

const event = (externalId: string): CalendarEvent => {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  return { externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: ["Marie Curie"], attendeeDetails: [{ displayName: "Marie Curie" }, { email: "marie.curie@example.com", displayName: "Marie Curie" }] };
};

/** An older person and the calendar duplicate, referenced from a meeting, its note (fields and a body link), a task and a client; one merge suggestion. */
async function mergeScenario() {
  const calendar = new FakeCalendar();
  const context = await open(undefined, calendar);
  const { application } = context;
  const keep = await application.createEntity("person", { title: "Marie Curie" });
  calendar.events = [event("e1")];
  const workspace = await application.createMeetingFromEvent("e1");
  const dup = application.entities("person").find((person) => person.frontmatter.origin === "calendar")!;
  await application.updateBody(workspace.note!.frontmatter.id, `Ask [Marie](lifeos://object/${dup.frontmatter.id}) about the pilot, and [her](lifeos://object/${dup.frontmatter.id.toUpperCase()}).\n`, workspace.note!.contentHash);
  const task = await application.createEntity("task", { title: "Send Marie the deck", owner_person_id: dup.frontmatter.id });
  const client = await application.createEntity("client", { title: "Radium Labs", primary_contact_person_id: dup.frontmatter.id });
  const [reviewId] = await application.suggestPersonMerges();
  const keepId = (application.object(reviewId!).frontmatter.proposed_fields as Record<string, string>).keep_person_id!;
  const mergedId = keepId === keep.frontmatter.id ? dup.frontmatter.id : keep.frontmatter.id;
  const ids = [keep.frontmatter.id, dup.frontmatter.id, workspace.meeting.frontmatter.id, workspace.note!.frontmatter.id, task.frontmatter.id, client.frontmatter.id];
  return { context, application, reviewId: reviewId!, keepId, mergedId, taskId: task.frontmatter.id, noteId: workspace.note!.frontmatter.id, ids, before: snapshot(application, ids) };
}
type MergeState = Awaited<ReturnType<typeof mergeScenario>>;

describe("undoing a merge", () => {
  it("restores both people, their emails and aliases, and every reference, exactly as they were", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    expect(s.application.object(s.mergedId).frontmatter.deleted_at).toEqual(expect.any(String));
    expect(s.application.object(s.taskId).frontmatter.owner_person_id).toBe(s.keepId);
    expect(snapshot(s.application, s.ids)).not.toEqual(s.before);

    const undone = await s.application.undoReviewAction(s.reviewId);
    expect(undone.outcome).toBe("undone");
    expect(undone.revertedObjectIds).toEqual(expect.arrayContaining([s.keepId, s.mergedId, s.taskId, s.noteId]));
    expect(undone.review.frontmatter).toMatchObject({ status: "pending" });
    expect(undone.review.frontmatter.resolved_object_id).toBeUndefined();
    expect(snapshot(s.application, s.ids)).toEqual(s.before);
    expect(s.application.object(s.noteId).body).toContain(`lifeos://object/${s.mergedId}`);
    expect(s.application.object(s.noteId).body).toContain(`lifeos://object/${s.mergedId.toUpperCase()}`);
    expect(await s.context.store.incompleteOperations()).toEqual([]);
    expect(await audits(s.application, "review.undone")).toEqual([expect.objectContaining({ frontmatter: expect.objectContaining({ object_id: s.reviewId, metadata: expect.objectContaining({ undone: "accepted", restored_person_id: s.mergedId, kept_person_id: s.keepId }) }) })]);
    expect((await s.application.health()).diagnostics).toEqual([]);
  });

  it("keeps what the merge changed in its audit, without copying bodies", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    const [audit] = await audits(s.application, "person.merged");
    const record = (audit!.frontmatter.metadata as { undo_record: { version: number; changes: Array<Record<string, unknown>> } }).undo_record;
    expect(record.version).toBe(1);
    expect(record.changes.map((change) => change.id)).toEqual(expect.arrayContaining([s.keepId, s.mergedId, s.taskId, s.noteId]));
    const note = record.changes.find((change) => change.id === s.noteId)!;
    expect(note.body_links).toHaveLength(2);
    expect(JSON.stringify(record)).not.toContain("about the pilot");
  });

  it("can be merged again afterwards, and that merge can be undone too", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    await s.application.undoReviewAction(s.reviewId);
    await s.application.acceptReviewItem(s.reviewId);
    expect(s.application.object(s.taskId).frontmatter.owner_person_id).toBe(s.keepId);
    expect(await audits(s.application, "person.merged")).toHaveLength(2);
    await s.application.undoReviewAction(s.reviewId);
    expect(snapshot(s.application, s.ids)).toEqual(s.before);
  });

  it("is idempotent: a second, or concurrent, undo changes nothing more", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    await Promise.all([s.application.undoReviewAction(s.reviewId), s.application.undoReviewAction(s.reviewId)]);
    expect((await s.application.undoReviewAction(s.reviewId)).outcome).toBe("already-pending");
    expect(await audits(s.application, "review.undone")).toHaveLength(1);
    expect(snapshot(s.application, s.ids)).toEqual(s.before);
  });

  it.each([
    ["the kept person was edited", async (s: MergeState) => { const kept = s.application.object(s.keepId); await s.application.updateEntity(s.keepId, { job_title: "Chemist" }, kept.contentHash); }, /was changed or merged again after the merge/],
    ["a re-pointed task was edited", async (s: MergeState) => { const task = s.application.object(s.taskId); await s.application.updateTask(s.taskId, { priority: "High" }, task.contentHash); }, /was changed after the merge/]
  ])("is refused, writing nothing, when %s", async (_name, change, reason) => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    await change(s);
    const before = await s.application.listObjects();
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(reason);
    expect(await s.application.listObjects()).toEqual(before);
    expect(s.application.object(s.reviewId).frontmatter.status).toBe("accepted");
    expect(await s.context.store.incompleteOperations()).toEqual([]);
  });

  it("is refused when the kept person was merged into someone else since", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    const third = await s.application.createEntity("person", { title: "Pierre Curie" });
    await s.application.mergePeople({ personId: s.keepId, otherPersonId: third.frontmatter.id, keepPersonId: third.frontmatter.id });
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/was changed or merged again after the merge/);
    expect(s.application.object(s.reviewId).frontmatter.status).toBe("accepted");
  });

  it("is refused for a merge made before LifeOS recorded what it changed", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    const [audit] = await audits(s.application, "person.merged");
    await rewrite(s.context.root, audit!.relativePath, (frontmatter) => { delete (frontmatter.metadata as Record<string, unknown>).undo_record; });
    await s.application.rebuildIndex();
    const before = await s.application.listObjects();
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/before LifeOS kept a record of what it changed/);
    expect(await s.application.listObjects()).toEqual(before);
  });

  it("records its intent first, and recovery finishes it from any crash point", async () => {
    await everyCrashPoint(async () => { const s = await mergeScenario(); await s.application.acceptReviewItem(s.reviewId); return s; }, (s: MergeState) => s.application.undoReviewAction(s.reviewId), async (restarted, s, at) => {
      expect(restarted.application.object(s.reviewId).frontmatter.status, at).toBe("pending");
      expect(snapshot(restarted.application, s.ids), at).toEqual(s.before);
      expect(await audits(restarted.application, "review.undone"), at).toHaveLength(1);
    });
  }, 120_000);

  it("lets the user retry a half-finished undo without a restart", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    s.context.store.arm(3); // the intent, then two of the files put back
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/simulated crash/);
    const retry = await open(s.context.root, s.context.calendar);
    expect((await retry.application.undoReviewAction(s.reviewId)).outcome).toBe("undone");
    expect(snapshot(retry.application, s.ids)).toEqual(s.before);
    expect(await audits(retry.application, "review.undone")).toHaveLength(1);
  });

  it("puts the merge back whole when a file is edited while a half-finished undo waits", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    const merged = snapshot(s.application, s.ids);
    s.context.store.arm(3);
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/simulated crash/);
    const restarted = await open(s.context.root, s.context.calendar);
    // The reference files are put back last, so the task still holds the merged value: the user edits it before recovery.
    const task = restarted.application.object(s.taskId);
    await restarted.application.updateTask(s.taskId, { priority: "High" }, task.contentHash);
    await restarted.application.recoverOperations();
    await restarted.application.rebuildIndex();
    expect(restarted.application.object(s.reviewId).frontmatter.status).toBe("accepted");
    expect(restarted.application.object(s.mergedId).frontmatter.deleted_at).toEqual(expect.any(String));
    const { priority: _priority, ...afterEdit } = snapshot(restarted.application, [s.taskId])[s.taskId]! as Record<string, unknown>;
    const { priority: _unset, ...wasMerged } = merged[s.taskId] as Record<string, unknown>;
    expect(afterEdit).toEqual(wasMerged);
    expect(await restarted.store.incompleteOperations()).toEqual([]);
  });

  it("keeps the undo open when putting the merge back whole fails, and a retry converges", async () => {
    const s = await mergeScenario();
    await s.application.acceptReviewItem(s.reviewId);
    s.context.store.arm(3);
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/simulated crash/);
    const restarted = await open(s.context.root, s.context.calendar);
    const task = restarted.application.object(s.taskId);
    await restarted.application.updateTask(s.taskId, { priority: "High" }, task.contentHash);
    // The undo meets the edit and tries to make the merge whole again; that write (the merged person's tombstone) fails.
    const original = restarted.store.write.bind(restarted.store);
    const failing = vi.spyOn(restarted.store, "write").mockImplementation((input) => input.frontmatter.type === "person" && input.frontmatter.deleted_at ? Promise.reject(new Error("disk full")) : original(input));
    await expect(restarted.application.undoReviewAction(s.reviewId)).rejects.toThrow(/disk full/);
    // Not a clean refusal: the journal stays open so the next retry or startup recovery repairs it.
    expect(await restarted.store.incompleteOperations()).toHaveLength(1);
    failing.mockRestore();
    await restarted.application.recoverOperations();
    await restarted.application.rebuildIndex();
    expect(await restarted.store.incompleteOperations()).toEqual([]);
    expect(restarted.application.object(s.reviewId).frontmatter.status).toBe("accepted");
    expect(restarted.application.object(s.mergedId).frontmatter.deleted_at).toEqual(expect.any(String));
    expect(restarted.application.object(s.taskId).frontmatter.owner_person_id).toBe(s.keepId);
    expect(restarted.application.object(s.taskId).frontmatter.priority).toBe("High");
  });

  describe("the kept person's revision", () => {
    const recordIn = (frontmatter: Record<string, unknown>) => (frontmatter.metadata as { undo_record: { changes: Array<{ id: string }>; keep_revision?: number } }).undo_record;

    it("is recorded even when the merge left the kept person out of its changes, and a later edit refuses the undo", async () => {
      const s = await mergeScenario();
      await s.application.acceptReviewItem(s.reviewId);
      const [audit] = await audits(s.application, "person.merged");
      expect(recordIn(audit!.frontmatter).keep_revision).toEqual(expect.any(Number));
      await rewrite(s.context.root, audit!.relativePath, (frontmatter) => { const record = recordIn(frontmatter); record.changes = record.changes.filter((change) => change.id !== s.keepId); });
      await s.application.rebuildIndex();
      const kept = s.application.object(s.keepId);
      await s.application.updateEntity(s.keepId, { job_title: "Chemist" }, kept.contentHash);
      await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/was changed or merged again after the merge/);
      expect(s.application.object(s.reviewId).frontmatter.status).toBe("accepted");
      expect(await s.context.store.incompleteOperations()).toEqual([]);
    });

    it("keeps records written without it readable", async () => {
      const s = await mergeScenario();
      await s.application.acceptReviewItem(s.reviewId);
      const [audit] = await audits(s.application, "person.merged");
      await rewrite(s.context.root, audit!.relativePath, (frontmatter) => { delete recordIn(frontmatter).keep_revision; });
      await s.application.rebuildIndex();
      expect((await s.application.undoReviewAction(s.reviewId)).outcome).toBe("undone");
      expect(snapshot(s.application, s.ids)).toEqual(s.before);
    });
  });
});

// ------------------------------------------------------------------------------------------------- Keep separate

describe("undoing Keep separate", () => {
  it("puts the suggestion back to pending, as the same item, and it is not suggested twice", async () => {
    const s = await mergeScenario();
    await s.application.rejectReviewItem(s.reviewId);
    expect(await s.application.suggestPersonMerges()).toEqual([]);

    const undone = await s.application.undoReviewAction(s.reviewId);
    expect(undone.review.frontmatter).toMatchObject({ id: s.reviewId, status: "pending" });
    expect(undone.review.frontmatter.reviewed_at).toBeUndefined();
    expect(await s.application.suggestPersonMerges()).toEqual([]);
    expect(s.application.reviews().filter((review) => review.frontmatter.review_type === "person-merge")).toHaveLength(1);
    expect(await audits(s.application, "review.undone")).toHaveLength(1);

    // The suggestion works as before: merge it, then undo that too.
    await s.application.acceptReviewItem(s.reviewId);
    expect(s.application.object(s.mergedId).frontmatter.deleted_at).toEqual(expect.any(String));
  });

  it("is idempotent and crash-safe", async () => {
    const s = await mergeScenario();
    await s.application.rejectReviewItem(s.reviewId);
    await Promise.all([s.application.undoReviewAction(s.reviewId), s.application.undoReviewAction(s.reviewId)]);
    expect(await audits(s.application, "review.undone")).toHaveLength(1);
    await everyCrashPoint(async () => { const next = await mergeScenario(); await next.application.rejectReviewItem(next.reviewId); return next; }, (next: MergeState) => next.application.undoReviewAction(next.reviewId), async (restarted, next, at) => {
      expect(restarted.application.object(next.reviewId).frontmatter.status, at).toBe("pending");
      expect(await audits(restarted.application, "review.undone"), at).toHaveLength(1);
    });
  }, 120_000);

  it("is refused when one of the two people was merged into someone else since", async () => {
    const s = await mergeScenario();
    await s.application.rejectReviewItem(s.reviewId);
    const third = await s.application.createEntity("person", { title: "Pierre Curie" });
    await s.application.mergePeople({ personId: s.keepId, otherPersonId: third.frontmatter.id, keepPersonId: third.frontmatter.id });
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/no longer exists or was merged since/);
    expect(s.application.object(s.reviewId).frontmatter.status).toBe("rejected");
  });
});

// ------------------------------------------------------------------------------------------------ Link resolution

const personFile = (id: string, title: string, email: string) => `---\nid: ${id}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: 2026-09-01T08:00:00.000Z\nupdated_at: 2026-09-01T08:00:00.000Z\nupdated_by_device: test\ngiven_name: ${title.split(" ")[0]}\nidentifiers:\n  - kind: email\n    value: ${email}\n---\n# ${title}\n`;

async function dropInbox(root: string, folder: "drafts" | "patches", name: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", folder, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify(fields).trimEnd()}\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

/** A task waiting for "Joel", two people called Joel: one link-resolution Review Item. */
async function linkScenario() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-undo-decisions-"));
  roots.push(root);
  const joelM = uuidV7(), joelD = uuidV7();
  await mkdir(path.join(root, "people"), { recursive: true });
  await writeFile(path.join(root, "people", `${joelM}.md`), personFile(joelM, "Joel Martin", "joel.martin@example.com"));
  await writeFile(path.join(root, "people", `${joelD}.md`), personFile(joelD, "Joel Durand", "joel.durand@example.org"));
  const context = await open(root);
  await dropInbox(root, "drafts", "link.md", { lifeos_draft: 1, kind: "task", draft_key: "link.md", origin: "user-dictated", title: "Send the sizing deck", captured_at: "2026-10-04T09:15:00+02:00", status: "Waiting", waiting_for: "Joel" });
  await context.application.adoptDrafts();
  await context.application.rebuildIndex();
  const task = (await context.application.listObjects()).find((object) => object.frontmatter.type === "task")!;
  const review = context.application.reviews().find((item) => item.frontmatter.review_type === "link-resolution")!;
  expect(task.frontmatter.waiting_for_person_id).toBeUndefined();
  return { context, application: context.application, taskId: task.frontmatter.id, reviewId: review.frontmatter.id, joelD, joelM };
}
type LinkState = Awaited<ReturnType<typeof linkScenario>>;

describe("undoing a link resolution", () => {
  it("takes the link back, and the item can be accepted again with another choice", async () => {
    const s = await linkScenario();
    await s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD });
    expect(s.application.object(s.taskId).frontmatter.waiting_for_person_id).toBe(s.joelD);

    const undone = await s.application.undoReviewAction(s.reviewId);
    expect(undone).toMatchObject({ outcome: "undone", revertedObjectIds: [s.taskId] });
    expect(s.application.object(s.taskId).frontmatter.waiting_for_person_id).toBeUndefined();
    expect(undone.review.frontmatter).toMatchObject({ status: "pending" });
    for (const field of ["resolved_object_id", "chosen_object_id", "link_undo", "reviewed_at"]) expect(undone.review.frontmatter[field], field).toBeUndefined();
    expect(await audits(s.application, "review.undone")).toEqual([expect.objectContaining({ frontmatter: expect.objectContaining({ object_id: s.reviewId, metadata: expect.objectContaining({ undone: "accepted", reverted_object_ids: [s.taskId] }) }) })]);

    await s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelM });
    expect(s.application.object(s.taskId).frontmatter.waiting_for_person_id).toBe(s.joelM);
    await s.application.undoReviewAction(s.reviewId);
    expect(s.application.object(s.taskId).frontmatter.waiting_for_person_id).toBeUndefined();
  });

  it("records what the link replaced before writing the link", async () => {
    const s = await linkScenario();
    await s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD });
    expect(s.application.object(s.reviewId).frontmatter.link_undo).toEqual({ target_id: s.taskId, field: "waiting_for_person_id", list: false, previous: null, linked: s.joelD, changed: true });
  });

  it("is idempotent", async () => {
    const s = await linkScenario();
    await s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD });
    await Promise.all([s.application.undoReviewAction(s.reviewId), s.application.undoReviewAction(s.reviewId)]);
    expect((await s.application.undoReviewAction(s.reviewId)).outcome).toBe("already-pending");
    expect(await audits(s.application, "review.undone")).toHaveLength(1);
  });

  it("is refused, writing nothing, when the field was changed since", async () => {
    const s = await linkScenario();
    await s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD });
    const task = s.application.object(s.taskId);
    await s.application.updateTask(s.taskId, { waiting_for_person_id: s.joelM }, task.contentHash);
    const before = await s.application.listObjects();
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/waiting_for_person_id of "Send the sizing deck" was changed after the link was accepted/);
    expect(await s.application.listObjects()).toEqual(before);
    expect(s.application.object(s.reviewId).frontmatter.status).toBe("accepted");
  });

  it("is refused for a link accepted before LifeOS recorded what it replaced", async () => {
    const s = await linkScenario();
    await s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD });
    await rewrite(s.context.root, s.application.object(s.reviewId).relativePath, (frontmatter) => { delete frontmatter.link_undo; });
    await s.application.rebuildIndex();
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/before LifeOS kept a record/);
    expect(s.application.object(s.taskId).frontmatter.waiting_for_person_id).toBe(s.joelD);
  });

  it("records its intent first, and recovery finishes it from any crash point", async () => {
    await everyCrashPoint(async () => { const s = await linkScenario(); await s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD }); return s; }, (s: LinkState) => s.application.undoReviewAction(s.reviewId), async (restarted, s, at) => {
      expect(restarted.application.object(s.reviewId).frontmatter.status, at).toBe("pending");
      expect(restarted.application.object(s.taskId).frontmatter.waiting_for_person_id, at).toBeUndefined();
      expect(await audits(restarted.application, "review.undone"), at).toHaveLength(1);
    });
  }, 120_000);

  it("keeps the record when the accept itself crashes between the record and the link, so a retry still undoes cleanly", async () => {
    const s = await linkScenario();
    s.context.store.arm(2); // the record on the item, then the link on the task; the item is not yet accepted
    await expect(s.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD })).rejects.toThrow(/simulated crash/);
    const retry = await open(s.context.root);
    await retry.application.acceptReviewItem(s.reviewId, { linkTo: s.joelD });
    expect(retry.application.object(s.reviewId).frontmatter.link_undo).toMatchObject({ previous: null, changed: true });
    await retry.application.undoReviewAction(s.reviewId);
    expect(retry.application.object(s.taskId).frontmatter.waiting_for_person_id).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------- Apply change

const draftPatch = (fields: Record<string, unknown>) => ({ lifeos_patch: 1, draft_key: `key-${uuidV7()}`, origin: "user-dictated", captured_at: "2026-01-01T09:00:00Z", ...fields });

/** A task and a dictated rename (with a note when asked) that waits as an `update` Review Item. */
async function updateScenario(note?: string) {
  const context = await open();
  const task = await context.application.quickCapture("Call the bank");
  await context.application.updateBody(task.frontmatter.id, "# Call the bank\n\nBring the contract.\n", context.application.object(task.frontmatter.id).contentHash);
  await dropInbox(context.root, "patches", "rename.md", draftPatch({ id: task.frontmatter.id, set: { title: "Call the bank about the loan" }, ...(note ? { append_note: note } : {}) }));
  await context.application.adoptDrafts();
  await context.application.rebuildIndex();
  const review = context.application.reviews().find((item) => item.frontmatter.review_type === "update")!;
  const targetId = task.frontmatter.id;
  return { context, application: context.application, targetId, reviewId: review.frontmatter.id, original: snapshot(context.application, [targetId]) };
}
type UpdateState = Awaited<ReturnType<typeof updateScenario>>;

describe("undoing Apply change", () => {
  it("reverts the fields, and the item can be applied again", async () => {
    const s = await updateScenario();
    await s.application.acceptReviewItem(s.reviewId);
    expect(s.application.object(s.targetId).frontmatter.title).toBe("Call the bank about the loan");

    const undone = await s.application.undoReviewAction(s.reviewId);
    expect(undone).toMatchObject({ outcome: "undone", revertedObjectIds: [s.targetId] });
    expect(snapshot(s.application, [s.targetId])).toEqual(s.original);
    expect(undone.review.frontmatter).toMatchObject({ status: "pending" });
    expect(undone.review.frontmatter.resolved_object_id).toBeUndefined();
    expect(await audits(s.application, "review.undone")).toHaveLength(1);

    await s.application.acceptReviewItem(s.reviewId);
    expect(s.application.object(s.targetId).frontmatter.title).toBe("Call the bank about the loan");
  });

  it("removes exactly the note it added, and leaves the body as it was", async () => {
    const s = await updateScenario("Asked for the rate sheet.");
    await s.application.acceptReviewItem(s.reviewId);
    expect(s.application.object(s.targetId).body).toContain("Asked for the rate sheet.");
    await s.application.undoReviewAction(s.reviewId);
    expect(snapshot(s.application, [s.targetId])).toEqual(s.original);
  });

  it("is idempotent", async () => {
    const s = await updateScenario();
    await s.application.acceptReviewItem(s.reviewId);
    await Promise.all([s.application.undoReviewAction(s.reviewId), s.application.undoReviewAction(s.reviewId)]);
    expect((await s.application.undoReviewAction(s.reviewId)).outcome).toBe("already-pending");
    expect(await audits(s.application, "review.undone")).toHaveLength(1);
  });

  it.each([
    ["a changed field was edited since", async (s: UpdateState) => { await s.application.updateTask(s.targetId, { title: "Phone the bank" }, s.application.object(s.targetId).contentHash); }, /title of "Phone the bank" changed after the change was applied/],
    ["the note was edited since", async (s: UpdateState) => { await s.application.updateBody(s.targetId, `${s.application.object(s.targetId).body}Later thought.\n`, s.application.object(s.targetId).contentHash); }, /the added note of .* changed after the change was applied/]
  ])("is refused, writing nothing, when %s", async (name, change, reason) => {
    const s = await updateScenario("Asked for the rate sheet.");
    await s.application.acceptReviewItem(s.reviewId);
    await change(s);
    const before = await s.application.listObjects();
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(reason);
    expect(await s.application.listObjects()).toEqual(before);
    expect(s.application.object(s.reviewId).frontmatter.status, name).toBe("accepted");
  });

  it("is refused when the item added a note but LifeOS did not keep the exact text (accepted before #242)", async () => {
    const s = await updateScenario("Asked for the rate sheet.");
    await s.application.acceptReviewItem(s.reviewId);
    await rewrite(s.context.root, s.application.object(s.reviewId).relativePath, (frontmatter) => { delete frontmatter.applied_append; });
    await s.application.rebuildIndex();
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/did not keep the exact text/);
    expect(s.application.object(s.targetId).body).toContain("Asked for the rate sheet.");
  });

  it("is refused for a change a decision cannot be moved back from", async () => {
    const context = await open();
    const decision = await context.application.createDecision({ title: "Use Postgres", decision_text: "We use Postgres" });
    await dropInbox(context.root, "patches", "reverse.md", draftPatch({ id: decision.frontmatter.id, set: { status: "reversed" } }));
    await context.application.adoptDrafts();
    await context.application.rebuildIndex();
    const review = context.application.reviews().find((item) => item.frontmatter.review_type === "update");
    expect(review, "a decision status change is raised for review").toBeDefined();
    await context.application.acceptReviewItem(review!.frontmatter.id);
    await expect(context.application.undoReviewAction(review!.frontmatter.id)).rejects.toThrow(/status of a decision cannot be changed back/);
    expect(context.application.object(decision.frontmatter.id).frontmatter.status).toBe("reversed");
  });

  it("records its intent first, and recovery finishes it from any crash point", async () => {
    await everyCrashPoint(async () => { const s = await updateScenario("Asked for the rate sheet."); await s.application.acceptReviewItem(s.reviewId); return s; }, (s: UpdateState) => s.application.undoReviewAction(s.reviewId), async (restarted, s, at) => {
      expect(restarted.application.object(s.reviewId).frontmatter.status, at).toBe("pending");
      expect(snapshot(restarted.application, [s.targetId]), at).toEqual(s.original);
      expect(await audits(restarted.application, "review.undone"), at).toHaveLength(1);
    });
  }, 120_000);
});

describe("a decision that cannot be undone is a refusal, not a server error", () => {
  it("refuses an accepted change whose proposal lost its list of changes", async () => {
    const s = await updateScenario();
    await s.application.acceptReviewItem(s.reviewId);
    const review = s.application.object(s.reviewId);
    await rewrite(s.context.root, review.relativePath, (frontmatter) => { (frontmatter.proposed_fields as Record<string, unknown>).changes = "oops"; });
    await s.application.rebuildIndex();
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect(await s.context.store.incompleteOperations()).toEqual([]);
  });
});

describe("what stays refused", () => {
  it("still shows no Undo for an accepted meeting summary, and every other decision has one", () => {
    expect(isReviewActionUndoable("summary", "accepted")).toBe(false);
    expect(isReviewActionUndoable("summary", "rejected")).toBe(true);
    for (const type of ["create", "person-merge", "link-resolution", "update", undefined]) expect(isReviewActionUndoable(type, "accepted"), String(type)).toBe(true);
    expect(isReviewActionUndoable("person-merge", "rejected")).toBe(true);
  });
});
