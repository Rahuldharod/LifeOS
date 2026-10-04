import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #31 (ADR 0007): an Agent drops a dictated task draft into `_inbox/drafts/`; adoption turns it into an Inbox task.

const roots: string[] = [];
/** Snapshots are made read-only; restore write access so the temp root can be removed. */
async function makeWritable(target: string) {
  await chmod(target, 0o755).catch(() => undefined);
  for (const entry of await readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeWritable(path.join(target, entry.name));
    else await chmod(path.join(target, entry.name), 0o644).catch(() => undefined);
  }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => { await makeWritable(root); await rm(root, { recursive: true, force: true }); })); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-adoption-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, application };
}

/** Writes a draft whose mtime is old enough that adoption does not treat it as still being written. */
async function dropDraft(root: string, name: string, content: string, ageSeconds = 60) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const past = new Date(Date.now() - ageSeconds * 1000);
  await utimes(target, past, past);
}

const draft = (fields: Record<string, string | number>, body = "Joel asked for the sizing deck before Friday.\n") =>
  `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n${body}`;
const dictatedTask = (overrides: Record<string, string | number> = {}) => draft({ lifeos_draft: 1, kind: "task", draft_key: "phone-2026-10-04-0915", origin: "user-dictated", title: "Send Joel the sizing deck", captured_at: "2026-10-04T09:15:00+02:00", ...overrides });

const exists = (file: string) => access(file).then(() => true, () => false);
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const ofType = (application: LifeOSApplication, type: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === type));

