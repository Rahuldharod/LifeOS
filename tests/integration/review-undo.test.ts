import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore } from "@lifeos/object-store-markdown";
import { CrashingStore } from "./crash-store.js";

// ADR 0025: Review actions can be undone. Undoing a reject puts the item back to pending; undoing an accept also
// deletes the object the accept created, unless that object was edited since. The undo is journalled (ADR 0013).

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

async function open(root?: string, calendar: CalendarConnector = new MockCalendarConnector()) {
  root ??= await mkdtemp(path.join(tmpdir(), "lifeos-review-undo-"));
  if (!roots.includes(root)) roots.push(root);
  const store = new CrashingStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, new MockAiProvider(), "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

/** A meeting whose notes yield create proposals. */
async function proposals() {
  const context = await open();
  const { application } = context;
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  const reviews = await application.processMeeting(workspace.meeting.frontmatter.id);
  return { ...context, reviews, reviewId: reviews[0]!.frontmatter.id };
}

const audits = async (application: LifeOSApplication, action: string) => (await application.rebuildIndex(), await application.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action);
const pendingIds = (application: LifeOSApplication) => application.reviews().filter((review) => review.frontmatter.status === "pending").map((review) => review.frontmatter.id);

describe("undoing a reject", () => {
  it("puts the item back to pending, and it can be accepted afterwards", async () => {
    const { application, reviewId } = await proposals();
    await application.rejectReviewItem(reviewId);
    expect(pendingIds(application)).not.toContain(reviewId);

    const undone = await application.undoReviewAction(reviewId);
    expect(undone.outcome).toBe("undone");
    expect(undone.review.frontmatter).toMatchObject({ status: "pending" });
    expect(undone.review.frontmatter.reviewed_at).toBeUndefined();
    expect(pendingIds(application)).toContain(reviewId);
    expect(await audits(application, "review.undone")).toHaveLength(1);

    const accepted = await application.acceptReviewItem(reviewId);
    expect(accepted.frontmatter.deleted_at).toBeUndefined();
  });

  it("is idempotent: a second undo changes nothing", async () => {
    const { application, reviewId } = await proposals();
    await application.rejectReviewItem(reviewId);
    await application.undoReviewAction(reviewId);
    const again = await application.undoReviewAction(reviewId);
    expect(again.outcome).toBe("already-pending");
    expect(await audits(application, "review.undone")).toHaveLength(1);
    const twice = await Promise.all([application.rejectReviewItem(reviewId), application.rejectReviewItem(reviewId)]);
    expect(twice[0]!.frontmatter.status).toBe("rejected");
    await Promise.all([application.undoReviewAction(reviewId), application.undoReviewAction(reviewId)]);
    expect(application.object(reviewId).frontmatter.status).toBe("pending");
    expect(await audits(application, "review.undone")).toHaveLength(2);
  });

  it("refuses a kind of decision it cannot undo yet, and leaves it as it was", async () => {
    const calendar = new FakeCalendar();
    const startsAt = new Date(Date.now() + 3_600_000).toISOString();
    calendar.events = [{ externalId: "e1", title: "Pilot", startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: ["Marie Curie"], attendeeDetails: [{ email: "marie.curie@example.com", displayName: "Marie Curie" }] }];
    const { application } = await open(undefined, calendar);
    await application.createEntity("person", { title: "Marie Curie" });
    await application.createMeetingFromEvent("e1");
    const duplicate = (await application.listObjects()).find((object) => object.frontmatter.type === "person" && object.frontmatter.origin === "calendar")!;
    await application.createEntity("task", { title: "Send Marie the deck", owner_person_id: duplicate.frontmatter.id });
    const [reviewId] = await application.suggestPersonMerges();
    await application.rejectReviewItem(reviewId!);
    await expect(application.undoReviewAction(reviewId!)).rejects.toThrow(/cannot be undone yet/);
    expect(application.object(reviewId!).frontmatter.status).toBe("rejected");
  });
});

describe("undoing an accept", () => {
  it("puts the item back to pending and deletes the object it created", async () => {
    const { application, store, reviewId } = await proposals();
    const created = await application.acceptReviewItem(reviewId);
    expect(created.frontmatter.revision).toBe(1);

    const undone = await application.undoReviewAction(reviewId);
    expect(undone).toMatchObject({ outcome: "undone", deletedObjectId: created.frontmatter.id });
    expect(undone.review.frontmatter.status).toBe("pending");
    expect(undone.review.frontmatter.resolved_object_id).toBeUndefined();
    expect(application.object(created.frontmatter.id).frontmatter.deleted_at).toEqual(expect.any(String));
    expect(await store.incompleteOperations()).toEqual([]);
    expect(await audits(application, "review.undone")).toEqual([expect.objectContaining({ frontmatter: expect.objectContaining({ object_id: reviewId, metadata: expect.objectContaining({ review_id: reviewId, undone: "accepted", deleted_object_id: created.frontmatter.id }) }) })]);
  });

  it("creates a new object when the item is accepted again, not the deleted one", async () => {
    const { application, reviewId } = await proposals();
    const first = await application.acceptReviewItem(reviewId);
    await application.undoReviewAction(reviewId);
    const second = await application.acceptReviewItem(reviewId);
    expect(second.frontmatter.id).not.toBe(first.frontmatter.id);
    expect(second.frontmatter.deleted_at).toBeUndefined();
    expect(application.object(first.frontmatter.id).frontmatter.deleted_at).toEqual(expect.any(String));
    expect(application.object(reviewId).frontmatter.resolved_object_id).toBe(second.frontmatter.id);
    // And that accept can be undone again.
    expect((await application.undoReviewAction(reviewId)).deletedObjectId).toBe(second.frontmatter.id);
  });

  it("is idempotent: a second undo finds the item pending and deletes nothing more", async () => {
    const { application, reviewId } = await proposals();
    await application.acceptReviewItem(reviewId);
    await Promise.all([application.undoReviewAction(reviewId), application.undoReviewAction(reviewId)]);
    expect((await application.undoReviewAction(reviewId)).outcome).toBe("already-pending");
    expect(await audits(application, "review.undone")).toHaveLength(1);
  });

  it("is refused, writing nothing, when the created object was edited after the accept", async () => {
    const { application, store, reviewId } = await proposals();
    const created = await application.acceptReviewItem(reviewId);
    const edited = await application.updateTask(created.frontmatter.id, { priority: "High" }, created.contentHash);
    const before = await application.listObjects();

    await expect(application.undoReviewAction(reviewId)).rejects.toThrow(/was changed after it was accepted/);
    expect(await application.listObjects()).toEqual(before);
    expect(application.object(reviewId).frontmatter.status).toBe("accepted");
    expect(application.object(created.frontmatter.id).frontmatter).toMatchObject({ priority: "High", revision: edited.frontmatter.revision });
    expect(await store.incompleteOperations()).toEqual([]);
  });

  it("keeps a restricted item restricted, and its object restricted when accepted again", async () => {
    const { application, reviewId } = await proposals();
    await application.setSensitivity(reviewId, "restricted", application.object(reviewId).contentHash);
    const first = await application.acceptReviewItem(reviewId);
    expect(first.frontmatter.sensitivity).toBe("restricted");
    const undone = await application.undoReviewAction(reviewId);
    expect(undone.review.frontmatter.sensitivity).toBe("restricted");
    expect((await application.acceptReviewItem(reviewId)).frontmatter.sensitivity).toBe("restricted");
  });
});

describe("a crash during undo", () => {
  it("records the undo intent first, then recovery finishes it from any point", async () => {
    const clean = await proposals();
    await clean.application.acceptReviewItem(clean.reviewId);
    clean.store.arm(Number.MAX_SAFE_INTEGER);
    await clean.application.undoReviewAction(clean.reviewId);
    expect(clean.store.log[0]).toBe("prepare undo-review");
    const changes = clean.store.changes;
    expect(changes).toBeGreaterThanOrEqual(4);

    for (let crashAfter = 1; crashAfter < changes; crashAfter += 1) {
      const s = await proposals();
      const created = await s.application.acceptReviewItem(s.reviewId);
      s.store.arm(crashAfter);
      await expect(s.application.undoReviewAction(s.reviewId), `crash after change ${crashAfter}`).rejects.toThrow(/simulated crash/);

      const restarted = await open(s.root);
      await restarted.application.recoverOperations();
      await restarted.application.rebuildIndex();
      expect(restarted.application.object(s.reviewId).frontmatter.status, `crash after change ${crashAfter}`).toBe("pending");
      expect(restarted.application.object(created.frontmatter.id).frontmatter.deleted_at, `crash after change ${crashAfter}`).toEqual(expect.any(String));
      expect(await restarted.store.incompleteOperations()).toEqual([]);
      expect(await audits(restarted.application, "review.undone"), `crash after change ${crashAfter}`).toHaveLength(1);
      expect(await restarted.application.recoverOperations()).toEqual([]);
    }
  });

  it("lets the user retry the undo without a restart, and finishes the same one", async () => {
    const s = await proposals();
    const created = await s.application.acceptReviewItem(s.reviewId);
    s.store.arm(2); // the intent, then the object's deletion; the item is not yet pending
    await expect(s.application.undoReviewAction(s.reviewId)).rejects.toThrow(/simulated crash/);
    const retry = await open(s.root);
    expect((await retry.application.undoReviewAction(s.reviewId)).outcome).toBe("undone");
    expect(retry.application.object(s.reviewId).frontmatter.status).toBe("pending");
    expect(retry.application.object(created.frontmatter.id).frontmatter.deleted_at).toEqual(expect.any(String));
    expect(await audits(retry.application, "review.undone")).toHaveLength(1);
  });
});
