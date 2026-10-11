import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import type { ObjectEnvelope } from "@lifeos/domain";

// #115: alone this finishes in well under a second, but a full parallel suite on a busy laptop has pushed it past
// Vitest's 5 s default. A per-test limit keeps the assertions strict; only the wall-clock allowance grows.
const SLOW_UNDER_LOAD_MS = 30_000;

type WriteInput = { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string };

class CrashingCaptureStore extends MarkdownObjectStore {
  crashBeforeAudit = false;
  crashOnClose = false;
  override async write(input: WriteInput) {
    if (this.crashBeforeAudit && input.frontmatter.type === "audit-event") { this.crashBeforeAudit = false; throw new Error("power cut before audit"); }
    return super.write(input);
  }
  override async completeOperation(operationId: string) {
    const capture = (await this.incompleteOperations()).find((operation) => operation.id === operationId)?.kind === "quick-capture";
    if (this.crashOnClose && capture) { this.crashOnClose = false; throw new Error("power cut before close"); }
    return super.completeOperation(operationId);
  }
}

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("capture and knowledge workflows", () => {
  it("captures and edits task lifecycle, then publishes an evidence-linked Knowledge Note", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-capture-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const application = new LifeOSApplication(store, new MemoryIndex(), undefined, new MockAiProvider(), "test-device");
    await application.rebuildIndex();
    const task = await application.quickCapture("Prepare launch brief");
    const updated = await application.updateTask(task.frontmatter.id, { status: "Next", priority: "High", due_on: "2026-09-22", expected_output: "A reviewed brief" }, task.contentHash);
    expect(updated.frontmatter.status).toBe("Next");
    expect(updated.frontmatter.priority).toBe("High");

    const source = await application.ingestTextSource("Research", "Local-first systems keep portable files authoritative.");
    expect(source.frontmatter.type).toBe("source");
    const review = application.reviews().find((item) => item.frontmatter.target_object_type === "knowledge-note");
    expect(review?.frontmatter.field_evidence).toBeTruthy();
    const note = await application.acceptReviewItem(review!.frontmatter.id);
    expect(note.frontmatter.type).toBe("knowledge-note");
    expect(application.knowledge("portable")).toHaveLength(1);
    expect(await store.incompleteOperations()).toHaveLength(0);
  }, SLOW_UNDER_LOAD_MS);

  it("persists global capture details and multiline text through the application boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-global-capture-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test-device");
    await application.rebuildIndex();
    const owner = await application.createEntity("person", { title: "Marie", full_name: "Marie", is_self: false });
    const project = await application.createEntity("project", { title: "Launch" });

    const task = await application.quickCapture("Send the deck\nInclude the revised figures.", {
      primaryProjectId: project.frontmatter.id,
      dueOn: "2026-10-20",
      ownerPersonId: owner.frontmatter.id,
      sensitivity: "restricted"
    });

    expect(task.frontmatter).toMatchObject({ title: "Send the deck", status: "Inbox", primary_project_id: project.frontmatter.id, due_on: "2026-10-20", owner_person_id: owner.frontmatter.id, sensitivity: "restricted" });
    expect(task.body).toBe("# Send the deck\n\nInclude the revised figures.\n");
    expect((await store.read(task.relativePath)).frontmatter).toMatchObject({ status: "Inbox", sensitivity: "restricted" });
  });

  it("rejects stale, deleted and wrong-type capture links before journalling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-global-capture-links-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test-device");
    await application.rebuildIndex();
    const person = await application.createEntity("person", { title: "Marie" });
    const wrongType = await application.createEntity("person", { title: "Pierre" });
    const project = await application.createEntity("project", { title: "Launch" });
    const archived = await application.archiveObject(project.frontmatter.id, project.contentHash);
    const deleted = await application.deleteEntity(person.frontmatter.id, person.contentHash);

    await expect(application.quickCapture("Wrong project", { primaryProjectId: wrongType.frontmatter.id })).rejects.toThrow("Project not found");
    await expect(application.quickCapture("Archived project", { primaryProjectId: archived.frontmatter.id })).rejects.toThrow("Project not found");
    await expect(application.quickCapture("Deleted owner", { ownerPersonId: deleted.frontmatter.id })).rejects.toThrow("Owner not found");
    expect(await store.incompleteOperations()).toEqual([]);
  });

  it("recovers capture failures without duplicating the task or its audit", async () => {
    for (const failure of ["before-audit", "before-close"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `lifeos-global-capture-${failure}-`));
      roots.push(root);
      const crashedStore = new CrashingCaptureStore(root);
      const crashed = new LifeOSApplication(crashedStore, new MemoryIndex(), undefined, undefined, "test-device");
      await crashed.rebuildIndex();
      crashedStore.crashBeforeAudit = failure === "before-audit";
      crashedStore.crashOnClose = failure === "before-close";
      await expect(crashed.quickCapture("Call Marie", { requestId: `capture-${failure}` })).rejects.toThrow("power cut");

      const store = new MarkdownObjectStore(root);
      const restarted = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test-device");
      await restarted.rebuildIndex();
      await restarted.recoverOperations();
      await restarted.rebuildIndex();
      const recovered = await restarted.quickCapture("Call Marie", { requestId: `capture-${failure}` });
      const objects = await restarted.listObjects();

      expect(objects.filter((object) => object.frontmatter.type === "task" && object.frontmatter.title === "Call Marie"), failure).toHaveLength(1);
      expect(objects.filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "task.quick-captured"), failure).toHaveLength(1);
      expect(recovered.frontmatter.title).toBe("Call Marie");
      expect(await store.incompleteOperations()).toEqual([]);
    }
  });
});