describe("adopting a dictated task Inbox Draft", () => {
  it("creates the data-root folders and keeps _inbox/ and _agent/ out of the object scan", async () => {
    const { root, application } = await vault();
    await application.adoptDrafts();
    for (const folder of ["_inbox/drafts", "_inbox/patches", "_inbox/requests", "_inbox/processed", "_inbox/failed", "_agent"]) expect(await exists(path.join(root, folder))).toBe(true);

    await writeFile(path.join(root, "_agent", "index.md"), "not an object\n");
    await writeFile(path.join(root, "_inbox", "requests", "work-order.md"), "---\nkind: enrichment\n---\n");
    await application.rebuildIndex();
    const health = await application.health();
    expect(health.diagnostics).toEqual([]);
    expect(health.objectCount).toBe(0);
  });

  it("adopts a valid user-dictated task as an Inbox task with a full envelope, then files the draft", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "sizing-deck.md", dictatedTask({ priority: "High", due_on: "2026-10-09", expected_output: "Deck sent by email" }));

    const batch = await application.adoptDrafts();
    expect(batch.drafts).toHaveLength(1);
    const [result] = batch.drafts;
    expect(result).toMatchObject({ draft: "_inbox/drafts/sizing-deck.md", outcome: "adopted", filedAs: "_inbox/processed/sizing-deck.md" });

    const [task] = await ofType(application, "task");
    const self = (await ofType(application, "person")).find((person) => person.frontmatter.is_self === true);
    expect(task).toBeDefined();
    expect(result!.objectIds).toEqual([task!.frontmatter.id]);
    expect(task!.frontmatter.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(task!.relativePath).toMatch(new RegExp(`^tasks/\\d{4}-\\d{2}-\\d{2}-\\d{4}-send-joel-the-sizing-deck--${task!.frontmatter.id}\\.md$`));
    expect(task!.frontmatter).toMatchObject({
      type: "task", schema_version: 1, revision: 1, title: "Send Joel the sizing deck", updated_by_device: "test",
      status: "Inbox", owner_person_id: self!.frontmatter.id, origin: "user-dictated", captured_at: "2026-10-04T07:15:00.000Z",
      priority: "High", due_on: "2026-10-09", expected_output: "Deck sent by email", source_ids: []
    });
    expect(application.object(task!.frontmatter.id).body).toContain("Joel asked for the sizing deck before Friday.");

    expect(await exists(path.join(root, "_inbox/drafts/sizing-deck.md"))).toBe(false);
    expect(await exists(path.join(root, "_inbox/processed/sizing-deck.md"))).toBe(true);
    const sidecar = await frontmatterOf(path.join(root, "_inbox/processed/sizing-deck.result.md"));
    expect(sidecar).toMatchObject({ outcome: "adopted", draft_key: "phone-2026-10-04-0915", object_ids: [task!.frontmatter.id] });

    const runs = await ofType(application, "agent-run");
    expect(runs).toHaveLength(1);
    expect(batch.agentRunId).toBe(runs[0]!.frontmatter.id);
    const audits = (await ofType(application, "audit-event")).filter((audit) => audit.frontmatter.object_id === task!.frontmatter.id);
    expect(audits).toHaveLength(1);
    expect((await application.inboxStatus()).awaiting).toBe(0);
  });

  it("treats a re-sent identical draft as a no-op that points at the original object", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "sizing-deck.md", dictatedTask());
    const first = await application.adoptDrafts();
    const originalId = first.drafts[0]!.objectIds[0];

    await dropDraft(root, "sizing-deck.md", dictatedTask());
    const again = await application.adoptDrafts();
    expect(again.drafts[0]).toMatchObject({ outcome: "duplicate", objectIds: [originalId], filedAs: "_inbox/processed/sizing-deck-2.md" });
    expect(await ofType(application, "task")).toHaveLength(1);
    expect(await frontmatterOf(path.join(root, "_inbox/processed/sizing-deck-2.result.md"))).toMatchObject({ outcome: "duplicate", object_ids: [originalId] });
    expect(await exists(path.join(root, "_inbox/processed/sizing-deck.md"))).toBe(true);

    // Same key, different content: refused rather than silently creating a second task.
    await dropDraft(root, "changed.md", dictatedTask({ title: "Send Joel a different deck" }));
    const changed = await application.adoptDrafts();
    expect(changed.drafts[0]).toMatchObject({ outcome: "failed" });
    expect(changed.drafts[0]!.reason).toMatch(/draft_key phone-2026-10-04-0915 was already adopted/);
    expect(await ofType(application, "task")).toHaveLength(1);
  });

  it("recognises a re-sent draft after a restart, from the audit trail", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "sizing-deck.md", dictatedTask());
    const originalId = (await application.adoptDrafts()).drafts[0]!.objectIds[0];
    await rm(path.join(root, "_inbox/processed"), { recursive: true });

    const restarted = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
    await dropDraft(root, "sizing-deck.md", dictatedTask());
    expect((await restarted.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "duplicate", objectIds: [originalId] });
    expect(await ofType(restarted, "task")).toHaveLength(1);
  });

  it("skips a draft that is still being written and adopts it on a later trigger", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "fresh.md", dictatedTask(), 0);
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "skipped" });
    expect(batch.retrySoon).toBe(true);
    expect(batch.agentRunId).toBeUndefined();
    expect(await ofType(application, "task")).toHaveLength(0);
    expect((await application.inboxStatus()).awaiting).toBe(1);

    const later = await application.adoptDrafts({ now: new Date(Date.now() + 5000) });
    expect(later.drafts[0]).toMatchObject({ outcome: "adopted" });
    expect(await ofType(application, "task")).toHaveLength(1);
  });

  it.each([
    ["unknown-kind.md", dictatedTask({ kind: "spaceship" }), /_inbox\/drafts\/unknown-kind\.md \(draft_key phone-2026-10-04-0915\): kind: unknown kind "spaceship"/],
    ["no-key.md", draft({ lifeos_draft: 1, kind: "task", origin: "user-dictated", title: "No key", captured_at: "2026-10-04T09:15:00Z" }), /_inbox\/drafts\/no-key\.md: draft_key: missing/],
    ["version-two.md", dictatedTask({ lifeos_draft: 2 }), /_inbox\/drafts\/version-two\.md \(draft_key phone-2026-10-04-0915\): lifeos_draft: unsupported contract version 2/],
    ["bad-time.md", dictatedTask({ captured_at: "yesterday" }), /captured_at: not an ISO 8601 date-time/]
  ])("fails %s with a specific, path-aware reason and keeps the file", async (name, content, reason) => {
    const { root, application } = await vault();
    await dropDraft(root, name, content);
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "failed", filedAs: `_inbox/failed/${name}` });
    expect(batch.drafts[0]!.reason).toMatch(reason);
    expect(await readFile(path.join(root, "_inbox/failed", name), "utf8")).toBe(content);
    const sidecar = await frontmatterOf(path.join(root, "_inbox/failed", name.replace(/\.md$/, ".result.md")));
    expect(sidecar.outcome).toBe("failed");
    expect(String((sidecar.errors as string[])[0])).toMatch(reason);

    expect((await application.inboxStatus()).failed).toEqual([expect.objectContaining({ path: `_inbox/failed/${name}`, reason: expect.stringMatching(reason) })]);
    expect((await application.health()).diagnostics.some((diagnostic) => diagnostic.startsWith(`_inbox/failed/${name}: `) && reason.test(diagnostic))).toBe(true);
    expect(await ofType(application, "task")).toHaveLength(0);
    expect(await ofType(application, "agent-run")).toHaveLength(1);

    // Failed drafts are never deleted or retried automatically.
    await application.adoptDrafts();
    expect(await exists(path.join(root, "_inbox/failed", name))).toBe(true);
  });

  it("gives unreadable YAML one more trigger (it may be a partial sync), then fails it", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "broken.md", "---\nlifeos_draft: 1\nkind: [task\n---\nbody\n");
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "skipped" });
    const second = await application.adoptDrafts();
    expect(second.drafts[0]).toMatchObject({ outcome: "failed" });
    expect(second.drafts[0]!.reason).toMatch(/^_inbox\/drafts\/broken\.md: unreadable YAML front matter/);
    expect(await exists(path.join(root, "_inbox/failed/broken.result.md"))).toBe(true);
  });

  it("records one agent-run per batch and one audit-event per created object", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "a.md", dictatedTask({ draft_key: "a", title: "First" }));
    await dropDraft(root, "b.md", dictatedTask({ draft_key: "b", title: "Second" }));
    await dropDraft(root, "c.md", dictatedTask({ draft_key: "c", kind: "unknown" }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts.map((entry) => entry.outcome).sort()).toEqual(["adopted", "adopted", "failed"]);
    const runs = await ofType(application, "agent-run");
    expect(runs).toHaveLength(1);
    const taskIds = (await ofType(application, "task")).map((task) => task.frontmatter.id);
    expect(taskIds).toHaveLength(2);
    expect(runs[0]!.frontmatter.related_object_ids).toEqual(expect.arrayContaining(taskIds));
    const adoptionAudits = (await ofType(application, "audit-event")).filter((audit) => audit.frontmatter.action === "draft.adopted");
    expect(adoptionAudits.map((audit) => audit.frontmatter.object_id).sort()).toEqual([...taskIds].sort());
  });

  it("still lets Quick Capture create an Inbox task directly", async () => {
    const { application } = await vault();
    const task = await application.quickCapture("Call the bank");
    expect(task.frontmatter).toMatchObject({ type: "task", status: "Inbox" });
    expect(task.relativePath.startsWith("tasks/")).toBe(true);
  });

  it("backs up _inbox/ and leaves out _agent/", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "pending.md", dictatedTask(), 0);
    await application.adoptDrafts();
    await writeFile(path.join(root, "_agent", "index.md"), "derived\n");
    const backupRoot = await mkdtemp(path.join(tmpdir(), "lifeos-adoption-backups-"));
    roots.push(backupRoot);
    const backups = new FilesystemBackupService(root, backupRoot);
    const created = await backups.create();
    const manifest = JSON.parse(await readFile(path.join(backupRoot, created.backupId, "manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    const paths = manifest.files.map((entry) => entry.path);
    expect(paths).toContain("_inbox/drafts/pending.md");
    expect(paths.some((entry) => entry.startsWith("_agent/"))).toBe(false);
    expect(await readdir(path.join(root, "_agent"))).toContain("index.md");
  });
});
