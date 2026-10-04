import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication, type AdoptionBatch, type InboxStore, type ObjectStore } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #32: drafts are adopted automatically when they land (watcher trigger, debounced, plus a safety sweep),
// half-written files are never adopted, re-sends never duplicate, and a crashed batch is completed on restart.

const roots: string[] = [];
const triggers: Array<{ stop(): void; runNow(): Promise<unknown> }> = [];
afterEach(async () => {
  // After stop(), runNow() queues behind any batch still in flight and does nothing, so awaiting it drains the queue.
  for (const trigger of triggers.splice(0)) { trigger.stop(); await trigger.runNow(); }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A store that "crashes" (throws) the first time `when` matches, as if the process died at that point. */
function crashing<T extends object>(target: T, method: keyof T, when: (...args: never[]) => boolean): T {
  let crashed = false;
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: never[]) => {
        if (property === method && !crashed && when(...args)) { crashed = true; return Promise.reject(new Error(`simulated crash in ${String(property)}`)); }
        return (value as (...input: never[]) => unknown).apply(object, args);
      };
    }
  });
}

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-auto-adopt-"));
  roots.push(root);
  return { root, application: await open(root) };
}
async function open(root: string, objects: ObjectStore = new MarkdownObjectStore(root), inbox: InboxStore = new FilesystemInboxStore(root)) {
  const application = new LifeOSApplication(objects, new MemoryIndex(), undefined, undefined, "test", inbox);
  await application.rebuildIndex();
  return application;
}

async function dropDraft(root: string, name: string, content: string, ageSeconds = 60) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const past = new Date(Date.now() - ageSeconds * 1000);
  await utimes(target, past, past);
}
const dictatedTask = (key = "phone-0915", title = "Send Joel the sizing deck") =>
  `---\nlifeos_draft: 1\nkind: task\ndraft_key: ${key}\norigin: user-dictated\ntitle: ${title}\ncaptured_at: 2026-10-04T09:15:00+02:00\n---\nJoel asked for the deck.\n`;

const exists = (file: string) => access(file).then(() => true, () => false);
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const ofType = (application: LifeOSApplication, type: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === type));
const adoptionAudits = (application: LifeOSApplication) => ofType(application, "audit-event").then((audits) => audits.filter((audit) => audit.frontmatter.action === "draft.adopted"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeoutMs = 4000) {
  const started = Date.now();
  while (!await check()) { if (Date.now() - started > timeoutMs) throw new Error("timed out"); await pause(20); }
}

describe("automatic adoption trigger", () => {
  it("adopts a draft shortly after it lands, with one debounced batch for a burst of watcher events", async () => {
    const { root, application } = await vault();
    const batches: AdoptionBatch[] = [];
    const trigger = application.startAutoAdoption({ debounceMs: 80, sweepMs: 60_000, onBatch: (batch) => batches.push(batch) });
    triggers.push(trigger);

    await dropDraft(root, "a.md", dictatedTask("a", "First"));
    await dropDraft(root, "b.md", dictatedTask("b", "Second"));
    // #55: one synchronous burst; pauses between events let a slow machine outrun the debounce and split the batch.
    for (let event = 0; event < 5; event += 1) trigger.notify();
    await until(async () => batches.length > 0);
    expect(await ofType(application, "task")).toHaveLength(2);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.drafts.map((draft) => draft.outcome)).toEqual(["adopted", "adopted"]);
  });

  it("skips a draft modified less than 2 seconds ago, then retries on its own and adopts it", async () => {
    const { root, application } = await vault();
    const batches: AdoptionBatch[] = [];
    const trigger = application.startAutoAdoption({ debounceMs: 50, retryMs: 300, sweepMs: 60_000, onBatch: (batch) => batches.push(batch) });
    triggers.push(trigger);
    await dropDraft(root, "fresh.md", dictatedTask(), 1.9);
    trigger.notify();
    await until(async () => batches.some((batch) => batch.drafts[0]?.outcome === "adopted"));
    expect(batches[0]!.drafts[0]).toMatchObject({ outcome: "skipped" });
    expect(batches.at(-1)!.drafts[0]).toMatchObject({ outcome: "adopted" });
    expect(await ofType(application, "task")).toHaveLength(1);
  });

  it("catches drafts with no watcher event at all, through the periodic sweep (unreliable Drive events)", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "silent.md", dictatedTask());
    triggers.push(application.startAutoAdoption({ debounceMs: 50, sweepMs: 100 }));
    await until(async () => (await ofType(application, "task")).length === 1);
    expect(await exists(path.join(root, "_inbox/processed/silent.result.md"))).toBe(true);
  });

  it("adopts nothing while this device may not write (another device holds the lease)", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "held.md", dictatedTask());
    const trigger = application.startAutoAdoption({ debounceMs: 20, sweepMs: 50, canWrite: () => false });
    triggers.push(trigger);
    trigger.notify();
    await pause(200);
    expect(await ofType(application, "task")).toHaveLength(0);
    expect(await exists(path.join(root, "_inbox/drafts/held.md"))).toBe(true);
  });

  it("runs the startup batch on demand and stops cleanly", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "boot.md", dictatedTask());
    const trigger = application.startAutoAdoption({ debounceMs: 20, sweepMs: 50 });
    const batch = await trigger.runNow();
    expect(batch?.drafts[0]).toMatchObject({ outcome: "adopted" });
    trigger.stop();
    // stop() prevents new batches; one the sweep had already started may still finish.
    await pause(150);
    await dropDraft(root, "after-stop.md", dictatedTask("other", "Other"));
    trigger.notify();
    await pause(200);
    expect(await ofType(application, "task")).toHaveLength(1);
  });
});

