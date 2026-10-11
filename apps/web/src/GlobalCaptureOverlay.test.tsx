// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { ApplicationShell } from "./ApplicationShell.js";
import { CapturePanel, type CaptureRequest } from "./CapturePanel.js";
import { OverlayDialog } from "./OverlayDialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
beforeEach(() => { localStorage.clear(); history.replaceState(null, "", "/notes/current"); });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); });

const task: LifeObject = {
  frontmatter: { id: "task-1", type: "task", title: "Captured", revision: 1, created_at: "2026-10-11T10:00:00Z", updated_at: "2026-10-11T10:00:00Z" },
  body: "Captured", relativePath: "tasks/task-1.md", contentHash: "hash"
};

describe("Global Capture shell integration (#131)", () => {
  it("opens globally, keeps the route, saves, and leaves View task reachable", async () => {
    const save = vi.fn(async (_request: CaptureRequest) => task); const view = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <ApplicationShell activeView="Notes" status="Ready" onNavigate={() => undefined} onSearch={() => undefined} onCapture={() => setOpen(true)}>
        <OverlayDialog open={open} label="Global Capture" onClose={() => setOpen(false)}>
          <button type="button" aria-label="Close Capture" onClick={() => setOpen(false)}>×</button>
          <CapturePanel projects={[]} owners={[]} selfId="self" readOnly={false} onSave={save} onViewTask={view} />
        </OverlayDialog>
      </ApplicationShell>;
    }
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
    const area = document.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(document.activeElement).toBe(area);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Captured task\nwith detail"); area.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ text: "Captured task\nwith detail", ownerPersonId: "self", sensitivity: "normal" }));
    expect(location.pathname).toBe("/notes/current");
    const viewButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "View task") as HTMLButtonElement;
    expect(viewButton).toBeTruthy();
    await act(async () => viewButton.click());
    expect(view).toHaveBeenCalledWith("task-1");
  });
});
