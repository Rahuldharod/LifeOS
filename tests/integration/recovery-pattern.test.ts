import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { LifeOSApplication, type ObjectStore } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, FilesystemOperationStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #74: one crash-recovery pattern (ADR 0013). Behaviour checks for the two places it changed something.

const linkRefusal = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: (from: string, to: string) => linkRefusal.code
      ? Promise.reject(Object.assign(new Error(`${linkRefusal.code}: hard links refused`), { code: linkRefusal.code }))
      : actual.link(from, to)
  };
});

const roots: string[] = [];
afterEach(async () => {
  linkRefusal.code = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-recovery-pattern-"));
  roots.push(root);
  return root;
}

/** Object writes reach the disk until write number `crashAfter` has landed; then the "process dies". */
function crashingAfter(store: ObjectStore, crashAfter: number) {
  let writes = 0;
  return new Proxy(store, { get(object, property, receiver) {
    const value = Reflect.get(object, property, receiver) as unknown;
    if (property === "write") return async (input: Parameters<ObjectStore["write"]>[0]) => {
      if (writes >= crashAfter) throw new Error("simulated crash: process already dead");
      const written = await object.write(input);
      writes += 1;
      if (writes === crashAfter) throw new Error(`simulated crash after write ${writes}`);
      return written;
    };
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
  } });
}

const open = async (root: string, objects: ObjectStore = new MarkdownObjectStore(root)) => {
  const application = new LifeOSApplication(objects, new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return application;
};

async function dropDraft(root: string, name: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ lifeos_draft: 1, captured_at: "2026-10-04T09:15:00+02:00", ...fields })}---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

describe("person-merge suggestion audit on replay (#74)", () => {
  it("GIVEN a crash after any write of a person draft that raises a merge suggestion WHEN adoption replays it THEN its review.proposed audit exists exactly once", async () => {
    for (let crashAfter = 1; crashAfter <= 4; crashAfter += 1) {
      const root = await tempRoot();
      await dropDraft(root, "kim.md", { kind: "person", origin: "user-dictated", draft_key: "kim-1", title: "Kim Lee", email: "kim.lee@example.com" });
      await (await open(root)).adoptDrafts();
      await dropDraft(root, "kim-again.md", { kind: "person", origin: "agent-extracted", draft_key: "kim-2", title: "Kim Lee", email: "k.lee@example.org" });
      await (await open(root, crashingAfter(new MarkdownObjectStore(root), crashAfter))).adoptDrafts().catch(() => undefined);

      const restarted = await open(root);
      await restarted.adoptDrafts();
      const objects = await restarted.listObjects();
      const merges = objects.filter((object) => object.frontmatter.review_type === "person-merge");
      expect(merges, `crash after write ${crashAfter}`).toHaveLength(1);
      const proposed = objects.filter((object) => object.frontmatter.action === "review.proposed" && object.frontmatter.object_id === merges[0]!.frontmatter.id);
      expect(proposed, `review.proposed audits after a crash at write ${crashAfter}`).toHaveLength(1);
    }
  }, 60_000);
});

describe("exclusive create when hard links are refused (#74)", () => {
  it("GIVEN a file system that refuses hard links WHEN an operation is prepared twice THEN the first payload is kept and no temporary file is left", async () => {
    const root = await tempRoot();
    linkRefusal.code = "EPERM";
    const operations = new FilesystemOperationStore(root);
    const first = await operations.prepare("accept-review", { reviewId: "first" }, "op-1");
    const second = await operations.prepare("accept-review", { reviewId: "second" }, "op-1");
    expect(first.payload).toEqual({ reviewId: "first" });
    expect(second.payload).toEqual({ reviewId: "first" });
    expect((await operations.incomplete()).map((operation) => operation.id)).toEqual(["op-1"]);
    expect(await readdir(path.join(root, ".lifeos", "operations"))).toEqual(["op-1.json"]);
  });

  it("GIVEN a file system that refuses hard links WHEN an object is created THEN it is written, and a second create at the same path is refused", async () => {
    const root = await tempRoot();
    linkRefusal.code = "ENOTSUP";
    const store = new MarkdownObjectStore(root);
    const envelope = (id: string) => ({ id, type: "project" as const, schema_version: 1, revision: 1, title: "Loyalty relaunch", created_at: "2026-10-04T08:00:00.000Z", updated_at: "2026-10-04T08:00:00.000Z", updated_by_device: "test", status: "active" });
    const created = await store.write({ relativePath: "projects/loyalty-relaunch.md", frontmatter: envelope("01995d60-7baf-7c21-9c96-9c5d2f6a32ac"), body: "# Loyalty relaunch\n" });
    expect(created.frontmatter.id).toBe("01995d60-7baf-7c21-9c96-9c5d2f6a32ac");
    await expect(store.write({ relativePath: "projects/loyalty-relaunch.md", frontmatter: envelope("01995d60-7baf-7c21-9c96-9c5d2f6a32ad"), body: "# Other\n" })).rejects.toThrow(/already exists/);
    expect((await store.read("projects/loyalty-relaunch.md")).frontmatter.id).toBe("01995d60-7baf-7c21-9c96-9c5d2f6a32ac");
    expect((await readdir(path.join(root, "projects"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
