import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #27 (U3): two files with one ID are both reported, one wins deterministically, and writes are refused.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const task = (title: string, createdAt: string) => `---\nid: ${taskId}\ntype: task\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: ${createdAt}\nupdated_at: ${createdAt}\nupdated_by_device: test\nstatus: Inbox\nowner_person_id: ${selfId}\n---\n# ${title}\n`;
const self = `---\nid: ${selfId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n`;

async function vault(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-duplicates-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex());
  await application.rebuildIndex();
  return { root, application };
}

describe("duplicate object IDs", () => {
  it("reports every copy with its path, three or more included", async () => {
    const { application } = await vault({
      "people/self.md": self,
      "tasks/a.md": task("A", "2026-10-02T08:00:00Z"),
      "tasks/b.md": task("B", "2026-10-01T08:00:00Z"),
      "tasks/c.md": task("C", "2026-10-03T08:00:00Z")
    });
    const issue = (await application.health()).diagnostics.find((entry) => entry.startsWith("Duplicate object ID"));
    expect(issue).toBeDefined();
    for (const file of ["tasks/a.md", "tasks/b.md", "tasks/c.md"]) expect(issue).toContain(file);
  });

  it("reads the oldest created_at as the winner, then path order, stable across rebuilds", async () => {
    const { application } = await vault({ "people/self.md": self, "tasks/z.md": task("Newer", "2026-10-02T08:00:00Z"), "tasks/y.md": task("Older", "2026-10-01T08:00:00Z") });
    expect(application.object(taskId).frontmatter.title).toBe("Older");
    await application.rebuildIndex();
    expect(application.object(taskId).frontmatter.title).toBe("Older");

    const tie = await vault({ "people/self.md": self, "tasks/b.md": task("Second path", "2026-10-01T08:00:00Z"), "tasks/a.md": task("First path", "2026-10-01T08:00:00Z") });
    expect(tie.application.object(taskId).frontmatter.title).toBe("First path");
  });

  it("refuses every write to the duplicated ID, naming both paths", async () => {
    const { application } = await vault({ "people/self.md": self, "tasks/a.md": task("A", "2026-10-01T08:00:00Z"), "tasks/b.md": task("B", "2026-10-02T08:00:00Z") });
    const current = application.object(taskId);
    const refusal = /Duplicate object ID .*tasks\/a\.md.*tasks\/b\.md/;
    await expect(application.updateTask(taskId, { status: "Next" }, current.contentHash)).rejects.toThrow(refusal);
    await expect(application.updateEntity(taskId, { title: "Renamed" }, current.contentHash)).rejects.toThrow(refusal);
    await expect(application.archiveObject(taskId, current.contentHash)).rejects.toThrow(refusal);
    await expect(application.updateTask(taskId, { status: "Next" }, current.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
  });

  it("allows writes again once one copy is removed and the index rebuilds", async () => {
    const { root, application } = await vault({ "people/self.md": self, "tasks/a.md": task("A", "2026-10-01T08:00:00Z"), "tasks/b.md": task("B", "2026-10-02T08:00:00Z") });
    await unlink(path.join(root, "tasks/b.md"));
    await application.rebuildIndex();
    const current = application.object(taskId);
    const updated = await application.updateTask(taskId, { status: "Next" }, current.contentHash);
    expect(updated.frontmatter.status).toBe("Next");
    expect((await application.health()).diagnostics.some((entry) => entry.startsWith("Duplicate object ID"))).toBe(false);
  });
});
