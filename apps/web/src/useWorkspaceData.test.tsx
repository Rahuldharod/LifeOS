// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { fakeApi } from "./fakeApi.js";
import { useWorkspaceData, type WorkspaceData } from "./useWorkspaceData.js";

// The workspace-data seam: what App reads and calls, driven by a fake API.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

const note = (id: string, updatedAt = "2026-10-05T08:00:00.000Z") => ({ frontmatter: { id, type: "note", title: id, updated_at: updatedAt }, relativePath: `${id}.md`, contentHash: `h-${id}`, body: "" });

// Every endpoint answers by default; a test overrides one with data or an Error to throw.
const answers = (over: Record<string, unknown>): Record<string, unknown> => ({
  "GET /api/v1/today": { tasks: [], overdue: [], dueToday: [], upcoming: [], waiting: [], topThree: [], reviewCount: 3 },
  "GET /api/v1/tasks": [note("task-1")],
  "GET /api/v1/projects": [{ project: note("project-1") }],
  "GET /api/v1/review-items": [note("review-1")],
  "GET /api/v1/health": { session: { writeAllowed: true } },
  "GET /api/v1/backups": [{ id: "b1" }],
  "GET /api/v1/knowledge": [note("knowledge-1")],
  "GET /api/v1/rollups/:type:client": [{ entity: note("client-1") }],
  "GET /api/v1/rollups/:type:product": [{ entity: note("product-1") }],
  "GET /api/v1/rollups/:type:person": [{ entity: note("person-1") }],
  "GET /api/v1/objects": [{ id: "o1" }],
  "GET /api/v1/notes": [note("note-1")],
  "GET /api/v1/notes:deleted": [note("gone-1")],
  "GET /api/v1/inbox/drafts": { awaiting: 2, drafts: 1, patches: 0, failed: [] },
  "GET /api/v1/inbox/patches": [{ id: "p1" }],
  "GET /api/v1/people/labels": [{ id: "person-1", label: "Ana" }],
  "GET /api/v1/settings/connections": { calendar: { configured: true } },
  "POST /api/v1/settings/connections/retry": { calendar: { configured: true } },
  "GET /api/v1/enrichment": { proposedGaveUp: [{ id: "e1" }], staleWorkOrders: [] },
  "GET /api/v1/today/panels": { calendar: "ok" },
  ...over
});

