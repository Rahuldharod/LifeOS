import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #67: accepting an update Review Item that supersedes decision A with an existing decision B sets
// both links (A → B and B → A) through the same recoverable path as the Decisions workspace Supersede.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vault(store?: (root: string) => MarkdownObjectStore) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-supersede-review-"));
  roots.push(root);
  const application = new LifeOSApplication(store?.(root) ?? new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, application };
}

async function dropPatch(root: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox/patches/supersede.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ lifeos_patch: 1, draft_key: "supersede", origin: "user-dictated", captured_at: "2026-01-01T09:00:00Z", ...fields }).trimEnd()}\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

/** A hand edit outside the app, e.g. in Obsidian. */
async function editOnDisk(root: string, relativePath: string, changes: Record<string, unknown>) {
  const file = path.join(root, relativePath);
  const [, yaml, body] = (await readFile(file, "utf8")).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)!;
  await writeFile(file, `---\n${stringify({ ...parse(yaml!), ...changes }).trimEnd()}\n---\n${body}`);
}

async function raiseSupersede(root: string, application: LifeOSApplication) {
  const old = await application.createDecision({ title: "Use Postgres" });
  const successor = await application.createDecision({ title: "Use DuckDB" });
  await dropPatch(root, { id: old.frontmatter.id, set: { superseded_by: "use duckdb" } });
  expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
  const review = (await application.reviews()).find((item) => item.frontmatter.review_type === "update")!;
  return { old, successor, review };
}

const audits = (application: LifeOSApplication, action: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action));

describe("superseding a decision through an update Review Item", () => {
  it("sets both links on accept, like the Decisions workspace Supersede", async () => {
    const { root, application } = await vault();
    const { old, successor, review } = await raiseSupersede(root, application);

    await application.acceptReviewItem(review.frontmatter.id);

    expect(application.object(old.frontmatter.id).frontmatter).toMatchObject({ status: "superseded", superseded_by_decision_id: successor.frontmatter.id, revision: 2 });
    expect(application.object(successor.frontmatter.id).frontmatter).toMatchObject({ status: "active", supersedes_decision_id: old.frontmatter.id, revision: 2 });
    expect(application.decision(old.frontmatter.id).supersededBy?.frontmatter.id).toBe(successor.frontmatter.id);
    expect(application.decision(successor.frontmatter.id).supersedes?.frontmatter.id).toBe(old.frontmatter.id);
    expect(application.object(review.frontmatter.id).frontmatter).toMatchObject({ status: "accepted", resolved_object_id: old.frontmatter.id });
    expect((await audits(application, "decision.superseded")).map((audit) => audit.frontmatter.object_id)).toEqual([old.frontmatter.id]);

    // Accepting again changes nothing.
    await application.acceptReviewItem(review.frontmatter.id);
    expect(application.object(successor.frontmatter.id).frontmatter.revision).toBe(2);
    expect(await audits(application, "decision.superseded")).toHaveLength(1);
  });

  it.each([
    ["deleted", /DuckDB.*was deleted/, async (root: string, application: LifeOSApplication, id: string) => {
      await editOnDisk(root, application.object(id).relativePath, { deleted_at: "2026-01-02T09:00:00Z" });
      await application.rebuildIndex();
    }],
    ["archived", /DuckDB.*was archived/, async (_root: string, application: LifeOSApplication, id: string) => {
      await application.archiveObject(id, application.object(id).contentHash);
    }],
    ["no longer active", /DuckDB.*is reversed/, async (_root: string, application: LifeOSApplication, id: string) => {
      await application.updateDecision(id, { status: "reversed" }, application.object(id).contentHash);
    }]
  ])("refuses when the successor was %s after the item was raised, and writes nothing", async (_name, message, change) => {
    const { root, application } = await vault();
    const { old, successor, review } = await raiseSupersede(root, application);
    await change(root, application, successor.frontmatter.id);
    const before = application.object(successor.frontmatter.id);

    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow(message);

    expect(application.object(old.frontmatter.id).frontmatter).toMatchObject({ status: "active", revision: 1 });
    expect(application.object(old.frontmatter.id).frontmatter.superseded_by_decision_id).toBeUndefined();
    expect(application.object(successor.frontmatter.id).contentHash).toBe(before.contentHash);
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("pending");
    expect(await audits(application, "decision.superseded")).toHaveLength(0);
    expect(await application.recoverOperations()).toHaveLength(0);
  });

  it("finishes the successor's link through operation recovery after a crash between the two writes", async () => {
    let failSuccessor = true;
    class CrashingStore extends MarkdownObjectStore {
      override async write(input: Parameters<MarkdownObjectStore["write"]>[0]) {
        if (failSuccessor && input.frontmatter.type === "decision" && input.frontmatter.supersedes_decision_id) { failSuccessor = false; throw new Error("disk full"); }
        return super.write(input);
      }
    }
    const { root, application } = await vault((directory) => new CrashingStore(directory));
    const { old, successor, review } = await raiseSupersede(root, application);

    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow(/disk full/);
    expect(await application.recoverOperations()).toHaveLength(1);
    expect(application.object(successor.frontmatter.id).frontmatter.supersedes_decision_id).toBe(old.frontmatter.id);

    // The item still pending sees its change landed and is marked accepted without another write.
    await application.acceptReviewItem(review.frontmatter.id);
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("accepted");
    expect(application.object(old.frontmatter.id).frontmatter).toMatchObject({ status: "superseded", superseded_by_decision_id: successor.frontmatter.id, revision: 2 });
    expect(application.object(successor.frontmatter.id).frontmatter.revision).toBe(2);
  });
});

