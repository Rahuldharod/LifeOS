import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { LifeOSApplication, type ObjectStore } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { AppContext } from "../../packages/application/src/context.js";

// Issue #58: a create never reuses an ID that already exists (in the index or on disk) and never overwrites a file.

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-duplicate-create-"));
  roots.push(root);
  return root;
}

const personId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const person = (title: string) => ({
  id: personId, type: "person" as const, schema_version: 1, revision: 1, title, given_name: title,
  created_at: "2026-10-04T08:00:00Z", updated_at: "2026-10-04T08:00:00Z", updated_by_device: "test-device"
});
const duplicate = /Duplicate object ID/;

describe("MarkdownObjectStore creates (no expected hash)", () => {
  it("refuses to overwrite a file that already exists at the path", async () => {
    const store = new MarkdownObjectStore(await tempRoot());
    const first = await store.write({ relativePath: "people/example.md", frontmatter: person("First"), body: "First\n" });
    const otherId = "01995d3e-912b-7357-8aa6-9816c1ad90a6";
    await expect(store.write({ relativePath: "people/example.md", frontmatter: { ...person("Second"), id: otherId }, body: "Second\n" })).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect((await store.read("people/example.md")).contentHash).toBe(first.contentHash);
  });

  it("refuses an ID already on disk under another file name, writing nothing", async () => {
    const root = await tempRoot();
    const store = new MarkdownObjectStore(root);
    await store.write({ relativePath: `people/2026-10-04-0800-first--${personId}.md`, frontmatter: person("First"), body: "First\n" });
    await expect(store.write({ relativePath: `people/2026-10-04-0801-first--${personId}.md`, frontmatter: person("First"), body: "First\n" })).rejects.toThrow(duplicate);
    expect(await readdir(path.join(root, "people"))).toEqual([`2026-10-04-0800-first--${personId}.md`]);
  });

  it("leaves guarded updates working", async () => {
    const store = new MarkdownObjectStore(await tempRoot());
    const first = await store.write({ relativePath: "people/example.md", frontmatter: person("First"), body: "First\n" });
    const updated = await store.write({ relativePath: "people/example.md", frontmatter: { ...person("Renamed"), revision: 2 }, body: "Renamed\n", expectedHash: first.contentHash });
    expect(updated.frontmatter.title).toBe("Renamed");
  });
});

describe("application creates", () => {
  it("refuses an ID already in the index at any path, writing nothing", async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, "people"), { recursive: true });
    // A file the user renamed: its name no longer carries the ID, so only the index knows it.
    await writeFile(path.join(root, "people/renamed.md"), `---\n${stringify(person("First"))}---\n# First\n`);
    const index = new MemoryIndex();
    const context = new AppContext(new MarkdownObjectStore(root), index, undefined, undefined, "test-device");
    await context.rebuildIndex();
    await expect(context.objects.write({ relativePath: `people/2026-10-04-0900-first--${personId}.md`, frontmatter: person("First"), body: "# First\n" })).rejects.toThrow(duplicate);
    expect(await readdir(path.join(root, "people"))).toEqual(["renamed.md"]);
  });

  it("an accept retried in a new minute, before the index is rebuilt, is refused instead of writing a second copy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T09:30:10Z"));
    const root = await tempRoot();
    const draft = path.join(root, "_inbox", "drafts", "extracted.md");
    await mkdir(path.dirname(draft), { recursive: true });
    await writeFile(draft, `---\n${stringify({ lifeos_draft: 1, kind: "task", origin: "agent-extracted", draft_key: "retry-accept", title: "Send the deck", captured_at: "2026-10-04T09:15:00Z", confidence: "High" })}---\n`);
    const past = new Date("2026-10-04T09:00:00Z");
    await utimes(draft, past, past);

    // The task is written, then saving the accepted Review Item fails: the index is not rebuilt.
    const store = new MarkdownObjectStore(root);
    let failReview = false;
    const flaky = new Proxy(store, { get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (property === "write") return (input: Parameters<ObjectStore["write"]>[0]) => {
        if (failReview && input.frontmatter.type === "review-item") { failReview = false; return Promise.reject(new Error("disk hiccup")); }
        return store.write(input);
      };
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    } });
    const application = new LifeOSApplication(flaky, new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
    await application.rebuildIndex();
    await application.adoptDrafts();
    const review = (await application.listObjects()).find((object) => object.frontmatter.type === "review-item")!;

    failReview = true;
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow("disk hiccup");
    const [written] = await readdir(path.join(root, "tasks"));
    expect(written).toMatch(/^2026-10-04-0930-/);

    vi.setSystemTime(new Date("2026-10-04T09:31:10Z"));
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow(duplicate);
    expect(await readdir(path.join(root, "tasks"))).toEqual([written]);

    // Once the index catches up, the retry completes onto the object already written.
    await application.rebuildIndex();
    const accepted = await application.acceptReviewItem(review.frontmatter.id);
    expect(accepted.relativePath).toBe(`tasks/${written}`);
    expect(await readdir(path.join(root, "tasks"))).toEqual([written]);
    expect(await readFile(path.join(root, "tasks", written!), "utf8")).toContain("Send the deck");
  });
});
