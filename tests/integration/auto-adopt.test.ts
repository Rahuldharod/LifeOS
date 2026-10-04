import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication, type AdoptionBatch, type InboxStore, type ObjectStore } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #32: drafts are adopted automatically when they land (watcher trigger, debounced, plus a safety sweep),
// half-written files are never adopted, re-sends never duplicate, and a crashed batch is completed on restart.

const roots: string[] = [];
const triggers: Array<{ stop(): void }> = [];
afterEach(async () => {
  triggers.splice(0).forEach((trigger) => trigger.stop());
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
    for (let event = 0; event < 5; event += 1) { trigger.notify(); await pause(10); }
    await until(async () => (await ofType(application, "task")).length === 2);
    await pause(150);
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
    await until(async () => (await ofType(application, "task")).length === 1);
    expect(batches[0]!.drafts[0]).toMatchObject({ outcome: "skipped" });
    expect(batches.at(-1)!.drafts[0]).toMatchObject({ outcome: "adopted" });
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
