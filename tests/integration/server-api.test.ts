import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FilesystemSessionStore } from "@lifeos/object-store-markdown";
import type { ApiOptions } from "../../apps/server/src/api.js";
import { testApi } from "./test-api.js";

// #120: the localhost API, built on a temporary data root with the mock calendar and an in-memory secret store,
// called through Fastify's inject. No port is opened and the real data root is never touched.

const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
const taskId = "01995d60-7baf-7c21-9c96-9c5d2f6a32ac";
const task = (title: string) => `---\nid: ${taskId}\ntype: task\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\nstatus: Inbox\nowner_person_id: ${selfId}\n---\n# ${title}\n`;
const self = `---\nid: ${selfId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n`;
const draft = "---\nlifeos_draft: 1\nkind: task\ndraft_key: phone-0915\norigin: user-dictated\ntitle: Send Joel the sizing deck\ncaptured_at: 2026-10-07T09:15:00+02:00\n---\nJoel asked for the deck.\n";

const api = (options: Partial<ApiOptions> = {}) => testApi({ files: { "people/self.md": self, "tasks/task.md": task("Original") }, ...options });

const tasks = async (get: (url: string) => Promise<{ json(): unknown }>) => ((await get("/api/v1/objects")).json() as Array<{ frontmatter: { type: string; title: string; actor_type?: string } }>);

describe("the API as a module", () => {
  it("GIVEN a temporary data root WHEN routes are called through inject THEN they answer from that root", async () => {
    const { start, get } = await api();
    await start();
    const health = await get("/api/v1/health");
    expect(health.statusCode).toBe(200);
    expect(health.json().session).toMatchObject({ writeAllowed: true, activeDeviceId: "desk-mac" });
    expect((await tasks(get)).filter((object) => object.frontmatter.type === "task").map((object) => object.frontmatter.title)).toEqual(["Original"]);
  });

  it("creates a detailed global capture through the typed public endpoint", async () => {
    const { start, get, send } = await api();
    await start();
    const request = { text: "Call Marie\nConfirm the launch date.", dueOn: "2026-10-20", ownerPersonId: selfId, sensitivity: "restricted", requestId: "browser-capture-131" };
    const response = await send("POST", "/api/v1/capture", request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ frontmatter: { title: "Call Marie", status: "Inbox", owner_person_id: selfId, due_on: "2026-10-20", sensitivity: "restricted" }, body: "# Call Marie\n\nConfirm the launch date.\n" });
    expect((await send("POST", "/api/v1/capture", request)).json().frontmatter.id).toBe(response.json().frontmatter.id);
    expect((await tasks(get)).filter((object) => object.frontmatter.type === "task" && object.frontmatter.title === "Call Marie")).toHaveLength(1);
  });

  it("keeps each request check's status and message", async () => {
    const { start, get, send } = await api();
    await start();
    const range = { statusCode: 400, error: "Enter a valid calendar date range" };
    const answer = async (response: Promise<{ statusCode: number; json(): { error?: string } }>) => { const result = await response; return { statusCode: result.statusCode, error: result.json().error }; };
    expect(await answer(get("/api/v1/calendar/events?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z"))).toEqual(range);
    expect(await answer(send("POST", "/api/v1/calendar/sync?from=nonsense"))).toEqual(range);
    expect(await answer(get("/api/v1/calendar/day?to=nonsense"))).toEqual(range);
    expect(await answer(send("POST", "/api/v1/calendar/day/sync?from=2026-10-01T00:00:00Z&to=2026-10-01T00:00:00Z"))).toEqual(range);
    expect(await answer(get("/api/v1/meetings/preview?externalId=e1&from=nonsense"))).toEqual(range);
    expect(await answer(get("/api/v1/meetings/preview"))).toEqual(range);
    expect(await answer(send("POST", "/api/v1/meetings/from-event", { externalId: "e1", from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }))).toEqual(range);

    expect(await answer(get("/api/v1/meetings/series-view"))).toEqual({ statusCode: 400, error: "cursor is required" });
    expect(await answer(get("/api/v1/meetings/series-view?cursor=forged.cursor"))).toEqual({ statusCode: 400, error: "Invalid Series view cursor" });
    expect(await answer(get("/api/v1/today?date=10-10-2026"))).toEqual({ statusCode: 400, error: "date must be YYYY-MM-DD" });
    expect(await answer(get("/api/v1/today/panels?date=2026-10-1"))).toEqual({ statusCode: 400, error: "date must be YYYY-MM-DD" });
    expect(await answer(send("POST", "/api/v1/focus/replan", {}))).toEqual({ statusCode: 400, error: "date (YYYY-MM-DD) is required" });
    expect(await answer(send("POST", "/api/v1/focus/overrides", { date: "tomorrow" }))).toEqual({ statusCode: 400, error: "date (YYYY-MM-DD) is required" });

    expect(await answer(send("PUT", `/api/v1/people/${selfId}/external`, { isExternal: true }))).toEqual({ statusCode: 400, error: "expectedHash is required" });
    expect(await answer(send("POST", `/api/v1/people/${selfId}/reviewed`))).toEqual({ statusCode: 400, error: "expectedHash is required" });
    expect(await answer(send("POST", `/api/v1/meetings/${taskId}/enrichment/gave-up`))).toEqual({ statusCode: 400, error: "expectedHash is required" });
    expect(await answer(send("PATCH", `/api/v1/notes/${taskId}`, { changes: {} }))).toEqual({ statusCode: 400, error: "expectedHash is required to edit a note" });
    expect(await answer(send("POST", `/api/v1/notes/${taskId}/restore`))).toEqual({ statusCode: 400, error: "expectedHash is required to restore a note" });
    expect(await answer(send("DELETE", `/api/v1/notes/${taskId}`))).toEqual({ statusCode: 400, error: "expectedHash is required to delete a note" });
    expect(await answer(send("DELETE", `/api/v1/notes/${taskId}/permanent`, { expectedHash: "" }))).toEqual({ statusCode: 400, error: "expectedHash is required to delete a note permanently" });
    expect(await answer(send("POST", `/api/v1/objects/${taskId}/sensitivity`, { sensitivity: "restricted" }))).toEqual({ statusCode: 400, error: "sensitivity and expectedHash are required" });
    expect(await answer(send("POST", `/api/v1/objects/${taskId}/history/restore`, { versionPath: "x" }))).toEqual({ statusCode: 400, error: "versionPath and expectedHash are required" });
    for (const url of [`/api/v1/decisions/${taskId}/supersede`, `/api/v1/open-points/${taskId}/resolve`]) expect(await answer(send("POST", url, { fields: {} }))).toEqual({ statusCode: 400, error: "fields and expectedHash are required" });
    expect(await answer(send("PATCH", `/api/v1/decisions/${taskId}`, { fields: {} }))).toEqual({ statusCode: 400, error: "fields and expectedHash are required" });
  });
});

