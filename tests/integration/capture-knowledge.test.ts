import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

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
  });
});