// Issue #70: recovery of an unfinished supersede never overwrites a decision edited after the crash, and a
// successor deleted after the old decision's link landed leaves the Review Item resolvable, not stuck.
describe("recovering an unfinished supersede", () => {
  /** A store whose process "dies" right after the next supersede operation is prepared. */
  class CrashAfterPrepare extends MarkdownObjectStore {
    crash = false;
    override async prepareOperation(kind: string, payload: Record<string, unknown>, operationId: string) {
      const prepared = await super.prepareOperation(kind, payload, operationId);
      if (this.crash && kind === "supersede-decision") { this.crash = false; throw new Error("power cut"); }
      return prepared;
    }
  }

  async function crashedAfterPrepare() {
    let store!: CrashAfterPrepare;
    const { root, application } = await vault((directory) => (store = new CrashAfterPrepare(directory)));
    const raised = await raiseSupersede(root, application);
    store.crash = true;
    await expect(application.acceptReviewItem(raised.review.frontmatter.id)).rejects.toThrow(/power cut/);
    return { root, application, store, ...raised };
  }

  it("records the old decision's base hash when the operation is prepared", async () => {
    const { store, old } = await crashedAfterPrepare();
    const [operation] = await store.incompleteOperations();
    expect(operation).toMatchObject({ kind: "supersede-decision", payload: { oldId: old.frontmatter.id, baseHash: old.contentHash } });
  });

  it("writes nothing to a decision edited after the crash, closes the operation and leaves a conflict to resolve", async () => {
    const { root, application, store, old, successor, review } = await crashedAfterPrepare();
    await editOnDisk(root, old.relativePath, { rationale: "Edited in Obsidian after the crash" });
    await application.rebuildIndex();
    const edited = application.object(old.frontmatter.id);

    expect(await application.recoverOperations()).toHaveLength(1);

    expect(application.object(old.frontmatter.id).contentHash).toBe(edited.contentHash);
    expect(application.object(old.frontmatter.id).frontmatter).toMatchObject({ status: "active", rationale: "Edited in Obsidian after the crash" });
    expect(application.object(successor.frontmatter.id).contentHash).toBe(successor.contentHash);
    expect(await store.incompleteOperations()).toHaveLength(0);
    expect(await audits(application, "decision.superseded")).toHaveLength(0);
    expect(await audits(application, "decision.supersede-abandoned")).toHaveLength(1);
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("pending");
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toMatchObject({ name: "ObjectConflictError", message: expect.stringMatching(/changed since this review item was raised/) });
    expect((await application.rejectReviewItem(review.frontmatter.id)).frontmatter.status).toBe("rejected");
    expect(application.object(old.frontmatter.id).contentHash).toBe(edited.contentHash);
  });

  it("finishes the supersede as before when the old decision is unchanged since prepare", async () => {
    const { application, store, old, successor, review } = await crashedAfterPrepare();

    expect(await application.recoverOperations()).toHaveLength(1);

    expect(application.object(old.frontmatter.id).frontmatter).toMatchObject({ status: "superseded", superseded_by_decision_id: successor.frontmatter.id, revision: 2 });
    expect(application.object(successor.frontmatter.id).frontmatter).toMatchObject({ supersedes_decision_id: old.frontmatter.id, revision: 2 });
    expect(await store.incompleteOperations()).toHaveLength(0);
    await application.acceptReviewItem(review.frontmatter.id);
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("accepted");
    expect(await audits(application, "decision.superseded")).toHaveLength(1);
  });

  it("does not supersede through the Decisions workspace path either when the old decision was edited after the crash", async () => {
    let store!: CrashAfterPrepare;
    const { root, application } = await vault((directory) => (store = new CrashAfterPrepare(directory)));
    const old = await application.createDecision({ title: "Budget is 10k" });
    store.crash = true;
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "Budget is 12k" }, old.contentHash)).rejects.toThrow(/power cut/);
    await editOnDisk(root, old.relativePath, { rationale: "Edited after the crash" });
    await application.rebuildIndex();
    const edited = application.object(old.frontmatter.id);

    expect(await application.recoverOperations()).toHaveLength(1);

    expect(application.object(old.frontmatter.id).contentHash).toBe(edited.contentHash);
    expect(application.decisions().map((decision) => decision.frontmatter.title)).toEqual(["Budget is 10k"]);
    expect(await store.incompleteOperations()).toHaveLength(0);
  });

  it.each([
    ["deleted", (root: string, relativePath: string) => editOnDisk(root, relativePath, { deleted_at: "2026-01-02T09:00:00Z" })],
    ["removed from disk", (root: string, relativePath: string) => rm(path.join(root, relativePath))]
  ])("lets the Review Item be rejected when the successor was %s after the old decision's link landed", async (_name, remove) => {
    let failSuccessor = true;
    class CrashingStore extends MarkdownObjectStore {
      override async write(input: Parameters<MarkdownObjectStore["write"]>[0]) {
        if (failSuccessor && input.frontmatter.type === "decision" && input.frontmatter.supersedes_decision_id) { failSuccessor = false; throw new Error("disk full"); }
        return super.write(input);
      }
    }
    let store!: CrashingStore;
    const { root, application } = await vault((directory) => (store = new CrashingStore(directory)));
    const { old, successor, review } = await raiseSupersede(root, application);
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow(/disk full/);
    await remove(root, successor.relativePath);
    await application.rebuildIndex();
    const before = (await application.listObjects()).find((object) => object.frontmatter.id === successor.frontmatter.id)?.contentHash;

    // Recovery closes the operation instead of failing on every start, and never writes to the deleted successor.
    expect(await application.recoverOperations()).toHaveLength(1);
    expect(await store.incompleteOperations()).toHaveLength(0);
    expect((await application.listObjects()).find((object) => object.frontmatter.id === successor.frontmatter.id)?.contentHash).toBe(before);
    expect(await audits(application, "decision.supersede-abandoned")).toHaveLength(1);

    // Accepting explains why it cannot finish; rejecting resolves the item.
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow(/reject this review item/i);
    expect((await application.rejectReviewItem(review.frontmatter.id)).frontmatter.status).toBe("rejected");
    expect(application.object(old.frontmatter.id).frontmatter).toMatchObject({ status: "superseded", superseded_by_decision_id: successor.frontmatter.id });
  });
});
