import { mkdir, mkdtemp, open as openFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore, type MarkdownObjectStoreOptions } from "@lifeos/object-store-markdown";

// Issue #79: version copies are published atomically (temporary file, then createExclusive), a truncated copy is
// never used, and restoring a copy that retention has pruned explains why instead of failing obscurely.

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const task = (title: string) => `---\nid: ${taskId}\ntype: task\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:01:00Z\nupdated_by_device: test\nstatus: Inbox\nowner_person_id: ${selfId}\n---\n# ${title}\n${"Some longer body text so a half-written copy is visibly cut short.\n".repeat(20)}`;
const self = `---\nid: ${selfId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n`;

async function vault(options?: MarkdownObjectStoreOptions) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-atomic-versions-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries({ "people/self.md": self, "tasks/task.md": task("Original") })) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const open = async () => {
    const store = new MarkdownObjectStore(root, options);
    const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "this-mac");
    await application.rebuildIndex();
    return { store, application };
  };
  return { root, open, file: path.join(root, "tasks/task.md") };
}

const folder = (root: string) => path.join(root, ".lifeos", "versions", taskId);
const versionNames = async (root: string) => (await readdir(folder(root)).catch(() => [] as string[])).filter((name) => /^\d+--[0-9a-f]+\.md$/.test(name)).sort();
const externalEvents = (application: LifeOSApplication) => application.listObjects().then((objects) => objects
  .filter(({ frontmatter }) => frontmatter.type === "audit-event" && frontmatter.actor_type === "external"));

/** Makes the next file-handle write stop half way and fail, as a crash or a full disk would. */
async function crashNextHandleWrite(root: string) {
  const probe = await openFile(path.join(root, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as { writeFile(data: string, encoding: BufferEncoding): Promise<void> };
  await probe.close();
  const original = prototype.writeFile;
  const spy = vi.spyOn(prototype, "writeFile").mockImplementationOnce(async function (this: unknown, data: string, encoding: BufferEncoding) {
    await original.call(this, data.slice(0, Math.floor(data.length / 2)), encoding);
    throw Object.assign(new Error("Simulated crash mid-write"), { code: "EIO" });
  });
  return spy;
}

describe("version copies are written atomically (#79)", () => {
  it("leaves no truncated copy under a valid name when a version write fails half way", async () => {
    const { root, open } = await vault();
    const { application } = await open();
    const before = application.object(taskId);
    const crash = await crashNextHandleWrite(root);
    // The guarded save first keeps the prior revision as a version copy; that copy's write fails half way.
    await expect(application.updateTask(taskId, { title: "Saved" }, before.contentHash)).rejects.toThrow("Simulated crash");
    expect(crash).toHaveBeenCalled();
    expect(await versionNames(root)).toEqual([]);

    // A restart treats the object as unchanged and never uses a partial copy as its baseline.
    const restarted = await open();
    expect(await restarted.application.recordExternalChanges()).toEqual([]);
    const [name] = await versionNames(root);
    expect(name).toBeDefined();
    expect(await readFile(path.join(folder(root), name!), "utf8")).toBe(await readFile(path.join(root, "tasks/task.md"), "utf8"));
  });

  it("repairs a truncated copy left under a valid name (by an earlier crash) the next time that copy is saved", async () => {
    const { root, open, file } = await vault();
    const { store, application } = await open();
    const content = await readFile(file, "utf8");
    // The copy an earlier, non-atomic write left behind: right name, only half the content.
    const relativePath = await store.keepVersion(application.object(taskId));
    await writeFile(path.join(root, relativePath), content.slice(0, Math.floor(content.length / 2)));

    await application.updateTask(taskId, { title: "Saved" }, application.object(taskId).contentHash);
    expect(await readFile(path.join(root, relativePath), "utf8")).toBe(content);
    expect((await readdir(folder(root))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("restoring a version copy named by an external-edit audit (#79)", () => {
  async function externallyEdited(options?: MarkdownObjectStoreOptions) {
    const setup = await vault(options);
    const { application } = await setup.open();
    await writeFile(setup.file, task("Edited in Obsidian"));
    expect(await application.recordExternalChanges()).toHaveLength(1);
    const [event] = await externalEvents(application);
    return { ...setup, application, event: event! };
  }

  it("restores a kept copy through a guarded write", async () => {
    const { application, event } = await externallyEdited();
    const restored = await application.restoreVersion(event.frontmatter.id);
    expect(restored.frontmatter).toMatchObject({ title: "Original", revision: 2, updated_by_device: "this-mac" });
    expect(application.object(taskId).frontmatter.title).toBe("Original");
  });

  it("explains that a pruned copy is no longer kept, and changes nothing", async () => {
    const { root, application, event } = await externallyEdited({ versionsToKeep: 2 });
    for (let index = 1; index <= 3; index += 1) await application.updateTask(taskId, { title: `Save ${index}` }, application.object(taskId).contentHash);
    const versionPath = String((event.frontmatter.metadata as Record<string, unknown>).version_path);
    expect(await versionNames(root)).not.toContain(path.posix.basename(versionPath));

    const before = application.object(taskId);
    const objectsBefore = (await application.listObjects()).length;
    await expect(application.restoreVersion(event.frontmatter.id)).rejects.toThrow("This version is no longer kept (only the last 10 are)");
    await application.rebuildIndex();
    expect(application.object(taskId).contentHash).toBe(before.contentHash);
    expect((await application.listObjects()).length).toBe(objectsBefore);
  });
});
