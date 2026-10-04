import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import type { ObjectEnvelope } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #82: rejecting a Review Item whose accept was interrupted records the reject before the first rollback write,
// so a crash at any point of the rollback ends, after restart, rejected and rolled back, never accepted.

const roots: string[] = [];
// The crash loops below open a fresh vault per step, so they get more time than one scenario.
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type WriteInput = { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string };

/**
 * A store whose process "dies" at its `crashAt`-th change once armed (a write or closing an operation: before it lands;
 * preparing an operation: after it lands). `crashOnWrite` sets up the interrupted accept.
 */
class CrashingStore extends MarkdownObjectStore {
  crashAt?: number;
  steps = 0;
  crashOnWrite?: (input: WriteInput) => boolean;
  private step() {
    if (this.crashAt === undefined) return;
    if (++this.steps === this.crashAt) { this.crashAt = undefined; throw new Error("power cut"); }
  }
  override async write(input: WriteInput) {
    if (this.crashOnWrite?.(input)) { this.crashOnWrite = undefined; throw new Error("power cut"); }
    this.step();
    return super.write(input);
  }
  override async completeOperation(operationId: string) {
    this.step();
    return super.completeOperation(operationId);
  }
  override async prepareOperation(kind: string, payload: Record<string, unknown>, operationId: string) {
    const prepared = await super.prepareOperation(kind, payload, operationId);
    this.step();
    return prepared;
  }
}

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

