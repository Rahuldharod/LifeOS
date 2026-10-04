import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemOperationStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #62: accepting a Review Item is atomic. A double-click, or two tabs, accepting (or accepting and
// rejecting) the same item at once ends in exactly one outcome, with no extra or orphan objects.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-atomic-accept-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), new MockCalendarConnector(), new MockAiProvider(), "test");
  await application.rebuildIndex();
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId);
  await application.updateBody(workspace.note!.frontmatter.id, "# Notes\n\nShip the pilot.\n", workspace.note!.contentHash);
  const [review] = await application.processMeeting(workspace.meeting.frontmatter.id);
  return { root, store, application, review: review! };
}

/** Live (not deleted) objects created from this Review Item's proposal. */
async function createdFrom(application: LifeOSApplication, title: string) {
  return (await application.listObjects()).filter((object) => object.frontmatter.type !== "review-item" && object.frontmatter.title === title && !object.frontmatter.deleted_at);
}

describe("accepting a Review Item twice at once (#62)", () => {
  it("creates exactly one object and both calls return it", async () => {
    const { application, store, review } = await setup();
    const [first, second] = await Promise.all([application.acceptReviewItem(review.frontmatter.id), application.acceptReviewItem(review.frontmatter.id)]);
    expect(second.frontmatter.id).toBe(first.frontmatter.id);
    await application.rebuildIndex();
    expect((await createdFrom(application, review.frontmatter.title)).map((object) => object.frontmatter.id)).toEqual([first.frontmatter.id]);
    expect(application.object(review.frontmatter.id).frontmatter).toMatchObject({ status: "accepted", resolved_object_id: first.frontmatter.id });
    expect(await store.incompleteOperations()).toEqual([]);
  });

  it("keeps one outcome under many concurrent accepts", async () => {
    const { application, review } = await setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => application.acceptReviewItem(review.frontmatter.id)));
    expect(new Set(results.map((object) => object.frontmatter.id)).size).toBe(1);
    await application.rebuildIndex();
    expect(await createdFrom(application, review.frontmatter.title)).toHaveLength(1);
  });
});

describe("accepting and rejecting a Review Item at once (#62)", () => {
  it("accept first: the item is accepted, the reject fails, and one object exists", async () => {
    const { application, store, review } = await setup();
    const [accept, reject] = await Promise.allSettled([application.acceptReviewItem(review.frontmatter.id), application.rejectReviewItem(review.frontmatter.id)]);
    expect(accept.status).toBe("fulfilled");
    expect(reject.status).toBe("rejected");
    await application.rebuildIndex();
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("accepted");
    expect(await createdFrom(application, review.frontmatter.title)).toHaveLength(1);
    expect(await store.incompleteOperations()).toEqual([]);
  });

  it("reject first: the item is rejected, the accept fails, and no object is left behind", async () => {
    const { application, store, review } = await setup();
    const [reject, accept] = await Promise.allSettled([application.rejectReviewItem(review.frontmatter.id), application.acceptReviewItem(review.frontmatter.id)]);
    expect(reject.status).toBe("fulfilled");
    expect(accept.status).toBe("rejected");
    await application.rebuildIndex();
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("rejected");
    expect(await createdFrom(application, review.frontmatter.title)).toEqual([]);
    expect(await store.incompleteOperations()).toEqual([]);
  });
});

describe("operation files are created exclusively (#62)", () => {
  it("two prepares of one operation keep the first payload; the loser re-reads the winner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-atomic-operation-"));
    roots.push(root);
    const operations = new FilesystemOperationStore(root);
    const id = "01995d53-0000-7000-8000-000000000062";
    const results = await Promise.all(["a", "b", "c", "d"].map((objectId) => operations.prepare("accept-review", { objectId }, id)));
    expect(new Set(results.map((record) => record.payload.objectId)).size).toBe(1);
    const [stored] = await operations.incomplete();
    expect(stored!.payload.objectId).toBe(results[0]!.payload.objectId);
  });
});