describe("background work and the device lease (ADR 0015)", () => {
  const dropDraft = async (root: string) => {
    const target = path.join(root, "_inbox", "drafts", "task.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, draft);
    const past = new Date(Date.now() - 60_000);
    await utimes(target, past, past);
  };
  const quick = { timing: { heartbeatMs: 3_600_000, reconcileDelayMs: 20, adoptionSweepMs: 50, adoptionDebounceMs: 20 } };

  it("GIVEN another device holds the lease THEN adoption and external-edit audits write nothing; after Take back they do", async () => {
    const { root, start, get, send } = await api(quick);
    await start();
    await new FilesystemSessionStore(root, "laptop").takeOver();
    expect((await get("/api/v1/health")).json().session).toMatchObject({ writeAllowed: false, activeDeviceId: "laptop" });

    await dropDraft(root);
    await writeFile(path.join(root, "tasks/task.md"), task("Edited in Obsidian"));
    // The watcher still refreshes the index (read-only), but nothing is adopted or audited.
    await vi.waitFor(async () => expect((await tasks(get)).some((object) => object.frontmatter.title === "Edited in Obsidian")).toBe(true), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = await tasks(get);
    expect(before.filter((object) => object.frontmatter.type === "task")).toHaveLength(1);
    expect(before.filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.actor_type === "external")).toHaveLength(0);

    expect((await send("POST", "/api/v1/session/take-over")).json()).toMatchObject({ writeAllowed: true, activeDeviceId: "desk-mac" });
    await vi.waitFor(async () => expect((await tasks(get)).filter((object) => object.frontmatter.type === "task").map((object) => object.frontmatter.title)).toContain("Send Joel the sizing deck"), { timeout: 5_000 });
  });

  it("GIVEN this device holds the lease THEN an external edit is audited", async () => {
    const { root, start, get } = await api(quick);
    await start();
    await writeFile(path.join(root, "tasks/task.md"), task("Edited in Obsidian"));
    await vi.waitFor(async () => expect((await tasks(get)).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.actor_type === "external")).toHaveLength(1), { timeout: 5_000 });
  });

  it("the heartbeat runs the idle check: without user activity the lease is released", async () => {
    const { start, get } = await api({ idleReleaseMs: 50, timing: { ...quick.timing, heartbeatMs: 20 } });
    await start();
    await vi.waitFor(async () => expect((await get("/api/v1/health")).json().session).toMatchObject({ writeAllowed: false, releasedAfterIdle: true }), { timeout: 5_000 });
  });

  const snapshots = async (backupRoot: string) => (await readdir(backupRoot).catch(() => [] as string[])).filter((name) => !name.startsWith("."));

  it("background work starts only once the server is listening", async () => {
    const { backupRoot, start } = await api(quick);
    let seenAtListen: string[] | undefined;
    // While listening is under way, the start backup has not been asked for yet; once it has, the backup follows.
    await start(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); seenAtListen = await snapshots(backupRoot); });
    expect(seenAtListen).toEqual([]);
    await vi.waitFor(async () => expect(await snapshots(backupRoot)).not.toEqual([]), { timeout: 5_000 });
  });

  it("GIVEN listening fails THEN start rethrows, no background work starts and the lease is released", async () => {
    const { root, backupRoot, start } = await api(quick);
    await expect(start(async () => { throw new Error("port 4310 in use"); })).rejects.toThrow("port 4310 in use");
    await dropDraft(root);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await snapshots(backupRoot)).toEqual([]);
    expect((await readdir(path.join(root, "tasks"))).sort()).toEqual(["task.md"]);
    expect(await new FilesystemSessionStore(root, "laptop").start()).toMatchObject({ writeAllowed: true, activeDeviceId: "laptop" });
  });
});
