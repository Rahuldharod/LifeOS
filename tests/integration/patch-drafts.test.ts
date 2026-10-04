import { access, copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #36 (ADR 0007): an Agent drops a Patch Draft into `_inbox/patches/`; low-risk dictated changes apply, are audited and can be undone.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-patches-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, application };
}

/** Writes an inbox file whose mtime is old enough that adoption does not treat it as still being written. */
async function drop(root: string, folder: "drafts" | "patches", name: string, fields: Record<string, unknown>, body = "") {
  const target = path.join(root, "_inbox", folder, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify(fields).trimEnd()}\n---\n${body}`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}
const patch = (fields: Record<string, unknown>) => ({ lifeos_patch: 1, draft_key: "phone-2026-10-04-1000", origin: "user-dictated", captured_at: "2026-10-04T10:00:00+02:00", ...fields });

const exists = (file: string) => access(file).then(() => true, () => false);
const fileOf = async (root: string, relativePath: string) => {
  const [, yaml, body] = (await readFile(path.join(root, relativePath), "utf8")).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)!;
  return { frontmatter: parse(yaml!) as Record<string, unknown>, body: body! };
};
const audits = (application: LifeOSApplication, action: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action));

describe("applying a user-dictated Patch Draft", () => {
  it("applies task status, priority and due date by ID through a guarded write, audits before/after and files the patch", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    const id = task.frontmatter.id;
    await drop(root, "patches", "done.md", patch({ id, set: { status: "Done", priority: "High", due_on: "2026-10-09" } }));

    const batch = await application.adoptDrafts();
    expect(batch.drafts).toEqual([expect.objectContaining({ draft: "_inbox/patches/done.md", outcome: "applied", objectIds: [id], filedAs: "_inbox/processed/done.md" })]);

    const onDisk = await fileOf(root, task.relativePath);
    expect(onDisk.frontmatter).toMatchObject({ status: "Done", completed_at: "2026-10-04T08:00:00.000Z", priority: "High", due_on: "2026-10-09", revision: 2, origin: "app" });
    expect(await exists(path.join(root, "_inbox/patches/done.md"))).toBe(false);
    expect((await fileOf(root, "_inbox/processed/done.result.md")).frontmatter).toMatchObject({ lifeos_result: 1, outcome: "applied", draft: "_inbox/patches/done.md", draft_key: "phone-2026-10-04-1000", object_ids: [id], errors: [], agent_run_id: batch.agentRunId });

    const [audit] = await audits(application, "patch.applied");
    expect(audit!.frontmatter).toMatchObject({ object_id: id });
    expect(audit!.frontmatter.metadata).toMatchObject({
      draft_key: "phone-2026-10-04-1000", agent_run_id: batch.agentRunId, origin: "user-dictated",
      before: { status: "Inbox", completed_at: null, priority: null, due_on: null },
      after: { status: "Done", completed_at: "2026-10-04T08:00:00.000Z", priority: "High", due_on: "2026-10-09" }
    });
    const run = application.object(batch.agentRunId!);
    expect(run.frontmatter.related_object_ids).toEqual([id]);
    expect(run.frontmatter.output_summary).toMatch(/1 applied/);

    expect(await application.appliedPatches()).toEqual([expect.objectContaining({ auditEventId: audit!.frontmatter.id, objectId: id, title: "Send Joel the sizing deck", draftKey: "phone-2026-10-04-1000", undone: false })]);
  });

  it("finds the target by exact title and type, and appends a body note to any object", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    const client = await application.createEntity("client", { title: "Carrefour" });
    await drop(root, "patches", "a-note.md", patch({ draft_key: "note", title: "carrefour", type: "client", append_note: "Joel prefers the deck in French." }));
    await drop(root, "patches", "b-due.md", patch({ draft_key: "due", title: "Send Joel the sizing deck", type: "task", set: { due_at: "2026-10-09T17:00:00+02:00", due_timezone: "Europe/Paris" } }));

    const batch = await application.adoptDrafts();
    expect(batch.drafts.map((result) => result.outcome)).toEqual(["applied", "applied"]);
    expect((await fileOf(root, client.relativePath)).body).toBe("# Carrefour\n\nJoel prefers the deck in French.\n");
    expect((await fileOf(root, task.relativePath)).frontmatter).toMatchObject({ due_at: "2026-10-09T15:00:00.000Z", due_timezone: "Europe/Paris" });
  });

  it("applies a patch to a task created by a draft in the same batch", async () => {
    const { root, application } = await vault();
    await drop(root, "drafts", "new.md", { lifeos_draft: 1, kind: "task", draft_key: "new", origin: "user-dictated", title: "Book the venue", captured_at: "2026-10-04T09:00:00Z" });
    await drop(root, "patches", "move.md", patch({ title: "Book the venue", type: "task", set: { due_on: "2026-10-10" } }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts.map((result) => result.outcome)).toEqual(["adopted", "applied"]);
    expect(application.object(batch.drafts[0]!.objectIds[0]!).frontmatter.due_on).toBe("2026-10-10");
  });

  it("sets waiting_for only together with Waiting status, and clears it when the task leaves Waiting", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Get budget sign-off");
    const joel = await application.createEntity("person", { title: "Joël Martin" });
    await drop(root, "patches", "orphan.md", patch({ draft_key: "orphan", id: task.frontmatter.id, set: { waiting_for: "Joël Martin" } }));
    const rejected = await application.adoptDrafts();
    expect(rejected.drafts[0]).toMatchObject({ outcome: "failed", filedAs: "_inbox/failed/orphan.md" });
    expect(rejected.drafts[0]!.reason).toMatch(/waiting_for: only with status Waiting/);
    expect(application.object(task.frontmatter.id).frontmatter.revision).toBe(1);

    await drop(root, "patches", "wait.md", patch({ draft_key: "wait", id: task.frontmatter.id, set: { status: "Waiting", waiting_for: "joel martin" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied" });
    expect(application.object(task.frontmatter.id).frontmatter).toMatchObject({ status: "Waiting", waiting_for_person_id: joel.frontmatter.id });

    await drop(root, "patches", "next.md", patch({ draft_key: "next", id: task.frontmatter.id, set: { status: "Next" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied" });
    expect(application.object(task.frontmatter.id).frontmatter.waiting_for_person_id).toBeUndefined();
  });

  it("treats a re-sent identical patch as a no-op and refuses the same key with different content", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Call the bank");
    await drop(root, "patches", "p.md", patch({ id: task.frontmatter.id, set: { priority: "Low" } }));
    await application.adoptDrafts();
    await drop(root, "patches", "p.md", patch({ id: task.frontmatter.id, set: { priority: "Low" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "duplicate", objectIds: [task.frontmatter.id], filedAs: "_inbox/processed/p-2.md" });
    await drop(root, "patches", "q.md", patch({ id: task.frontmatter.id, set: { priority: "High" } }));
    const changed = await application.adoptDrafts();
    expect(changed.drafts[0]!.reason).toMatch(/draft_key phone-2026-10-04-1000 was already applied/);
    expect(application.object(task.frontmatter.id).frontmatter).toMatchObject({ priority: "Low", revision: 2 });
    expect(await audits(application, "patch.applied")).toHaveLength(1);
  });

  it("skips a patch still being written", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Call the bank");
    await drop(root, "patches", "fresh.md", patch({ id: task.frontmatter.id, set: { priority: "Low" } }));
    const batch = await application.adoptDrafts({ now: new Date(Date.now() - 59_000) });
    expect(batch.drafts[0]).toMatchObject({ outcome: "skipped" });
    expect(batch.retrySoon).toBe(true);
    expect((await application.inboxStatus()).awaiting).toBe(1);
  });
});

describe("refusing Patch Drafts", () => {
  it.each([
    ["no-match.md", { title: "Nothing like this", type: "task", set: { status: "Done" } }, /_inbox\/patches\/no-match\.md \(draft_key phone-2026-10-04-1000\): title: no task titled "Nothing like this"/],
    ["ambiguous.md", { title: "Call the bank", type: "task", set: { status: "Done" } }, /title: 2 tasks are titled "Call the bank" \([0-9a-f-]+, [0-9a-f-]+\); give the id instead/],
    ["unknown-id.md", { id: "01890000-0000-7000-8000-000000000000", set: { status: "Done" } }, /id: no object with ID 01890000-0000-7000-8000-000000000000/],
    ["no-target.md", { set: { status: "Done" } }, /id: missing; give the target's id, or its exact title and type/],
    ["nothing.md", { title: "Call the bank", type: "task" }, /set: nothing to change; give set and\/or append_note/],
    ["version.md", { lifeos_patch: 2, title: "Call the bank", type: "task", set: { status: "Done" } }, /lifeos_patch: unsupported contract version 2/],
    ["bad-values.md", { id: "TASK", set: { status: "Finished", priority: "Urgent", due_on: "2026-10-09", due_at: "2026-10-09T10:00:00Z" } }, /status: unknown status "Finished".*priority: unknown priority "Urgent".*due_on: use due_on or due_at, not both/],
    ["title-change.md", { id: "TASK", set: { title: "Renamed" } }, /set\.title: changes to title need review/],
    ["agent.md", { id: "TASK", origin: "agent-extracted", set: { status: "Done" } }, /origin: agent-extracted patches always need review/],
    ["unknown-person.md", { id: "TASK", set: { status: "Waiting", waiting_for: "Nobody" } }, /waiting_for: no person called "Nobody"/]
  ])("fails %s with a specific, path-aware reason and changes nothing", async (name, fields, reason) => {
    const { root, application } = await vault();
    const first = await application.quickCapture("Call the bank");
    await application.quickCapture("Call the bank");
    const resolved = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === "TASK" ? first.frontmatter.id : value]));
    await drop(root, "patches", name, patch(resolved));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "failed", filedAs: `_inbox/failed/${name}` });
    expect(batch.drafts[0]!.reason).toMatch(reason);
    expect(String(((await fileOf(root, `_inbox/failed/${name.replace(/\.md$/, ".result.md")}`)).frontmatter.errors as string[])[0])).toMatch(reason);
    expect((await application.inboxStatus()).failed).toEqual([expect.objectContaining({ path: `_inbox/failed/${name}` })]);
    expect((await application.tasks()).every((task) => task.frontmatter.revision === 1)).toBe(true);
    expect(await audits(application, "patch.applied")).toHaveLength(0);
  });

  it("refuses a target whose ID is claimed by two files", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Call the bank");
    await copyFile(path.join(root, task.relativePath), path.join(root, "tasks", "copy.md"));
    await application.rebuildIndex();
    await drop(root, "patches", "dup.md", patch({ id: task.frontmatter.id, set: { status: "Done" } }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "failed" });
    expect(batch.drafts[0]!.reason).toMatch(new RegExp(`id: ${task.frontmatter.id} is a duplicate object ID`));
    expect((await fileOf(root, task.relativePath)).frontmatter.status).toBe("Inbox");
  });
});

describe("undoing an applied patch", () => {
  async function applied() {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    await drop(root, "patches", "done.md", patch({ id: task.frontmatter.id, set: { status: "Done", priority: "High" }, append_note: "Sent on Friday." }));
    await application.adoptDrafts();
    const [entry] = await application.appliedPatches();
    return { root, application, task, entry: entry! };
  }

  it("restores the before values and body through a guarded write, and audits the undo", async () => {
    const { root, application, task, entry } = await applied();
    expect((await fileOf(root, task.relativePath)).body).toBe("# Send Joel the sizing deck\n\nSent on Friday.\n");

    const restored = await application.undoPatch(entry.auditEventId);
    expect(restored.frontmatter.revision).toBe(3);
    const onDisk = await fileOf(root, task.relativePath);
    expect(onDisk.frontmatter).toMatchObject({ status: "Inbox", revision: 3 });
    expect(onDisk.frontmatter).not.toHaveProperty("completed_at");
    expect(onDisk.frontmatter).not.toHaveProperty("priority");
    expect(onDisk.body).toBe("# Send Joel the sizing deck\n");

    const [undone] = await audits(application, "patch.undone");
    expect(undone!.frontmatter).toMatchObject({ object_id: task.frontmatter.id });
    expect(undone!.frontmatter.metadata).toMatchObject({ patch_audit_id: entry.auditEventId, before: { status: "Done", priority: "High" }, after: { status: "Inbox", priority: null } });
    expect((await application.appliedPatches())[0]).toMatchObject({ undone: true });

    // A second click does nothing.
    expect((await application.undoPatch(entry.auditEventId)).frontmatter.revision).toBe(3);
    expect(await audits(application, "patch.undone")).toHaveLength(1);
  });

  it("refuses to undo over a newer edit to a patched field", async () => {
    const { application, task, entry } = await applied();
    const current = application.object(task.frontmatter.id);
    await application.updateTask(task.frontmatter.id, { priority: "Low", status: "Done" }, current.contentHash);
    await expect(application.undoPatch(entry.auditEventId)).rejects.toThrow(/priority changed since the patch was applied/);
    expect(application.object(task.frontmatter.id).frontmatter.priority).toBe("Low");
    expect(await audits(application, "patch.undone")).toHaveLength(0);
  });

  it("rejects an ID that is not an applied patch", async () => {
    const { application, task } = await applied();
    await expect(application.undoPatch(task.frontmatter.id)).rejects.toThrow(/Not an applied patch/);
  });
});
