import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { validateFrontmatter } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #29 (U4, U5): a change made outside the app keeps the last-known copy in the versions store and is audited as `external`.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const task = (title: string, extra = "") => `---\nid: ${taskId}\ntype: task\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\nstatus: Inbox\nowner_person_id: ${selfId}\n---\n# ${title}\n${extra}`;
const self = `---\nid: ${selfId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n`;

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-external-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries({ "people/self.md": self, "tasks/task.md": task("Original") })) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "this-mac");
  await application.rebuildIndex();
  return { root, store, application, file: path.join(root, "tasks/task.md") };
}

const externalEvents = (application: LifeOSApplication) => application.listObjects().then((objects) => objects
  .filter(({ frontmatter }) => frontmatter.type === "audit-event" && frontmatter.actor_type === "external"));
const versions = (root: string, id = taskId) => readdir(path.join(root, ".lifeos", "versions", id)).catch(() => [] as string[]);

describe("external edits", () => {
  it("accepts external as an audit actor type", () => {
    expect(() => validateFrontmatter({ id: taskId, type: "audit-event", schema_version: 1, revision: 1, title: "x", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", updated_by_device: "d", occurred_at: "2026-10-01T08:00:00Z", actor_type: "external", action: "object.changed-externally" })).not.toThrow();
  });

  it("keeps the last-known copy and writes an external audit event", async () => {
    const { root, application, file } = await vault();
    const before = application.object(taskId);
    await writeFile(file, task("Edited in Obsidian"));
    const recorded = await application.recordExternalChanges();
    expect(recorded).toEqual([expect.objectContaining({ objectId: taskId, change: "changed" })]);
    expect(application.object(taskId).frontmatter.title).toBe("Edited in Obsidian");

    const [event] = await externalEvents(application);
    expect(event?.frontmatter).toMatchObject({ action: "object.changed-externally", object_id: taskId, actor_type: "external" });
    const metadata = (event?.frontmatter as { metadata?: Record<string, unknown> }).metadata;
    expect(metadata).toMatchObject({ relative_path: "tasks/task.md", previous_hash: before.contentHash, current_hash: application.object(taskId).contentHash });
    // #69: the store keeps the last-known copy and the edited one (the new baseline, so a restart does not report it again).
    expect(await versions(root)).toHaveLength(2);
    expect(metadata?.version_path).toMatch(new RegExp(`^\\.lifeos/versions/${taskId}/000001--`));
    expect(await readFile(path.join(root, String(metadata?.version_path)), "utf8")).toContain("title: Original");
  });

  it("records nothing for the app's own writes, even when the watcher fires late", async () => {
    const { root, application } = await vault();
    await application.updateTask(taskId, { status: "Next" }, application.object(taskId).contentHash);
    await application.createEntity("project", { title: "New project" });
    expect(await application.recordExternalChanges()).toEqual([]);
    // A second watcher callback for the same writes is still not external.
    expect(await application.recordExternalChanges()).toEqual([]);
    expect(await externalEvents(application)).toEqual([]);
    expect(await versions(root)).toHaveLength(2); // the guarded write's prior version and the revision it wrote (#69)
  });

  it("records nothing when nothing changed, and nothing for a file created outside the app", async () => {
    const { root, application } = await vault();
    expect(await application.recordExternalChanges()).toEqual([]);
    await writeFile(path.join(root, "tasks/other.md"), task("Other").replace(taskId, "01995d60-7baf-7c21-9c96-9c5d2f6a32ad"));
    expect(await application.recordExternalChanges()).toEqual([]);
    expect(application.object("01995d60-7baf-7c21-9c96-9c5d2f6a32ad").frontmatter.title).toBe("Other");
  });

  it("lets the user restore the prior version through the versions store", async () => {
    const { store, application, file } = await vault();
    await writeFile(file, task("Edited by an agent", "Agent text\n"));
    const [recorded] = await application.recordExternalChanges();
    const prior = await store.read(recorded!.versionPath!);
    expect(prior.frontmatter.title).toBe("Original");

    const current = application.object(taskId);
    await store.write({ relativePath: current.relativePath, expectedHash: current.contentHash, frontmatter: { ...prior.frontmatter, revision: current.frontmatter.revision + 1 }, body: prior.body });
    await application.rebuildIndex();
    expect(application.object(taskId)).toMatchObject({ frontmatter: { title: "Original" }, body: "# Original\n" });
    // The restore was the app's own write: not external.
    expect(await application.recordExternalChanges()).toEqual([]);
  });

  it("records one event for a burst the watcher observes once, and does not double-record overlapping calls", async () => {
    const { root, application, file } = await vault();
    for (let save = 1; save <= 5; save += 1) await writeFile(file, task(`Save ${save}`));
    const [first, second] = await Promise.all([application.recordExternalChanges(), application.recordExternalChanges()]);
    expect([...first, ...second]).toHaveLength(1);
    expect(await externalEvents(application)).toHaveLength(1);
    expect(await versions(root)).toHaveLength(2); // last-known copy and the new baseline (#69)

    // A later observed edit is a new event against the new last-known version.
    await writeFile(file, task("Save 6"));
    expect(await application.recordExternalChanges()).toHaveLength(1);
    expect(await externalEvents(application)).toHaveLength(2);
  });

  it("does not crash on delete and keeps the last-known copy", async () => {
    const { root, application, file } = await vault();
    await unlink(file);
    const recorded = await application.recordExternalChanges();
    expect(recorded).toEqual([expect.objectContaining({ objectId: taskId, change: "deleted" })]);
    expect(() => application.object(taskId)).toThrow(/not found/);
    expect(await versions(root)).toHaveLength(1);
    expect((await externalEvents(application))[0]?.frontmatter).toMatchObject({ action: "object.deleted-externally", object_id: taskId });
    expect(await application.recordExternalChanges()).toEqual([]);
  });

  it("does not flag an app write that overlaps a detection pass", async () => {
    const { store, application } = await vault();
    // The file is on disk but the app's write has not returned yet when the watcher pass scans.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const write = store.write.bind(store);
    store.write = async (input) => { const written = await write(input); await held; return written; };
    const update = application.updateTask(taskId, { status: "Next" }, application.object(taskId).contentHash);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recorded = await application.recordExternalChanges();
    release();
    await update;
    expect(recorded).toEqual([]);
    expect(await application.recordExternalChanges()).toEqual([]);
    expect(await externalEvents(application)).toEqual([]);
  });

  it("keeps the last-known copy when an external edit breaks the file", async () => {
    const { root, application, file } = await vault();
    await writeFile(file, "---\nid: [unclosed\n---\n");
    expect(await application.recordExternalChanges()).toEqual([expect.objectContaining({ objectId: taskId, change: "unreadable" })]);
    expect(await versions(root)).toHaveLength(1);
    expect((await externalEvents(application))[0]?.frontmatter).toMatchObject({ action: "object.made-unreadable-externally" });
  });

  it("treats another device's synced app write as not external", async () => {
    const { application, file } = await vault();
    await writeFile(file, task("From the other Mac").replace("revision: 1", "revision: 2").replace("updated_by_device: test", "updated_by_device: other-mac"));
    expect(await application.recordExternalChanges()).toEqual([]);
    expect(application.object(taskId).frontmatter.title).toBe("From the other Mac");
  });
});

// Issue #69: the last-known state survives a restart (it lives in the versions store), so edits made while the app was closed are caught.
describe("external edits across restarts and sync", () => {
  const reopen = async (root: string, deviceId = "this-mac") => {
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, deviceId);
    await application.rebuildIndex();
    return application;
  };

  it("records an edit made while the app was closed and keeps the previous version", async () => {
    const { root, application, file } = await vault();
    expect(await application.recordExternalChanges()).toEqual([]); // first start: records the baseline
    await writeFile(file, task("Edited while closed"));

    const restarted = await reopen(root);
    const recorded = await restarted.recordExternalChanges();
    expect(recorded).toEqual([expect.objectContaining({ objectId: taskId, change: "changed", relativePath: "tasks/task.md" })]);
    expect(await readFile(path.join(root, recorded[0]!.versionPath!), "utf8")).toContain("title: Original");
    expect((await externalEvents(restarted))[0]?.frontmatter).toMatchObject({ action: "object.changed-externally", object_id: taskId });
    // Recorded once: a further restart does not report it again.
    expect(await (await reopen(root)).recordExternalChanges()).toEqual([]);
  });

  it("records an offline edit to an object the app wrote last", async () => {
    const { root, application, file } = await vault();
    await application.updateTask(taskId, { title: "Saved in the app" }, application.object(taskId).contentHash);
    await writeFile(file, (await readFile(file, "utf8")).replace("title: Saved in the app", "title: Edited while closed"));

    const restarted = await reopen(root);
    const [recorded] = await restarted.recordExternalChanges();
    expect(recorded).toMatchObject({ objectId: taskId, change: "changed" });
    expect(await readFile(path.join(root, recorded!.versionPath!), "utf8")).toContain("title: Saved in the app");
  });

  it("never reports the app's own writes after a restart", async () => {
    const { root, application } = await vault();
    await application.updateTask(taskId, { status: "Next" }, application.object(taskId).contentHash);
    await application.createEntity("project", { title: "New project" });
    const restarted = await reopen(root);
    expect(await restarted.recordExternalChanges()).toEqual([]);
    expect(await externalEvents(restarted)).toEqual([]);
  });

  it("handles another device's sync followed by an Obsidian edit before the next pass", async () => {
    const { root, application, file } = await vault();
    expect(await application.recordExternalChanges()).toEqual([]);
    const otherMac = await reopen(root, "other-mac");
    await otherMac.updateTask(taskId, { title: "From the other Mac" }, otherMac.object(taskId).contentHash);
    await writeFile(file, (await readFile(file, "utf8")).replace("title: From the other Mac", "title: Then edited in Obsidian"));

    const [recorded, ...rest] = await application.recordExternalChanges();
    expect(rest).toEqual([]);
    expect(recorded).toMatchObject({ objectId: taskId, change: "changed" });
    // The previous version is the other device's write, not this device's older baseline.
    expect(await readFile(path.join(root, recorded!.versionPath!), "utf8")).toContain("title: From the other Mac");
    expect(application.object(taskId).frontmatter.title).toBe("Then edited in Obsidian");
  });

  it("accepts another device's sync, then catches an Obsidian edit in a later pass", async () => {
    const { root, application, file } = await vault();
    expect(await application.recordExternalChanges()).toEqual([]);
    const otherMac = await reopen(root, "other-mac");
    await otherMac.updateTask(taskId, { title: "From the other Mac" }, otherMac.object(taskId).contentHash);
    expect(await application.recordExternalChanges()).toEqual([]);

    await writeFile(file, (await readFile(file, "utf8")).replace("title: From the other Mac", "title: Then edited in Obsidian"));
    expect(await application.recordExternalChanges()).toEqual([expect.objectContaining({ objectId: taskId, change: "changed" })]);
  });

  it("catches an edit that reverts to an earlier recorded version", async () => {
    const { application, file } = await vault();
    const original = task("Original");
    await writeFile(file, task("Edited"));
    expect(await application.recordExternalChanges()).toHaveLength(1);
    await writeFile(file, original);
    expect(await application.recordExternalChanges()).toEqual([expect.objectContaining({ objectId: taskId, change: "changed" })]);
  });

  it("does not treat front-matter key order or YAML formatting as an external edit, live or after a restart", async () => {
    const { root, application, file } = await vault();
    expect(await application.recordExternalChanges()).toEqual([]);
    const reordered = `---\ntitle: "Original"\nstatus: 'Inbox'\nid: ${taskId}\nowner_person_id: ${selfId}\ntype: task\nrevision: 1\nschema_version: 1\nupdated_by_device: "test"\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at:   2026-10-01T08:00:00Z\n---\n# Original\n`;
    await writeFile(file, reordered);
    expect(await application.recordExternalChanges()).toEqual([]);

    await application.updateTask(taskId, { status: "Next" }, application.object(taskId).contentHash);
    const saved = await readFile(file, "utf8");
    const lines = saved.split("\n");
    const end = lines.indexOf("---", 1);
    await writeFile(file, ["---", ...lines.slice(1, end).reverse(), ...lines.slice(end)].join("\n"));
    const restarted = await reopen(root);
    expect(await restarted.recordExternalChanges()).toEqual([]);
    expect(await externalEvents(restarted)).toEqual([]);
  });
});
