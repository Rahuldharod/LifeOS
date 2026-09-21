import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownObjectStore, ObjectConflictError } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("MarkdownObjectStore", () => {
  it("writes, reads and detects stale hashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-store-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const frontmatter = {
      id: "01995d3e-912b-7357-8aa6-9816c1ad90a5",
      type: "person" as const,
      schema_version: 1,
      revision: 1,
      title: "Example User",
      given_name: "Example",
      created_at: "2026-09-20T08:00:00Z",
      updated_at: "2026-09-20T08:00:00Z",
      updated_by_device: "test-device"
    };
    const written = await store.write({ relativePath: "people/example.md", frontmatter, body: "Hello\n" });
    expect((await store.list())[0]?.frontmatter.id).toBe(frontmatter.id);
    await expect(store.write({ relativePath: "people/example.md", frontmatter, body: "Changed\n", expectedHash: "stale" })).rejects.toBeInstanceOf(ObjectConflictError);
    expect((await store.read("people/example.md")).contentHash).toBe(written.contentHash);
  });

  it("rejects paths outside the data root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-store-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    await expect(store.read("../escape.md")).rejects.toThrow("escapes");
  });

  it("normalizes a trailing slash on the configured data root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-store-"));
    roots.push(root);
    const store = new MarkdownObjectStore(`${root}${path.sep}`);
    const created = await store.write({
      relativePath: "people/example.md",
      frontmatter: {
        id: "01995d3e-912b-7357-8aa6-9816c1ad90a5",
        type: "person",
        schema_version: 1,
        revision: 1,
        title: "Example User",
        given_name: "Example",
        created_at: "2026-09-20T08:00:00Z",
        updated_at: "2026-09-20T08:00:00Z",
        updated_by_device: "test-device"
      },
      body: "Hello\n"
    });
    expect(created.relativePath).toBe("people/example.md");
  });

  it("retains prior revisions and reports malformed files without hiding valid objects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-store-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const frontmatter = { id: "01995d3e-912b-7357-8aa6-9816c1ad90a5", type: "person" as const, schema_version: 1, revision: 1, title: "Example User", given_name: "Example", created_at: "2026-09-20T08:00:00Z", updated_at: "2026-09-20T08:00:00Z", updated_by_device: "test-device" };
    const first = await store.write({ relativePath: "people/example.md", frontmatter, body: "Original unknown syntax: [[Wiki Link]]\n" });
    await store.write({ relativePath: "people/example.md", expectedHash: first.contentHash, frontmatter: { ...frontmatter, revision: 2, updated_at: "2026-09-20T09:00:00Z" }, body: "Original unknown syntax: [[Wiki Link]]\n" });
    await writeFile(path.join(root, "people", "broken.md"), "not front matter", "utf8");
    const scan = await store.scan();
    expect(scan.objects).toHaveLength(1);
    expect(scan.diagnostics[0]).toContain("broken.md");
    expect((await readdir(path.join(root, ".lifeos", "versions", frontmatter.id)))[0]).toMatch(/^000001--/);
    expect((await store.read("people/example.md")).body).toContain("[[Wiki Link]]");
  });
});
