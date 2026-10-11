// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { GlobalSearchOverlay } from "./GlobalSearchOverlay.js";
import { routePath } from "./routes.js";
import { useGuardedNavigation } from "./useGuardedNavigation.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; });

const task: LifeObject = {
  frontmatter: { id: "task-1", type: "task", title: "Guarded result", revision: 1, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
  body: "", relativePath: "tasks/task-1.md", contentHash: "hash"
};

describe("Global Search guarded navigation", () => {
  it("keeps the current route when an open editor cannot save", async () => {
    const editor = { dirty: true, conflict: false, saveNow: async () => false };
    let close = false;
    function Harness() {
      const guarded = useGuardedNavigation({ editors: [editor], readOnly: false, onLeaveFailed: () => undefined });
      return <GlobalSearchOverlay open={!close} tasks={[task]} notes={[]} onClose={() => { close = true; }} onOpen={(route) => { void guarded.go(routePath(route)); }} />;
    }
    const router = createMemoryRouter([{ path: "*", element: <Harness /> }], { initialEntries: ["/notes/current"] });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    const input = document.querySelector<HTMLInputElement>("input[aria-label='Search LifeOS']")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Guarded"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => (document.querySelector(".global-search-result") as HTMLButtonElement).click());
    expect(router.state.location.pathname).toBe("/notes/current");
  });
});
