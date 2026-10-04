import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #28: guarded saves compare the revision as well as the content hash; new objects need UUIDv7 IDs.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-revision-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex());
  await application.rebuildIndex();
  return { root, store, application };
}

const timestamp = "2026-10-01T08:00:00Z";
const envelope = (id: string) => ({ id, type: "person" as const, schema_version: 1, revision: 1, title: "Ada", created_at: timestamp, updated_at: timestamp, updated_by_device: "test", given_name: "Ada" });

describe("revision check on guarded saves", () => {
  it("rejects a save when the file on disk moved to a newer revision, even with the same body", async () => {
    const { root, application } = await setup();
    const task = await application.quickCapture("Draft the sizing deck");
    // Another writer bumps only the revision; the body is untouched.
    const file = path.join(root, task.relativePath);
    await writeFile(file, (await readFile(file, "utf8")).replace("revision: 1", "revision: 2"));
    await expect(application.updateTask(task.frontmatter.id, { status: "Next" }, task.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
  });

  it("rejects a guarded write whose revision does not follow the revision on disk", async () => {
    const { store } = await setup();
    const created = await store.write({ relativePath: "people/ada.md", frontmatter: envelope("01995d3e-912b-7357-8aa6-9816c1ad90a5"), body: "" });
    await expect(store.write({ relativePath: "people/ada.md", expectedHash: created.contentHash, frontmatter: { ...created.frontmatter, revision: 5 }, body: "" }))
      .rejects.toThrow(/revision 1 on disk, expected 4/);
  });

  it("saves and increments the revision when hash and revision both match", async () => {
    const { application } = await setup();
    const task = await application.quickCapture("Draft the sizing deck");
    const updated = await application.updateTask(task.frontmatter.id, { status: "Next" }, task.contentHash);
    expect(updated.frontmatter.revision).toBe(2);
  });
});

describe("UUIDv7 identity", () => {
  it("rejects creating an object with a non-v7 UUID, with a clear reason", async () => {
    const { store } = await setup();
    await expect(store.write({ relativePath: "people/ada.md", frontmatter: envelope("3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"), body: "" }))
      .rejects.toThrow(/3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e is not a UUIDv7/);
  });

  it("keeps existing non-v7 files readable and reports them in System Health", async () => {
    const { root, application } = await setup();
    const v4 = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
    await mkdir(path.join(root, "people"), { recursive: true });
    await writeFile(path.join(root, "people", "legacy.md"), `---\nid: ${v4}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: Legacy\ncreated_at: ${timestamp}\nupdated_at: ${timestamp}\nupdated_by_device: test\ngiven_name: Legacy\n---\n`);
    const { diagnostics } = await application.rebuildIndex();
    expect(application.object(v4).frontmatter.title).toBe("Legacy");
    expect(diagnostics).toContain(`people/legacy.md (id ${v4}): ID is not a UUIDv7; new objects must use UUIDv7`);
  });
});