describe("re-sent drafts", () => {
  it("files an identical re-send as a no-op whose .result.md points to the original result", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "deck.md", dictatedTask());
    const first = await application.adoptDrafts();
    await dropDraft(root, "deck-again.md", dictatedTask());
    const again = await application.adoptDrafts();
    expect(again.drafts[0]).toMatchObject({ outcome: "duplicate", objectIds: first.drafts[0]!.objectIds });
    const sidecar = await frontmatterOf(path.join(root, "_inbox/processed/deck-again.result.md"));
    expect(sidecar).toMatchObject({ outcome: "duplicate", object_ids: first.drafts[0]!.objectIds, original_result: "_inbox/processed/deck.result.md", original_agent_run_id: first.agentRunId });
    expect(await readFile(path.join(root, "_inbox/processed/deck-again.result.md"), "utf8")).toContain("_inbox/processed/deck.result.md");
    expect(await ofType(application, "task")).toHaveLength(1);
  });

  it("still points at the original agent-run when the original sidecar is gone", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "deck.md", dictatedTask());
    const first = await application.adoptDrafts();
    await rm(path.join(root, "_inbox/processed"), { recursive: true });
    await dropDraft(root, "deck.md", dictatedTask());
    await application.adoptDrafts();
    const sidecar = await frontmatterOf(path.join(root, "_inbox/processed/deck.result.md"));
    expect(sidecar).toMatchObject({ outcome: "duplicate", original_agent_run_id: first.agentRunId });
    expect(sidecar.original_result).toBeUndefined();
  });

  it("fails the same draft_key with different content with a clear idempotency-conflict reason", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "deck.md", dictatedTask());
    await application.adoptDrafts();
    await dropDraft(root, "changed.md", dictatedTask("phone-0915", "A different deck"));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "failed", filedAs: "_inbox/failed/changed.md" });
    expect(batch.drafts[0]!.reason).toMatch(/idempotency conflict/);
    expect(batch.drafts[0]!.reason).toMatch(/draft_key phone-0915 was already adopted from different content/);
    expect(await ofType(application, "task")).toHaveLength(1);
  });
});

