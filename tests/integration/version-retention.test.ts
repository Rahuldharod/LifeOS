import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore, type MarkdownObjectStoreOptions } from "@lifeos/object-store-markdown";

// Issue #72 (ADR 0012): one version copy per save, only the last N kept per object, cheap startup checks, multi-device gap.

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const task = (title: string, revision = 1, device = "test") => `---\nid: ${taskId}\ntype: task\nschema_version: 1\nrevision: ${revision}\ntitle: ${title}\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:0${revision}:00Z\nupdated_by_device: ${device}\nstatus: Inbox\nowner_person_id: ${selfId}\n---\n# ${title}\n`;
const self = `---\nid: ${selfId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n`;

async function vault(options?: MarkdownObjectStoreOptions) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-versions-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries({ "people/self.md": self, "tasks/task.md": task("Original") })) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const open = async (deviceId = "this-mac") => {
    const store = new MarkdownObjectStore(root, options);
    const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, deviceId);
    await application.rebuildIndex();
    return { store, application };
  };
  return { root, open, file: path.join(root, "tasks/task.md") };
}

const versions = async (root: string) => (await readdir(path.join(root, ".lifeos", "versions", taskId)).catch(() => [] as string[])).sort();
const revisions = async (root: string) => (await versions(root)).map((name) => Number(name.split("--")[0]));
const save = async (application: LifeOSApplication, times: number) => {
  for (let index = 1; index <= times; index += 1) await application.updateTask(taskId, { title: `Save ${index}` }, application.object(taskId).contentHash);
};

describe("bounded version history (#72)", () => {
  it("keeps only the last N versions of an object saved more than N times, and each kept one restores", async () => {
    const { root, open } = await vault({ versionsToKeep: 3 });
    const { store, application } = await open();
    await save(application, 6);
    expect(await revisions(root)).toEqual([5, 6, 7]);
    expect((await store.latestVersion(taskId))?.frontmatter.title).toBe("Save 6");

    for (const name of await versions(root)) {
      const kept = await store.read(path.posix.join(".lifeos", "versions", taskId, name));
      const current = application.object(taskId);
      await store.write({ relativePath: current.relativePath, expectedHash: current.contentHash, frontmatter: { ...kept.frontmatter, revision: current.frontmatter.revision + 1 }, body: kept.body });
      await application.rebuildIndex();
      expect(application.object(taskId).frontmatter.title).toBe(kept.frontmatter.title);
    }
    expect(await versions(root)).toHaveLength(3);
  });

  it("keeps ten versions per object by default", async () => {
    const { root, open } = await vault();
    const { application } = await open();
    await save(application, 14);
    expect(await revisions(root)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("never prunes the external-edit baseline, even when an older revision is saved after it", async () => {
    const { root, open } = await vault({ versionsToKeep: 2 });
    const { store, application } = await open();
    await save(application, 3);
    const older = { ...application.object(taskId), frontmatter: { ...application.object(taskId).frontmatter, revision: 1, title: "Older copy" } };
    const keptPath = await store.keepVersion({ ...older, contentHash: "0".repeat(64) });
    // The baseline (highest revision) and the copy just kept both survive; the rest are pruned.
    expect(await revisions(root)).toEqual([1, 4]);
    expect(await readFile(path.join(root, keptPath), "utf8")).toContain("title: Older copy");
    expect((await store.latestVersion(taskId))?.frontmatter.title).toBe("Save 3");
  });

  it("keeps the baseline when an external edit is recorded at a small retention, so a restart does not report it again", async () => {
    const { root, open, file } = await vault({ versionsToKeep: 1 });
    const { application } = await open();
    await save(application, 2);
    await writeFile(file, (await readFile(file, "utf8")).replace("title: Save 2", "title: Edited in Obsidian"));
    const [recorded] = await application.recordExternalChanges();
    expect(recorded).toMatchObject({ objectId: taskId, change: "changed" });
    expect(await (await open()).application.recordExternalChanges()).toEqual([]);
    expect((await versions(root)).length).toBeLessThanOrEqual(2);
  });

  it("does not read any version file at startup when nothing changed", async () => {
    const { open, file } = await vault();
    const first = await open();
    await save(first.application, 2);
    // An object whose baseline came from an external edit, not an app write, is cheap to check too.
    await writeFile(file, (await readFile(file, "utf8")).replace("title: Save 2", "title: Edited in Obsidian"));
    expect(await first.application.recordExternalChanges()).toHaveLength(1);

    const reads = vi.spyOn(MarkdownObjectStore.prototype, "read");
    const restarted = await open();
    expect(await restarted.application.recordExternalChanges()).toEqual([]);
    expect(reads.mock.calls.map(([relativePath]) => relativePath).filter((relativePath) => relativePath.startsWith(".lifeos/versions/"))).toEqual([]);
  });
});

describe("another device's write whose version has not synced yet (#72)", () => {
  const otherMacWrite = task("From the other Mac", 2, "other-mac");
  const versionOf = (content: string, revision: number) => path.join(".lifeos", "versions", taskId, `${String(revision).padStart(6, "0")}--${createHash("sha256").update(content).digest("hex").slice(0, 12)}.md`);
  const versionArrives = async (root: string) => {
    const target = path.join(root, versionOf(otherMacWrite, 2));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, otherMacWrite);
  };

  it("records an Obsidian edit on top of it as external once the version arrives", async () => {
    const { root, open, file } = await vault();
    const { application } = await open();
    expect(await application.recordExternalChanges()).toEqual([]);
    await writeFile(file, otherMacWrite.replace("title: From the other Mac", "title: Then edited in Obsidian"));
    expect(await application.recordExternalChanges()).toEqual([]);
    expect(await application.recordExternalChanges()).toEqual([]); // a later pass, still before the version arrives
    expect(await revisions(root)).not.toContain(2); // the edited file is not taken as the baseline

    await versionArrives(root);
    const [recorded, ...rest] = await application.recordExternalChanges();
    expect(rest).toEqual([]);
    expect(recorded).toMatchObject({ objectId: taskId, change: "changed" });
    expect(await readFile(path.join(root, recorded!.versionPath!), "utf8")).toContain("title: From the other Mac");
    expect(await application.recordExternalChanges()).toEqual([]);
  });

  it("records it across a restart too", async () => {
    const { root, open, file } = await vault();
    expect(await (await open()).application.recordExternalChanges()).toEqual([]);
    await writeFile(file, otherMacWrite.replace("title: From the other Mac", "title: Then edited in Obsidian"));
    expect(await (await open()).application.recordExternalChanges()).toEqual([]);
    await versionArrives(root);
    expect(await (await open()).application.recordExternalChanges()).toEqual([expect.objectContaining({ objectId: taskId, change: "changed" })]);
  });

  it("accepts it without an event when the version arrives unchanged", async () => {
    const { root, open, file } = await vault();
    const { application } = await open();
    expect(await application.recordExternalChanges()).toEqual([]);
    await writeFile(file, otherMacWrite);
    expect(await application.recordExternalChanges()).toEqual([]);
    await versionArrives(root);
    expect(await application.recordExternalChanges()).toEqual([]);
  });

  it("takes this device's own unversioned write (stopped before its version was saved) as the baseline", async () => {
    const { root, open, file } = await vault();
    const { application } = await open();
    expect(await application.recordExternalChanges()).toEqual([]);
    await writeFile(file, task("Saved here", 2, "this-mac"));
    expect(await application.recordExternalChanges()).toEqual([]);
    expect(await revisions(root)).toContain(2);
  });
});
