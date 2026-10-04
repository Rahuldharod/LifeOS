import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import type { ObjectEnvelope } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #56: rejecting a Review Item undoes the unfinished accept it left behind, and startup recovery never
// stops the server because of one operation.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

/** Fails the accept's last step (marking the Review Item accepted), as a conflicting edit would. */
class FailingStore extends MarkdownObjectStore {
  failAcceptedReview = false;
  /** Every write of an object with this title fails. */
  failTitle?: string;
  override async write(input: { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string }) {
    if (input.frontmatter.title === this.failTitle) throw new Error("disk full");
    if (this.failAcceptedReview && input.frontmatter.type === "review-item" && input.frontmatter.status === "accepted") throw new Error("review changed meanwhile");
    return super.write(input);
  }
}

async function setup(root?: string) {
  root ??= await mkdtemp(path.join(tmpdir(), "lifeos-review-recovery-"));
  if (!roots.includes(root)) roots.push(root);
  const store = new FailingStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), new MockCalendarConnector(), new MockAiProvider(), "test");
  await application.rebuildIndex();
  return { root, store, application };
}

async function proposals() {
  const context = await setup();
  const { application } = context;
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  const reviews = await application.processMeeting(workspace.meeting.frontmatter.id);
  return { ...context, reviews };
}

/** An accept that wrote the new object, then failed at the review update; returns the half-created object's ID. */
async function failedCreateAccept() {
  const context = await proposals();
  const review = context.reviews[0]!;
  context.store.failAcceptedReview = true;
  await expect(context.application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow("review changed meanwhile");
  context.store.failAcceptedReview = false;
  const [operation] = await context.store.incompleteOperations();
  expect(operation).toMatchObject({ kind: "accept-review", id: review.frontmatter.operation_id });
  return { ...context, reviewId: review.frontmatter.id, createdId: String(operation!.payload.objectId) };
}

describe("rejecting a Review Item with an unfinished operation (#56)", () => {
  it("removes the object a failed create-accept left behind, then marks the item rejected", async () => {
    const s = await failedCreateAccept();
    await s.application.rebuildIndex();
    expect(s.application.object(s.createdId).frontmatter.deleted_at).toBeUndefined();

    const rejected = await s.application.rejectReviewItem(s.reviewId);
    expect(rejected.frontmatter.status).toBe("rejected");
    expect(s.application.object(s.createdId).frontmatter.deleted_at).toEqual(expect.any(String));
    expect(await s.store.incompleteOperations()).toEqual([]);

    const restarted = await setup(s.root);
    expect(await restarted.application.recoverOperations()).toEqual([]);
    expect(restarted.application.object(s.reviewId).frontmatter.status).toBe("rejected");
  });

  it("recovery closes a create operation whose Review Item was already rejected, and the server starts", async () => {
    const s = await failedCreateAccept();
    await s.application.rebuildIndex();
    // State left by a reject that ignored the operation (before #56).
    const review = s.application.object(s.reviewId);
    await s.store.write({ relativePath: review.relativePath, frontmatter: { ...review.frontmatter, status: "rejected", revision: review.frontmatter.revision + 1 }, body: review.body, expectedHash: review.contentHash });

    const restarted = await setup(s.root);
    expect(await restarted.application.recoverOperations()).toHaveLength(1);
    expect(restarted.application.object(s.createdId).frontmatter.deleted_at).toEqual(expect.any(String));
    expect(restarted.application.object(s.reviewId).frontmatter.status).toBe("rejected");
    expect(await restarted.store.incompleteOperations()).toEqual([]);
    expect((await restarted.application.health()).diagnostics).toEqual([]);
  });
});

describe("startup recovery isolates a failing operation (#56)", () => {
  it("logs the failure, shows it in System Health and still recovers the others", async () => {
    const s = await proposals();
    const [broken, good] = s.reviews;
    const brokenOperation = String(broken!.frontmatter.operation_id), goodOperation = String(good!.frontmatter.operation_id);
    await s.store.prepareOperation("accept-review", { reviewId: broken!.frontmatter.id, objectId: "01995d53-0000-7000-8000-0000000000aa" }, brokenOperation);
    await s.store.prepareOperation("accept-review", { reviewId: good!.frontmatter.id, objectId: "01995d53-0000-7000-8000-0000000000bb" }, goodOperation);

    const restarted = await setup(s.root);
    // Recovery cannot finish the first one: writing its object keeps failing.
    restarted.store.failTitle = broken!.frontmatter.title;
    const failures: string[] = [];
    const recovered = await restarted.application.recoverOperations({ onError: (_error, operation) => failures.push(operation.id) });
    expect(recovered).toEqual([goodOperation]);
    expect(failures).toEqual([brokenOperation]);
    expect(restarted.application.object(good!.frontmatter.id).frontmatter.status).toBe("accepted");
    const health = await restarted.application.health();
    expect(health.status).toBe("attention");
    expect(health.diagnostics).toEqual([expect.stringMatching(new RegExp(`${brokenOperation}.*disk full`))]);
    // The failed operation stays open, so the next start tries again.
    expect((await restarted.store.incompleteOperations()).map((operation) => operation.id)).toEqual([brokenOperation]);
  });
});
