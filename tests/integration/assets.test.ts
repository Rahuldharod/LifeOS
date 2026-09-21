import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemAssetStore } from "@lifeos/assets-filesystem";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("managed image assets", () => {
  it("creates readable relative paths and deduplicates identical image bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-assets-"));
    roots.push(root);
    const assets = new FilesystemAssetStore(root);
    const content = new Uint8Array([137, 80, 78, 71, 13, 10]);

    const first = await assets.put({ ownerRelativePath: "meetings/weekly-notes.md", fileName: "Architecture Diagram.png", mimeType: "image/png", content });
    const second = await assets.put({ ownerRelativePath: "meetings/weekly-notes.md", fileName: "Screenshot.png", mimeType: "image/png", content });

    expect(first.relativePath).toMatch(/^assets\/\d{4}-\d{2}-\d{2}-architecture-diagram--[a-f0-9]{16}\.png$/);
    expect(first.markdownPath).toBe(`../${first.relativePath}`);
    expect(first.deduplicated).toBe(false);
    expect(second.relativePath).toBe(first.relativePath);
    expect(second.deduplicated).toBe(true);
    expect(await assets.read(first.relativePath)).toEqual(Buffer.from(content));
  });

  it("reports missing managed images through the object-store health scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-assets-health-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const timestamp = "2026-09-21T06:00:00Z";
    await store.write({
      relativePath: "meetings/note.md",
      frontmatter: { id: "01995d52-7baf-7c21-9c96-9c5d2f6a32ac", type: "meeting-note", schema_version: 1, revision: 1, title: "Notes", created_at: timestamp, updated_at: timestamp, updated_by_device: "test", meeting_id: "01995d4e-a934-70e5-a5a6-85e31541a91f" },
      body: "![Diagram](../assets/missing-diagram.png)\n"
    });

    const scan = await store.scan();
    expect(scan.diagnostics).toContain("meetings/note.md: missing managed image ../assets/missing-diagram.png");
  });
});
