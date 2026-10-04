import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore, type MarkdownObjectStoreOptions } from "@lifeos/object-store-markdown";

// Issue #85: each object's history lists its kept versions and the audit events about them (external edits,
// restores), newest first, and any kept version can be put back through a guarded write.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const task = (title: string) => `---\nid: ${taskId}\ntype: task\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:01:00Z\nupdated_by_device: test\nstatus: Inbox\nowner_person_id: ${selfId}\n---\n# ${title}\n`;
const self = `---\nid: ${selfId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n`;

async function vault(options?: MarkdownObjectStoreOptions) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-history-view-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries({ "people/self.md": self, "tasks/task.md": task("Original") })) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const application = new LifeOSApplication(new MarkdownObjectStore(root, options), new MemoryIndex(), undefined, undefined, "this-mac");
  await application.rebuildIndex();
  await application.recordExternalChanges(); // first look keeps the starting file as the baseline
  return { root, application, file: path.join(root, "tasks/task.md") };
}

const save = (application: LifeOSApplication, title: string) => application.updateTask(taskId, { title }, application.object(taskId).contentHash);

describe("object history (#85)", () => {
  it("lists kept versions newest first, with time, device and whether each came from an external edit", async () => {
    const { application, file } = await vault();
    await save(application, "Saved in LifeOS");
    await writeFile(file, task("Edited in Obsidian").replace("revision: 1", "revision: 2"));
    expect(await application.recordExternalChanges()).toHaveLength(1);

    const history = await application.objectHistory(taskId);
    const versions = history.filter((entry) => entry.kind === "version");
    expect(versions.map((entry) => entry.title)).toEqual(["Edited in Obsidian", "Saved in LifeOS", "Original"]);
    expect(versions[0]).toMatchObject({ external: true, current: true });
    expect(versions[1]).toMatchObject({ external: false, current: false, device: "this-mac", revision: 2 });
    expect(versions.every((entry) => typeof entry.at === "string" && entry.kept)).toBe(true);

    const event = history.find((entry) => entry.kind === "event");
    expect(event).toMatchObject({ action: "object.changed-externally", external: true, device: "this-mac", kept: true });
    const times = history.map((entry) => Date.parse(entry.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("restores a kept version through a guarded write, and the restore appears in history", async () => {
    const { application } = await vault();
    await save(application, "Second");
    await save(application, "Third");
    const original = (await application.objectHistory(taskId)).find((entry) => entry.kind === "version" && entry.title === "Original")!;

    const restored = await application.restoreKeptVersion(taskId, original.versionPath!);
    expect(restored.frontmatter).toMatchObject({ title: "Original", revision: 4, updated_by_device: "this-mac" });
    expect(application.object(taskId).frontmatter.title).toBe("Original");

    const history = await application.objectHistory(taskId);
    expect(history.find((entry) => entry.kind === "event")).toMatchObject({ action: "object.restored-from-version", external: false, versionPath: original.versionPath });
    expect(history.find((entry) => entry.kind === "version")).toMatchObject({ title: "Original", revision: 4, current: true });
    // The app's own write is not an external edit.
    expect(await application.recordExternalChanges()).toEqual([]);
  });

  it("marks an external edit whose copy was pruned as no longer kept, and refuses to restore it without changing anything", async () => {
    const { application, file } = await vault({ versionsToKeep: 2 });
    await writeFile(file, task("Edited in Obsidian"));
    await application.recordExternalChanges();
    for (let index = 1; index <= 3; index += 1) await save(application, `Save ${index}`);

    const pruned = (await application.objectHistory(taskId)).find((entry) => entry.kind === "event" && entry.external)!;
    expect(pruned).toMatchObject({ kept: false });
    const before = application.object(taskId).contentHash;
    await expect(application.restoreKeptVersion(taskId, pruned.versionPath!)).rejects.toThrow("This version is no longer kept (only the last 10 are)");
    expect(application.object(taskId).contentHash).toBe(before);
  });

  it("only restores copies from the object's own versions folder", async () => {
    const { application } = await vault();
    await expect(application.restoreKeptVersion(taskId, "people/self.md")).rejects.toThrow(/Not a kept version/);
    await expect(application.restoreKeptVersion(taskId, `.lifeos/versions/${taskId}/../${selfId}/000001--abc.md`)).rejects.toThrow(/Not a kept version/);
  });
});
