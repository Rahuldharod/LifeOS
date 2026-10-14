import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { testApi } from "./test-api.js";

// ADR 0022 (PB-018): App Feedback is one Markdown file per submission in `_inbox/feedback/`. It is not an object,
// needs no device lease and is never read by adoption.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => { await chmod(path.join(root, "_inbox", "feedback"), 0o755).catch(() => undefined); await rm(root, { recursive: true, force: true }); })); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-feedback-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "Rahul's MacBook Pro", new FilesystemInboxStore(root), undefined, { timeZone: "Europe/Paris", appInfo: { version: "0.1.0", commit: "abc1234" } });
  await application.rebuildIndex();
  return { root, application };
}

const feedbackDir = (root: string) => path.join(root, "_inbox", "feedback");
const files = async (root: string) => (await readdir(feedbackDir(root)).catch(() => [] as string[])).filter((name) => name.endsWith(".md")).sort();
const read = async (root: string, name: string) => {
  const content = await readFile(path.join(feedbackDir(root), name), "utf8");
  const [, yaml = "", ...rest] = content.split("---\n");
  return { frontmatter: parse(yaml) as Record<string, unknown>, body: rest.join("---\n") };
};
const now = new Date("2026-10-14T07:05:03.000Z");
const objectLink = "lifeos://object/0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";

describe("submitting App Feedback", () => {
  it("writes one file with the agreed frontmatter and the text exactly as typed", async () => {
    const { root, application } = await vault();
    const text = "  The Today list is slow\n\n- when many tasks\n";
    const result = await application.submitFeedback({ label: "bug", text, page: "Tasks", object: objectLink }, { now });

    const [name] = await files(root);
    expect(await files(root)).toHaveLength(1);
    expect(name).toMatch(/^2026-10-14-090503-rahul-s-macbook-pro-[a-z0-9]{4}\.md$/);
    expect(result.file).toBe(`_inbox/feedback/${name}`);
    const { frontmatter, body } = await read(root, name!);
    expect(frontmatter).toEqual({ lifeos_feedback: 1, label: "bug", captured_at: "2026-10-14T07:05:03.000Z", page: "Tasks", object: objectLink, app_version: "0.1.0", app_commit: "abc1234", device: "Rahul's MacBook Pro" });
    expect(body).toBe(text);
  });

  it("stores captured_at in UTC and names the file in the user's local time", async () => {
    const { root, application } = await vault();
    await application.submitFeedback({ label: "feature", text: "Late evening", page: "Today" }, { now: new Date("2026-10-14T22:30:00.000Z") });
    const [name] = await files(root);
    expect(name).toMatch(/^2026-10-15-003000-/);
    expect((await read(root, name!)).frontmatter.captured_at).toBe("2026-10-14T22:30:00.000Z");
  });

  it("leaves the object field out when no object is open", async () => {
    const { root, application } = await vault();
    await application.submitFeedback({ label: "feature", text: "Dark mode", page: "Today" }, { now });
    const { frontmatter } = await read(root, (await files(root))[0]!);
    expect(frontmatter).not.toHaveProperty("object");
    expect(frontmatter.label).toBe("feature");
  });

  it("keeps two submissions in the same second as two distinct files", async () => {
    const { root, application } = await vault();
    await application.submitFeedback({ label: "feature", text: "One", page: "Today" }, { now });
    await application.submitFeedback({ label: "feature", text: "Two", page: "Today" }, { now });
    expect(await files(root)).toHaveLength(2);
  });

  it("rejects empty text, an unknown label and a bad object link without writing", async () => {
    const { root, application } = await vault();
    await expect(application.submitFeedback({ label: "bug", text: "  \n ", page: "Today" })).rejects.toThrow(/text/i);
    await expect(application.submitFeedback({ label: "idea" as "bug", text: "x", page: "Today" })).rejects.toThrow(/label/i);
    await expect(application.submitFeedback({ label: "bug", text: "x", page: "Today", object: "https://example.com" })).rejects.toThrow(/object/i);
    expect(await files(root)).toEqual([]);
  });

  it("is not an object: the scan ignores it", async () => {
    const { root, application } = await vault();
    await application.submitFeedback({ label: "bug", text: "Broken", page: "Today" }, { now });
    await application.rebuildIndex();
    const health = await application.health();
    expect(health.diagnostics).toEqual([]);
    expect(health.objectCount).toBe(0);
    expect(await files(root)).toHaveLength(1);
  });

  it("is ignored by adoption: the file stays where it is", async () => {
    const { root, application } = await vault();
    await application.submitFeedback({ label: "bug", text: "Broken", page: "Today" }, { now });
    const [name] = await files(root);
    const before = await readFile(path.join(feedbackDir(root), name!), "utf8");
    await application.adoptDrafts();
    expect(await files(root)).toEqual([name]);
    expect(await readFile(path.join(feedbackDir(root), name!), "utf8")).toBe(before);
    expect(await readdir(path.join(root, "_inbox", "processed"))).toEqual([]);
    expect(await readdir(path.join(root, "_inbox", "failed"))).toEqual([]);
  });

  it("fails when the folder cannot be written, leaving nothing behind", async () => {
    const { root, application } = await vault();
    await application.submitFeedback({ label: "bug", text: "First", page: "Today" }, { now });
    await chmod(feedbackDir(root), 0o555);
    await expect(application.submitFeedback({ label: "bug", text: "Second", page: "Today" }, { now })).rejects.toThrow();
    await chmod(feedbackDir(root), 0o755);
    expect(await readdir(feedbackDir(root))).toHaveLength(1);
  });
});

describe("POST /api/v1/feedback", () => {
  it("saves feedback through the API with this device's name", async () => {
    const { root, call, start, send } = await testApi({ appInfo: { version: "0.1.0", commit: "abc1234" } });
    await start();
    const response = await call("POST /api/v1/feedback", { body: { label: "feature", text: "Add a dark mode", page: "Notes" } });
    expect(response.message).toBe("Feedback saved");
    const [name] = await files(root);
    const { frontmatter, body } = await read(root, name!);
    expect(frontmatter).toMatchObject({ lifeos_feedback: 1, label: "feature", page: "Notes", device: "desk-mac", app_version: "0.1.0", app_commit: "abc1234" });
    expect(body).toBe("Add a dark mode");
    expect((await send("POST", "/api/v1/feedback", { label: "bug", text: "", page: "Notes" })).statusCode).toBe(400);
  });

  it("answers an error when the file cannot be written", async () => {
    const { root, send, start } = await testApi();
    await start();
    await send("POST", "/api/v1/feedback", { label: "bug", text: "First", page: "Today" });
    await chmod(feedbackDir(root), 0o555);
    const response = await send("POST", "/api/v1/feedback", { label: "bug", text: "Broken", page: "Today" });
    await chmod(feedbackDir(root), 0o755);
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(response.json()).toHaveProperty("error");
  });
});
