// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { useGuardedNavigation, type GuardedNavigation } from "./useGuardedNavigation.js";

// PB-027: the router seam. Back/Forward (a POP the app did not start) is held until the open note
// saves; a failed save keeps the user on the page.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fake = { dirty: boolean; conflict: boolean; saves: boolean; saved: number };
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

async function setup(initial: string[]) {
  const editor: Fake = { dirty: false, conflict: false, saves: true, saved: 0 };
  const messages: string[] = [];
  let navigation: GuardedNavigation | undefined;
  function Harness() {
    navigation = useGuardedNavigation({
      // Getters stand in for the re-render that a real edit causes.
      editors: [{ get dirty() { return editor.dirty; }, get conflict() { return editor.conflict; }, saveNow: async () => { editor.saved += 1; if (editor.saves) editor.dirty = false; return editor.saves; } }],
      readOnly: false,
      onLeaveFailed: (message) => messages.push(message)
    });
    return null;
  }
  const router = createMemoryRouter([{ path: "*", element: <Harness /> }], { initialEntries: initial, initialIndex: initial.length - 1 });
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<RouterProvider router={router} />));
  const settle = () => act(async () => { for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { editor, messages, router, nav: () => navigation!, settle, path: () => `${router.state.location.pathname}${router.state.location.hash}` };
}

describe("useGuardedNavigation (PB-027)", () => {
  it("does not drop a move back to the rendered page while another move is still landing (PB-035)", async () => {
    const page = await setup(["/inbox/a"]);
    await act(async () => { page.nav().follow("/inbox/b"); });
    await page.settle();
    // Two quick moves before the next render: the second goes back to the page still on screen.
    act(() => { page.nav().follow("/inbox/c"); page.nav().follow("/inbox/b"); });
    await page.settle();
    expect(page.path()).toBe("/inbox/b");
    // A move to the page we are already on is still skipped (no duplicate history entry).
    const before = page.router.state.historyAction;
    act(() => { page.nav().follow("/inbox/b"); });
    await page.settle();
    expect(page.router.state.historyAction).toBe(before);
  });

  it("saves unsaved edits before an in-app move", async () => {
    const page = await setup(["/notes/a"]);
    page.editor.dirty = true;
    await act(async () => { await page.nav().go("/notes/b"); });
    await page.settle();
    expect(page.editor.saved).toBe(1);
    expect(page.path()).toBe("/notes/b");
  });

  it("does not move when that save fails", async () => {
    const page = await setup(["/notes/a"]);
    Object.assign(page.editor, { dirty: true, saves: false });
    await act(async () => { expect(await page.nav().go("/notes/b")).toBe(false); });
    expect(page.path()).toBe("/notes/a");
    expect(page.messages).toHaveLength(1);
  });

  it("holds Back until the note saves, then goes back", async () => {
    const page = await setup(["/notes/a", "/calendar/2026-10-09/m"]);
    page.editor.dirty = true;
    await act(async () => { await page.router.navigate(-1); });
    await page.settle();
    expect(page.editor.saved).toBe(1);
    expect(page.path()).toBe("/notes/a");
  });

  it("stays on the page when the save on Back fails", async () => {
    const page = await setup(["/notes/a", "/calendar/2026-10-09/m"]);
    Object.assign(page.editor, { dirty: true, saves: false });
    await act(async () => { await page.router.navigate(-1); });
    await page.settle();
    expect(page.path()).toBe("/calendar/2026-10-09/m");
    expect(page.messages).toHaveLength(1);
  });

  it("lets Back go straight through when nothing is unsaved", async () => {
    const page = await setup(["/notes/a", "/notes/b"]);
    await act(async () => { await page.router.navigate(-1); });
    await page.settle();
    expect(page.editor.saved).toBe(0);
    expect(page.path()).toBe("/notes/a");
  });

  it("follows a URL the app already saved for without saving again", async () => {
    const page = await setup(["/calendar/2026-10-09"]);
    page.editor.dirty = true;
    act(() => page.nav().follow("/calendar/2026-10-09/m", { replace: true }));
    await page.settle();
    expect(page.editor.saved).toBe(0);
    expect(page.path()).toBe("/calendar/2026-10-09/m");
  });

  it("follows a section anchor on the current item", async () => {
    const page = await setup(["/notes/a#occurrence-new"]);
    act(() => page.nav().follow("/notes/a#occurrence-old", { replace: true }));
    await page.settle();
    expect(page.path()).toBe("/notes/a#occurrence-old");
  });
});