describe("startup recovery of an interrupted adoption batch", () => {
  const isType = (type: string) => (input: { frontmatter: { type: string } }) => input.frontmatter.type === type;

  async function expectCompleted(root: string, application: LifeOSApplication) {
    const tasks = await ofType(application, "task");
    expect(tasks).toHaveLength(1);
    expect((await adoptionAudits(application)).map((audit) => audit.frontmatter.object_id)).toEqual([tasks[0]!.frontmatter.id]);
    expect(await readdir(path.join(root, "_inbox/drafts"))).toEqual([]);
    const sidecar = await frontmatterOf(path.join(root, "_inbox/processed/deck.result.md"));
    expect(sidecar).toMatchObject({ outcome: "adopted", object_ids: [tasks[0]!.frontmatter.id] });
    const runs = await ofType(application, "agent-run");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.frontmatter.related_object_ids).toEqual([tasks[0]!.frontmatter.id]);
    expect(await readdir(path.join(root, "_inbox/processed"))).toEqual(["deck.md", "deck.result.md"]);
    return tasks[0]!;
  }

  it.each([
    ["after the object was written, before its audit", "objects", isType("audit-event")],
    ["after the audit, before the draft was moved", "inbox:move", () => true],
    ["after the draft was moved, before its .result.md", "inbox:writeDocument", () => true],
    ["before the batch agent-run was written", "objects", isType("agent-run")]
  ] as const)("completes a batch that crashed %s, with no duplicates", async (label, where, when) => {
    const { root } = await vault();
    await dropDraft(root, "deck.md", dictatedTask());
    const objects = where === "objects" ? crashing(new MarkdownObjectStore(root), "write", when as never) : new MarkdownObjectStore(root);
    const inbox = where.startsWith("inbox:") ? crashing(new FilesystemInboxStore(root), where.slice(6) as keyof FilesystemInboxStore, when as never) : new FilesystemInboxStore(root);
    const crashed = await open(root, objects, inbox);
    await expect(crashed.adoptDrafts()).rejects.toThrow(/simulated crash/);

    const restarted = await open(root);
    const batch = await restarted.adoptDrafts();
    const task = await expectCompleted(root, restarted);
    // A crash before the agent-run leaves no draft to finish: recovery only writes the missing agent-run.
    const draftWasPending = !label.startsWith("before");
    expect(batch.drafts.some((draft) => draft.objectIds.includes(task.frontmatter.id))).toBe(draftWasPending);

    // Recovery is itself idempotent: another restart changes nothing.
    const again = await open(root);
    expect((await again.adoptDrafts()).drafts).toEqual([]);
    await expectCompleted(root, again);
  });

  it("replays a draft whose handler failed mid-way for a non-draft reason, reusing the same object IDs", async () => {
    const { root } = await vault();
    await dropDraft(root, "deck.md", dictatedTask());
    let failures = 0;
    const store = new MarkdownObjectStore(root);
    const flaky = new Proxy(store, { get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (property === "write") return (input: Parameters<ObjectStore["write"]>[0]) => input.frontmatter.type === "task" && failures++ === 0 ? store.write(input).then(() => { throw new Error("disk hiccup after writing"); }) : store.write(input);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    } });
    const application = await open(root, flaky);
    const first = await application.adoptDrafts();
    expect(first.drafts[0]).toMatchObject({ outcome: "skipped" });
    const [written] = await readdir(path.join(root, "tasks"));

    const second = await application.adoptDrafts();
    expect(second.drafts).toHaveLength(1);
    expect(second.drafts[0]).toMatchObject({ outcome: "adopted" });
    expect(await readdir(path.join(root, "tasks"))).toEqual([written]);
    await expectCompleted(root, application);
  });

  it("records what an interrupted draft created even if the draft was deleted before restart, so a re-send is a duplicate", async () => {
    const { root } = await vault();
    await dropDraft(root, "deck.md", dictatedTask());
    const crashed = await open(root, crashing(new MarkdownObjectStore(root), "write", ((input: { frontmatter: { type: string } }) => input.frontmatter.type === "audit-event") as never));
    await expect(crashed.adoptDrafts()).rejects.toThrow(/simulated crash/);
    await rm(path.join(root, "_inbox/drafts/deck.md"));

    const restarted = await open(root);
    await restarted.adoptDrafts();
    expect(await adoptionAudits(restarted)).toHaveLength(1);
    await dropDraft(root, "deck.md", dictatedTask());
    expect((await restarted.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "duplicate" });
    expect(await ofType(restarted, "task")).toHaveLength(1);
  });
});