async function setup(over: Record<string, unknown> = {}) {
  const table = answers(over);
  const calls: string[] = [];
  let data: WorkspaceData | undefined;
  const call = fakeApi((endpoint, input) => {
    const key = endpoint === "GET /api/v1/rollups/:type" ? `${endpoint}:${input?.params?.type}`
      : endpoint === "GET /api/v1/notes" && (input?.query as { state?: string } | undefined)?.state === "deleted" ? `${endpoint}:deleted` : endpoint;
    calls.push(key);
    if (!(key in table)) throw new Error(`unexpected ${key}`);
    const value = table[key];
    if (value instanceof Error) throw value;
    return value;
  });
  function Harness() {
    data = useWorkspaceData({ displayTimeZone: "Europe/Paris", call });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Harness />));
  const settle = () => act(async () => { for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  let refused: unknown;
  const refresh = async () => { refused = undefined; await act(async () => { try { await data!.refresh(); } catch (error) { refused = error; } }); await settle(); };
  return { data: () => data!, calls, refresh, refused: () => refused };
}

describe("useWorkspaceData", () => {
  it("starts empty, then refresh() fills every collection", async () => {
    const page = await setup();
    expect(page.data().tasks).toEqual([]);
    expect(page.data().today.reviewCount).toBe(0);
    await page.refresh();
    expect(page.data().today.reviewCount).toBe(3);
    expect(page.data().tasks.map((o) => o.frontmatter.id)).toEqual(["task-1"]);
    expect(page.data().projects).toHaveLength(1);
    expect(page.data().reviews).toHaveLength(1);
    expect(page.data().health?.session.writeAllowed).toBe(true);
    expect(page.data().backups).toHaveLength(1);
    expect(page.data().knowledge).toHaveLength(1);
    expect([page.data().clients.length, page.data().products.length, page.data().people.length]).toEqual([1, 1, 1]);
    expect(page.data().objectLinks).toHaveLength(1);
    expect(page.data().notes.map((o) => o.frontmatter.id)).toEqual(["note-1"]);
    expect(page.data().deletedNotes.map((o) => o.frontmatter.id)).toEqual(["gone-1"]);
    expect(page.data().inboxDrafts.awaiting).toBe(2);
    expect(page.data().appliedPatches).toHaveLength(1);
    expect(page.data().personLabels).toEqual([{ id: "person-1", label: "Ana" }]);
  });

  it("loads connections, enrichment and Today panels on their own after the main load", async () => {
    const page = await setup();
    await page.refresh();
    expect(page.data().connections?.settings).toBeDefined();
    expect(page.data().enrichment.proposedGaveUp).toHaveLength(1);
    expect(page.data().todayPanels).toEqual({ calendar: "ok" });
  });

  it("a failure in connections, enrichment or Today panels never blanks the rest", async () => {
    const page = await setup({
      "GET /api/v1/settings/connections": new Error("keychain"),
      "GET /api/v1/enrichment": new Error("down"),
      "GET /api/v1/today/panels": new Error("calendar wait")
    });
    await page.refresh();
    expect(page.refused()).toBeUndefined();
    expect(page.data().tasks).toHaveLength(1);
    expect(page.data().notes).toHaveLength(1);
    expect(page.data().enrichment.proposedGaveUp).toEqual([]);
    expect(page.data().todayPanels).toBeUndefined();
    expect(page.data().connections?.error).toBeDefined();
  });

  it("person labels fall back to an empty list when they fail", async () => {
    const page = await setup({ "GET /api/v1/people/labels": new Error("nope") });
    await page.refresh();
    expect(page.refused()).toBeUndefined();
    expect(page.data().personLabels).toEqual([]);
    expect(page.data().people).toHaveLength(1);
  });

  it("refresh() rejects when a main list fails, so the caller can show the error", async () => {
    const page = await setup({ "GET /api/v1/tasks": new Error("disk gone") });
    await page.refresh();
    expect((page.refused() as Error).message).toBe("disk gone");
    expect(page.data().notes).toEqual([]);
  });

  it("refreshTodayPanels() reloads just the panels", async () => {
    const page = await setup();
    await act(async () => { await page.data().refreshTodayPanels(); });
    expect(page.data().todayPanels).toEqual({ calendar: "ok" });
    expect(page.calls).toEqual(["GET /api/v1/today/panels"]);
  });

  it("refreshTodayPanels() does not throw when the panels fail", async () => {
    const page = await setup({ "GET /api/v1/today/panels": new Error("x") });
    await act(async () => { await page.data().refreshTodayPanels(); });
    expect(page.data().todayPanels).toBeUndefined();
  });

  it("refreshConnections({ retry }) asks the retry endpoint; without it, the plain one", async () => {
    const page = await setup();
    await act(async () => { await page.data().refreshConnections(); });
    await act(async () => { await page.data().refreshConnections({ retry: true }); });
    expect(page.calls).toEqual(["GET /api/v1/settings/connections", "POST /api/v1/settings/connections/retry"]);
  });

  it("refreshNotes() and refreshNoteLists() fetch fresh, store and return them", async () => {
    const page = await setup();
    let open: unknown;
    await act(async () => { open = await page.data().refreshNotes(); });
    expect((open as unknown[]).length).toBe(1);
    expect(page.calls).toEqual(["GET /api/v1/notes"]);
    await act(async () => { await page.data().refreshNoteLists(); });
    expect(page.data().deletedNotes).toHaveLength(1);
  });

  it("refreshObjectLinks() fetches fresh, stores and returns the object list", async () => {
    const page = await setup();
    let objects: unknown;
    await act(async () => { objects = await page.data().refreshObjectLinks(); });
    expect(objects).toEqual([{ id: "o1" }]);
    expect(page.data().objectLinks).toEqual([{ id: "o1" }]);
  });

  it("updateNotes, updateToday and updateHealth patch in place", async () => {
    const page = await setup();
    await page.refresh();
    act(() => page.data().updateNotes((current) => [...current, note("note-2") as never]));
    expect(page.data().notes).toHaveLength(2);
    act(() => page.data().updateToday((current) => ({ ...current, reviewCount: 9 })));
    expect(page.data().today.reviewCount).toBe(9);
    act(() => page.data().updateHealth((current) => current && { ...current, session: { ...current.session, writeAllowed: false } }));
    expect(page.data().health?.session.writeAllowed).toBe(false);
  });
});
