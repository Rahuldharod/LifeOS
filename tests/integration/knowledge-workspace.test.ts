import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Knowledge source intake (#137)", () => {
  it("returns durable completion only after preserving the Source Markdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-knowledge-workspace-"));
    roots.push(root);
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test-device");
    await application.rebuildIndex();

    const source = await application.ingestTextSource("Synthetic research", "Portable Markdown remains authoritative.");

    expect(source.frontmatter).toMatchObject({ type: "source", title: "Synthetic research", source_type: "pasted-text", ingestion_status: "captured", origin: "app" });
    const files = await readdir(path.join(root, "sources"));
    expect(files).toHaveLength(1);
    const markdown = await readFile(path.join(root, "sources", files[0]!), "utf8");
    expect(markdown).toContain("source_type: pasted-text");
    expect(markdown).toContain("Portable Markdown remains authoritative.");
    expect(application.knowledge()).toEqual([]);
  });
});