describe("adoption performance", () => {
  it("adopts a 20-draft batch in under 5 seconds", async () => {
    const { root, application } = await vault();
    for (let index = 0; index < 20; index += 1) await dropDraft(root, `draft-${String(index).padStart(2, "0")}.md`, dictatedTask(`key-${index}`, `Task ${index}`));
    const started = performance.now();
    const batch = await application.adoptDrafts();
    const elapsed = performance.now() - started;
    expect(batch.drafts.filter((draft) => draft.outcome === "adopted")).toHaveLength(20);
    expect(await ofType(application, "task")).toHaveLength(20);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("crash replay for every adoption handler (merged with #33, #34, #36, #40)", () => {
  const yamlDraft = (fields: Record<string, unknown>, body = "Said in the Q3 meeting.\n") => `---\n${stringify({ lifeos_draft: 1, origin: "user-dictated", captured_at: "2026-10-04T09:15:00+02:00", ...fields })}---\n${body}`;
  const onAdoptionAudit = ((input: { frontmatter: Record<string, unknown> }) => input.frontmatter.type === "audit-event" && input.frontmatter.action === "draft.adopted") as never;
  /** Markdown files in a data-root folder, so the test sees what is on disk, not only what the index has. */
  const filesIn = async (root: string, folder: string) => (await readdir(path.join(root, folder)).catch(() => [] as string[])).filter((name) => name.endsWith(".md")).sort();
  const reviewsOf = async (application: LifeOSApplication, type: string) => (await ofType(application, "review-item")).filter((review) => review.frontmatter.review_type === type);

  async function crashThenRestart(root: string, objects: ObjectStore) {
    const crashed = await open(root, objects);
    await expect(crashed.adoptDrafts()).rejects.toThrow(/simulated crash/);
    const before = { decisions: await filesIn(root, "decisions"), reviews: await filesIn(root, "review-items"), people: await filesIn(root, "people") };
    const restarted = await open(root);
    const batch = await restarted.adoptDrafts();
    return { restarted, batch, before };
  }

  it("a dictated decision that raised a link-resolution item: same decision and Review Item IDs, each audited once", async () => {
    const { root } = await vault();
    await dropDraft(root, "decision.md", yamlDraft({ kind: "decision", draft_key: "q3-decision", title: "Ship the relaunch in March", project: "No such project" }));
    const { restarted, batch, before } = await crashThenRestart(root, crashing(new MarkdownObjectStore(root), "write", onAdoptionAudit));

    expect(before.decisions).toHaveLength(1);
    expect(before.reviews).toHaveLength(1);
    expect(await filesIn(root, "decisions")).toEqual(before.decisions);
    expect(await filesIn(root, "review-items")).toEqual(before.reviews);
    const [decision] = await ofType(restarted, "decision");
    const [link] = await reviewsOf(restarted, "link-resolution");
    expect(link!.frontmatter).toMatchObject({ target_object_id: decision!.frontmatter.id, status: "pending" });
    expect(batch.drafts[0]).toMatchObject({ outcome: "adopted", objectIds: [decision!.frontmatter.id, link!.frontmatter.id] });
    expect((await adoptionAudits(restarted)).map((audit) => audit.frontmatter.object_id).sort()).toEqual([decision!.frontmatter.id, link!.frontmatter.id].sort());
    expect(await frontmatterOf(path.join(root, "_inbox/processed/decision.result.md"))).toMatchObject({ outcome: "adopted", object_ids: [decision!.frontmatter.id, link!.frontmatter.id] });
  });

  it("an agent-extracted decision: one create Review Item, with the same ID and operation_id after the replay", async () => {
    const { root } = await vault();
    await dropDraft(root, "extracted.md", yamlDraft({ kind: "decision", origin: "agent-extracted", draft_key: "q3-extracted", title: "Move the launch to April", confidence: "High" }));
    const reviewFile = async () => { const [name] = await filesIn(root, "review-items"); return frontmatterOf(path.join(root, "review-items", name!)); };
    const crashed = await open(root, crashing(new MarkdownObjectStore(root), "write", onAdoptionAudit));
    await expect(crashed.adoptDrafts()).rejects.toThrow(/simulated crash/);
    const first = await reviewFile();

    const restarted = await open(root);
    expect((await restarted.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "adopted", objectIds: [first.id] });
    expect(await filesIn(root, "review-items")).toHaveLength(1);
    expect(await reviewFile()).toMatchObject({ id: first.id, operation_id: first.operation_id, review_type: "create", status: "pending" });
    expect(await ofType(restarted, "decision")).toHaveLength(0);
  });

  it("a person draft that raised a person-merge suggestion: no second person or suggestion after the replay", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "kim.md", yamlDraft({ kind: "person", draft_key: "kim-1", title: "Kim Lee", email: "kim.lee@acme.fr" }));
    await application.adoptDrafts();
    await dropDraft(root, "kim-again.md", yamlDraft({ kind: "person", draft_key: "kim-2", title: "Kim Lee", email: "k.lee@other.fr" }));
    const { restarted, batch, before } = await crashThenRestart(root, crashing(new MarkdownObjectStore(root), "write", onAdoptionAudit));

    expect(before.people).toHaveLength(2);
    expect(await filesIn(root, "people")).toEqual(before.people);
    expect(await filesIn(root, "review-items")).toEqual(before.reviews);
    const merges = await reviewsOf(restarted, "person-merge");
    expect(merges).toHaveLength(1);
    expect(batch.drafts[0]!.outcome).toBe("adopted");
    expect(batch.drafts[0]!.objectIds).toContain(merges[0]!.frontmatter.id);
  });

  it("a patch applied before the crash is filed as applied on restart, never applied twice", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "task.md", dictatedTask());
    const taskId = (await application.adoptDrafts()).drafts[0]!.objectIds[0]!;
    const target = path.join(root, "_inbox", "patches", "note.md");
    await writeFile(target, `---\n${stringify({ lifeos_patch: 1, draft_key: "note-1", origin: "user-dictated", captured_at: "2026-10-04T10:00:00+02:00", id: taskId, set: { priority: "High" }, append_note: "Joel wants it in French." })}---\n`);
    const past = new Date(Date.now() - 60_000);
    await utimes(target, past, past);

    const inbox = crashing(new FilesystemInboxStore(root), "move", ((from: string) => from === "patches") as never);
    const crashed = await open(root, new MarkdownObjectStore(root), inbox);
    await expect(crashed.adoptDrafts()).rejects.toThrow(/simulated crash/);

    const restarted = await open(root);
    const batch = await restarted.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ draft: "_inbox/patches/note.md", outcome: "applied", objectIds: [taskId] });
    expect(await frontmatterOf(path.join(root, "_inbox/processed/note.result.md"))).toMatchObject({ outcome: "applied", object_ids: [taskId] });
    expect(restarted.object(taskId).body.match(/Joel wants it in French\./g)).toHaveLength(1);
    expect(restarted.appliedPatches()).toHaveLength(1);
    expect(await readdir(path.join(root, "_inbox/patches"))).toEqual([]);
  });

  // #61: every crash point of a patch, applied or routed to review, recovers to the same result as an uninterrupted run.
  describe("patch crash points (#61)", () => {
    const dropPatch = async (root: string, fields: Record<string, unknown>) => {
      const target = path.join(root, "_inbox", "patches", "note.md");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `---\n${stringify({ lifeos_patch: 1, draft_key: "note-1", origin: "user-dictated", captured_at: "2026-10-04T10:00:00+02:00", ...fields })}---\n`);
      const past = new Date(Date.now() - 60_000);
      await utimes(target, past, past);
    };
    async function withTask() {
      const { root, application } = await vault();
      await dropDraft(root, "task.md", dictatedTask());
      const taskId = (await application.adoptDrafts()).drafts[0]!.objectIds[0]!;
      return { root, taskId, original: application.object(taskId) };
    }
    const auditOf = (action: string) => ((input: { frontmatter: Record<string, unknown> }) => input.frontmatter.type === "audit-event" && input.frontmatter.action === action) as never;
    const onPatches = ((from: string) => from === "patches") as never;
    const onSidecar = ((folder: string, name: string) => name.endsWith(".result.md")) as never;

    it.each([
      ["after the update, before the patch.applied audit", "objects", auditOf("patch.applied")],
      ["after the audit, before the patch was moved", "inbox:move", onPatches],
      ["after the patch was moved, before its .result.md", "inbox:writeDocument", onSidecar]
    ] as const)("an applied patch that crashed %s: note appended once, true before/after audited, Undo restores the original", async (_label, where, when) => {
      const { root, taskId, original } = await withTask();
      await dropPatch(root, { id: taskId, set: { priority: "High" }, append_note: "Joel wants it in French." });
      const objects = where === "objects" ? crashing(new MarkdownObjectStore(root), "write", when) : new MarkdownObjectStore(root);
      const inbox = where.startsWith("inbox:") ? crashing(new FilesystemInboxStore(root), where.slice(6) as keyof FilesystemInboxStore, when) : new FilesystemInboxStore(root);
      const crashed = await open(root, objects, inbox);
      // A write error inside the patch reader is reported as skipped (journal kept) rather than thrown; either way the process is gone.
      await crashed.adoptDrafts().catch(() => undefined);

      const restarted = await open(root);
      const batch = await restarted.adoptDrafts();
      expect(batch.drafts[0]).toMatchObject({ draft: "_inbox/patches/note.md", outcome: "applied", objectIds: [taskId] });
      expect(await frontmatterOf(path.join(root, "_inbox/processed/note.result.md"))).toMatchObject({ outcome: "applied", object_ids: [taskId] });
      const patched = restarted.object(taskId);
      expect(patched.body.match(/Joel wants it in French\./g)).toHaveLength(1);
      expect(patched.frontmatter).toMatchObject({ priority: "High", revision: 2 });
      const [applied] = restarted.appliedPatches();
      expect(restarted.appliedPatches()).toHaveLength(1);
      expect(applied).toMatchObject({ before: { priority: null }, after: { priority: "High" }, appendedNote: "Joel wants it in French." });

      const undone = await restarted.undoPatch(applied!.auditEventId);
      expect(undone.frontmatter.priority).toBeUndefined();
      expect(undone.body).toBe(original.body);
      expect(await (await open(root)).adoptDrafts()).toMatchObject({ drafts: [] });
      // Nothing is left half-done in the operation journal.
      expect(await new MarkdownObjectStore(root).incompleteOperations()).toEqual([]);
    });

    it.each([
      ["after the Review Item was written, before its patch.review-raised audit", "objects", auditOf("patch.review-raised")],
      ["after the patch.review-raised audit, before the patch was moved", "inbox:move", onPatches],
      ["after the patch was moved, before its .result.md", "inbox:writeDocument", onSidecar]
    ] as const)("a review-routed patch that crashed %s is filed as review-raised with its one Review Item", async (_label, where, when) => {
      const { root, taskId, original } = await withTask();
      await dropPatch(root, { id: taskId, set: { title: "Send Joel the French sizing deck" } });
      const objects = where === "objects" ? crashing(new MarkdownObjectStore(root), "write", when) : new MarkdownObjectStore(root);
      const inbox = where.startsWith("inbox:") ? crashing(new FilesystemInboxStore(root), where.slice(6) as keyof FilesystemInboxStore, when) : new FilesystemInboxStore(root);
      const crashed = await open(root, objects, inbox);
      // A write error inside the patch reader is reported as skipped (journal kept) rather than thrown; either way the process is gone.
      await crashed.adoptDrafts().catch(() => undefined);

      const restarted = await open(root);
      const batch = await restarted.adoptDrafts();
      const reviews = (await ofType(restarted, "review-item")).filter((review) => review.frontmatter.review_type === "update");
      expect(reviews).toHaveLength(1);
      const reviewId = reviews[0]!.frontmatter.id;
      expect(batch.drafts[0]).toMatchObject({ draft: "_inbox/patches/note.md", outcome: "review", objectIds: [reviewId] });
      expect(await frontmatterOf(path.join(root, "_inbox/processed/note.result.md"))).toMatchObject({ outcome: "review", object_ids: [reviewId] });
      expect((await ofType(restarted, "audit-event")).filter((audit) => audit.frontmatter.action === "patch.review-raised")).toHaveLength(1);
      expect(restarted.object(taskId).frontmatter.title).toBe(original.frontmatter.title);
      expect(restarted.appliedPatches()).toEqual([]);
      expect((await (await open(root)).adoptDrafts()).drafts).toEqual([]);
      expect(await new MarkdownObjectStore(root).incompleteOperations()).toEqual([]);
    });

    // #71: a journalled patch counts as written only when the target really holds the change.
    describe("patch journal recovery (#71)", () => {
      const isPatchJournal = ((id: string) => id.startsWith("apply-patch-")) as never;
      const onTaskWrite = ((input: { frontmatter: Record<string, unknown> }) => input.frontmatter.type === "task") as never;
      const patchJournals = async (root: string) => (await new MarkdownObjectStore(root).incompleteOperations()).filter((operation) => operation.kind === "apply-patch");
      const appliedAudits = (application: LifeOSApplication) => ofType(application, "audit-event").then((audits) => audits.filter((audit) => audit.frontmatter.action === "patch.applied"));
      /** The process dies after journalling the patch and before writing the target: the journal stays open. */
      async function crashBeforeWrite(root: string) {
        const objects = crashing(crashing(new MarkdownObjectStore(root), "write", onTaskWrite), "completeOperation", isPatchJournal);
        await (await open(root, objects)).adoptDrafts().catch(() => undefined);
        expect(await patchJournals(root)).toHaveLength(1);
      }
      /** The process dies after the write and its audit, before closing the journal. */
      async function crashBeforeJournalClosed(root: string) {
        await (await open(root, crashing(new MarkdownObjectStore(root), "completeOperation", isPatchJournal))).adoptDrafts().catch(() => undefined);
        expect(await patchJournals(root)).toHaveLength(1);
      }

      it("crash before the write, target edited since on another field: replay applies the patch for real, no phantom audit", async () => {
        const { root, taskId } = await withTask();
        await dropPatch(root, { id: taskId, set: { priority: "High" }, append_note: "Joel wants it in French." });
        await crashBeforeWrite(root);
        const editor = await open(root);
        await editor.setSensitivity(taskId, "restricted", editor.object(taskId).contentHash);

        const restarted = await open(root);
        expect((await restarted.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied", objectIds: [taskId] });
        const patched = restarted.object(taskId);
        expect(patched.frontmatter).toMatchObject({ priority: "High", sensitivity: "restricted" });
        expect(patched.body.match(/Joel wants it in French\./g)).toHaveLength(1);
        expect(restarted.appliedPatches()).toHaveLength(1);
        expect(restarted.appliedPatches()[0]).toMatchObject({ before: { priority: null }, after: { priority: "High" } });
        expect(await patchJournals(root)).toEqual([]);
      });

      it("crash before the write, then the same field edited after capture: routed to review, no patch.applied audit", async () => {
        const { root, taskId } = await withTask();
        // Captured well before the task's own audits, so the test does not depend on the time of day it runs.
        await dropPatch(root, { id: taskId, set: { priority: "High" }, captured_at: "2026-01-01T09:00:00Z" });
        await crashBeforeWrite(root);
        // The user changes the same field after the patch was captured: the conflict rule must see it.
        const editor = await open(root);
        await editor.updateTask(taskId, { priority: "Low" }, editor.object(taskId).contentHash);

        const restarted = await open(root);
        expect((await restarted.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
        expect(await appliedAudits(restarted)).toEqual([]);
        expect(restarted.object(taskId).frontmatter.priority).toBe("Low");
        expect(await patchJournals(root)).toEqual([]);
      });

      it("startup recovery closes the journal of a patch that was never written, and adoption then applies it once", async () => {
        const { root, taskId } = await withTask();
        await dropPatch(root, { id: taskId, set: { priority: "High" }, append_note: "Joel wants it in French." });
        await crashBeforeWrite(root);

        const restarted = await open(root);
        await restarted.recoverOperations();
        expect(await patchJournals(root)).toEqual([]);
        expect(await appliedAudits(restarted)).toEqual([]);
        expect((await restarted.health()).diagnostics.filter((line) => line.includes("apply-patch"))).toEqual([]);
        expect((await restarted.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied", objectIds: [taskId] });
        expect(restarted.object(taskId).body.match(/Joel wants it in French\./g)).toHaveLength(1);
        expect(restarted.appliedPatches()).toHaveLength(1);
      });

      it("startup recovery audits a patch written before the crash, and Undo restores the original", async () => {
        const { root, taskId, original } = await withTask();
        await dropPatch(root, { id: taskId, set: { priority: "High" }, append_note: "Joel wants it in French." });
        await (await open(root, crashing(new MarkdownObjectStore(root), "write", auditOf("patch.applied")))).adoptDrafts().catch(() => undefined);
        expect(await patchJournals(root)).toHaveLength(1);

        const restarted = await open(root);
        expect(await restarted.recoverOperations()).toHaveLength(1);
        expect(await patchJournals(root)).toEqual([]);
        const [applied] = restarted.appliedPatches();
        expect(restarted.appliedPatches()).toHaveLength(1);
        expect(applied).toMatchObject({ objectId: taskId, draftKey: "note-1", before: { priority: null }, after: { priority: "High" }, appendedNote: "Joel wants it in French." });
        // Adoption then files the patch as applied without changing the task again.
        expect((await restarted.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied", objectIds: [taskId] });
        expect(restarted.object(taskId).frontmatter.revision).toBe(2);
        expect(restarted.appliedPatches()).toHaveLength(1);
        expect((await restarted.undoPatch(applied!.auditEventId)).body).toBe(original.body);
      });

      it("a stale journal (patch already audited) is closed by startup recovery", async () => {
        const { root, taskId } = await withTask();
        await dropPatch(root, { id: taskId, set: { priority: "High" } });
        await crashBeforeJournalClosed(root);

        const restarted = await open(root);
        await restarted.adoptDrafts();
        expect(restarted.appliedPatches()).toHaveLength(1);
        await restarted.recoverOperations();
        expect(await patchJournals(root)).toEqual([]);
        expect(restarted.appliedPatches()).toHaveLength(1);
        expect((await restarted.health()).diagnostics.filter((line) => line.includes("apply-patch"))).toEqual([]);
      });

      it("a journal whose target is gone stays open and is listed in System Health", async () => {
        const { root, taskId } = await withTask();
        await dropPatch(root, { id: taskId, set: { priority: "High" } });
        await crashBeforeWrite(root);
        const [taskFile] = await filesIn(root, "tasks");
        await rm(path.join(root, "tasks", taskFile!));

        const restarted = await open(root);
        expect(await restarted.recoverOperations()).toEqual([]);
        expect(await patchJournals(root)).toHaveLength(1);
        const health = await restarted.health();
        expect(health.status).toBe("attention");
        expect(health.diagnostics.some((line) => line.includes("apply-patch") && line.includes(taskId))).toBe(true);
      });
    });
  });
});