async function open(root?: string, calendar: CalendarConnector = new MockCalendarConnector()) {
  root ??= await mkdtemp(path.join(tmpdir(), "lifeos-reject-intent-"));
  if (!roots.includes(root)) roots.push(root);
  const store = new CrashingStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, new MockAiProvider(), "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

/** Startup after a crash: rebuild, recover, rebuild (as apps/server does). */
async function restart(root: string, calendar?: CalendarConnector) {
  const context = await open(root, calendar);
  await context.application.recoverOperations();
  await context.application.rebuildIndex();
  return context;
}

const audits = async (application: LifeOSApplication, action: string) => (await application.rebuildIndex(), await application.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action);

/** A create proposal whose accept wrote its object, then died before marking the item accepted. */
async function interruptedCreate() {
  const context = await open();
  const { application, store } = context;
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  const reviewId = (await application.processMeeting(workspace.meeting.frontmatter.id))[0]!.frontmatter.id;
  store.crashOnWrite = (input) => input.frontmatter.type === "review-item" && input.frontmatter.status === "accepted";
  await expect(application.acceptReviewItem(reviewId)).rejects.toThrow(/power cut/);
  const [operation] = await store.incompleteOperations();
  return { ...context, calendar: undefined, reviewId, createdId: String(operation!.payload.objectId) };
}

/** A person merge that moved the references, then died before the tombstone. */
async function interruptedMerge() {
  const calendar = new FakeCalendar();
  const context = await open(undefined, calendar);
  const { application, store } = context;
  const keep = await application.createEntity("person", { title: "Marie Curie" });
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  calendar.events = [{ externalId: "e1", title: "Pilot", startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: ["Marie Curie"], attendeeDetails: [{ email: "marie.curie@example.com", displayName: "Marie Curie" }] }];
  await application.createMeetingFromEvent("e1");
  const dup = (await application.listObjects()).find((object) => object.frontmatter.type === "person" && object.frontmatter.origin === "calendar")!;
  const task = await application.createEntity("task", { title: "Send Marie the deck", owner_person_id: dup.frontmatter.id });
  const [reviewId] = await application.suggestPersonMerges();
  const before = application.object(keep.frontmatter.id).frontmatter;
  store.crashOnWrite = (input) => !!input.frontmatter.merged_into_person_id;
  await expect(application.acceptReviewItem(reviewId!)).rejects.toThrow(/power cut/);
  await application.rebuildIndex();
  expect(application.object(task.frontmatter.id).frontmatter.owner_person_id).toBe(keep.frontmatter.id);
  return { ...context, calendar, reviewId: reviewId!, keepId: keep.frontmatter.id, dupId: dup.frontmatter.id, taskId: task.frontmatter.id, keepBefore: { identifiers: before.identifiers, aliases: before.aliases } };
}

/** How many changes an uninterrupted reject makes (so the crash loop below covers every one of them). */
async function rejectSteps(scenario: () => Promise<{ store: CrashingStore; application: LifeOSApplication; reviewId: string }>) {
  const s = await scenario();
  s.store.crashAt = Number.MAX_SAFE_INTEGER;
  await s.application.rejectReviewItem(s.reviewId);
  return s.store.steps;
}

describe("a crash during reject of an interrupted create-accept (#82)", () => {
  it("records the reject intent before the first rollback write", async () => {
    const s = await interruptedCreate();
    s.store.crashAt = 1;
    await expect(s.application.rejectReviewItem(s.reviewId)).rejects.toThrow(/power cut/);
    const open = await s.store.incompleteOperations();
    expect(open.map((operation) => operation.kind).sort()).toEqual(["accept-review", "reject-review"]);
    expect(open.find((operation) => operation.kind === "reject-review")!.payload).toMatchObject({ reviewId: s.reviewId });
    await s.application.rebuildIndex();
    expect(s.application.object(s.createdId).frontmatter.deleted_at).toBeUndefined();
  });

  it("after a crash at any step, restart rolls the object back and rejects the item, with every audit once", async () => {
    const steps = await rejectSteps(interruptedCreate);
    expect(steps).toBeGreaterThanOrEqual(4);
    for (let crashAt = 1; crashAt <= steps; crashAt++) {
      const s = await interruptedCreate();
      s.store.crashAt = crashAt;
      await expect(s.application.rejectReviewItem(s.reviewId), `crash at step ${crashAt}`).rejects.toThrow(/power cut/);

      const restarted = await restart(s.root);
      const { application } = restarted;
      expect(application.object(s.reviewId).frontmatter.status, `crash at step ${crashAt}`).toBe("rejected");
      expect(application.object(s.createdId).frontmatter.deleted_at, `crash at step ${crashAt}`).toEqual(expect.any(String));
      expect(await audits(application, "review.accepted")).toHaveLength(0);
      expect(await audits(application, "review.rejected"), `crash at step ${crashAt}`).toHaveLength(1);
      expect(await audits(application, "review.accept-rolled-back"), `crash at step ${crashAt}`).toHaveLength(1);
      expect(await restarted.store.incompleteOperations()).toEqual([]);
      expect((await application.health()).diagnostics).toEqual([]);
    }
  }, 60_000);

  it("the user retrying the reject before any restart also ends rejected, audits once", async () => {
    const s = await interruptedCreate();
    s.store.crashAt = 2;
    await expect(s.application.rejectReviewItem(s.reviewId)).rejects.toThrow(/power cut/);
    const retried = await open(s.root);
    expect((await retried.application.rejectReviewItem(s.reviewId)).frontmatter.status).toBe("rejected");
    expect(await audits(retried.application, "review.rejected")).toHaveLength(1);
    expect(await retried.store.incompleteOperations()).toEqual([]);
  });
});

describe("a crash during reject of an interrupted person merge (#82)", () => {
  it("after a crash at any step, restart puts every reference back and rejects the item, with every audit once", async () => {
    const steps = await rejectSteps(interruptedMerge);
    expect(steps).toBeGreaterThanOrEqual(4);
    for (let crashAt = 1; crashAt <= steps; crashAt++) {
      const s = await interruptedMerge();
      s.store.crashAt = crashAt;
      await expect(s.application.rejectReviewItem(s.reviewId), `crash at step ${crashAt}`).rejects.toThrow(/power cut/);

      const restarted = await restart(s.root, s.calendar);
      const { application } = restarted;
      expect(application.object(s.reviewId).frontmatter.status, `crash at step ${crashAt}`).toBe("rejected");
      expect(application.object(s.taskId).frontmatter.owner_person_id, `crash at step ${crashAt}`).toBe(s.dupId);
      expect(application.object(s.dupId).frontmatter).not.toHaveProperty("deleted_at");
      expect(application.object(s.dupId).frontmatter).not.toHaveProperty("merged_into_person_id");
      const keep = application.object(s.keepId).frontmatter;
      expect({ identifiers: keep.identifiers, aliases: keep.aliases }, `crash at step ${crashAt}`).toEqual(s.keepBefore);
      expect(await audits(application, "person.merged")).toHaveLength(0);
      expect(await audits(application, "review.rejected"), `crash at step ${crashAt}`).toHaveLength(1);
      expect(await audits(application, "person.merge-rolled-back"), `crash at step ${crashAt}`).toHaveLength(1);
      expect(await restarted.store.incompleteOperations()).toEqual([]);
      expect((await application.health()).diagnostics).toEqual([]);
    }
  }, 60_000);
});

describe("recovery never completes an accept whose reject is recorded (#82)", () => {
  it("a user accept while the reject is still open finishes the reject instead", async () => {
    const s = await interruptedCreate();
    s.store.crashAt = 1;
    await expect(s.application.rejectReviewItem(s.reviewId)).rejects.toThrow(/power cut/);
    const reopened = await open(s.root);
    await expect(reopened.application.acceptReviewItem(s.reviewId)).rejects.toThrow(/rejected/);
    expect(reopened.application.object(s.reviewId).frontmatter.status).toBe("rejected");
    expect(await audits(reopened.application, "review.accepted")).toHaveLength(0);
    expect(await reopened.store.incompleteOperations()).toEqual([]);
  });
});
