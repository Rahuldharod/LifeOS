import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #55: index rebuilds run one at a time, so an older, slower scan can never replace a newer index.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A real store whose next scan can be held after it has read the disk, to play a slow scan finishing last. */
class HeldStore extends MarkdownObjectStore {
  scans = 0;
  /** Makes the next scan throw after it has read the disk (and after any hold). */
  failNextScan = false;
  private held?: { reached: () => void; release: Promise<void> };

  /** Holds the next scan once it has read the disk; resolves `reached` then, and lets it finish on `release()`. */
  holdNextScan() {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    this.held = { reached, release: new Promise<void>((resolve) => { release = resolve; }) };
    return { reached: reachedPromise, release };
  }

  override async scan() {
    this.scans += 1;
    const held = this.held;
    this.held = undefined;
    const result = await super.scan();
    if (held) { held.reached(); await held.release; }
    if (this.failNextScan) { this.failNextScan = false; throw new Error("disk hiccup"); }
    return result;
  }
}

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-rebuild-"));
  roots.push(root);
  const store = new HeldStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test");
  await application.rebuildIndex();
  return { root, store, application };
}

/** A task written straight to disk, as a sync client or another device would (its owner need not exist for this test). */
async function taskOnDisk(root: string, title: string) {
  const id = uuidV7();
  const timestamp = new Date().toISOString();
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await writeFile(path.join(root, "tasks", `${id}.md`), `---\n${stringify({ id, type: "task", schema_version: 1, revision: 1, title, created_at: timestamp, updated_at: timestamp, updated_by_device: "test", status: "Inbox", owner_person_id: uuidV7() }).trimEnd()}\n---\n# ${title}\n`);
  return id;
}

describe("index rebuilds (#55)", () => {
  it("an older slow scan finishing last cannot replace a newer index", async () => {
    const { root, store, application } = await vault();
    const slow = store.holdNextScan();
    const stale = application.rebuildIndex();
    await slow.reached; // the old scan has read the disk and is about to apply what it saw
    const id = await taskOnDisk(root, "Written after the old scan");
    const fresh = application.rebuildIndex();
    slow.release();
    await Promise.all([stale, fresh]);
    expect(application.object(id).frontmatter.title).toBe("Written after the old scan");
    expect((await fresh).objectCount).toBe(1);
  });

  it("coalesces calls made while a scan runs into one follow-up scan that sees every change", async () => {
    const { root, store, application } = await vault();
    const slow = store.holdNextScan();
    const first = application.rebuildIndex();
    await slow.reached;
    const scansBefore = store.scans;
    const ids = [await taskOnDisk(root, "One"), await taskOnDisk(root, "Two")];
    const waiting = [application.rebuildIndex(), application.rebuildIndex(), application.rebuildIndex()];
    slow.release();
    await Promise.all([first, ...waiting]);
    expect(store.scans - scansBefore).toBe(1);
    for (const id of ids) expect(application.object(id)).toBeDefined();
  });

  it("a failed scan rejects its own callers but does not block the next rebuild", async () => {
    const { root, store, application } = await vault();
    const slow = store.holdNextScan();
    store.failNextScan = true;
    const failing = application.rebuildIndex();
    await slow.reached;
    const id = await taskOnDisk(root, "After the hiccup");
    const next = application.rebuildIndex();
    slow.release();
    await expect(failing).rejects.toThrow("disk hiccup");
    await next;
    expect(application.object(id)).toBeDefined();
  });
});

describe("concurrent task creation (#55)", () => {
  it("creates one self person, not one per concurrent task, and every task is in the index", async () => {
    const { application } = await vault();
    const created = await Promise.all(["A", "B", "C", "D"].map((title) => application.createEntity("task", { title })));
    const selves = application.entities("person").filter((person) => person.frontmatter.is_self === true);
    expect(selves).toHaveLength(1);
    expect(new Set(created.map((task) => task.frontmatter.owner_person_id))).toEqual(new Set([selves[0]!.frontmatter.id]));
    expect(application.entities("task").map((task) => task.frontmatter.title).sort()).toEqual(["A", "B", "C", "D"]);
    expect((await application.health()).diagnostics).toEqual([]);
  });
});
