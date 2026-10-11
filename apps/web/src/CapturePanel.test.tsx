// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { CapturePanel, type CaptureTask } from "./CapturePanel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const savedTask = (id = "0199b4d6-a708-7000-8000-000000000131"): LifeObject => ({
  frontmatter: { id, title: "Call Marie", type: "task", status: "Inbox", revision: 1, created_at: "2026-10-11T09:00:00Z", updated_at: "2026-10-11T09:00:00Z" },
  body: "# Call Marie\n",
  relativePath: "tasks/call-marie.md",
  contentHash: "capture-hash"
});

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const textarea = () => document.querySelector("textarea[placeholder='What needs to be done?']") as HTMLTextAreaElement;
const button = (name: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name) as HTMLButtonElement;
const change = (control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
});

describe("CapturePanel", () => {
  it("starts focused and simple, then reveals optional defaults", async () => {
    act(() => root.render(<CapturePanel projects={[{ id: "project-1", title: "Launch" }]} owners={[{ id: "self-1", title: "Rahul" }]} selfId="self-1" readOnly={false} onSave={vi.fn()} onViewTask={vi.fn()} />));
    expect(document.activeElement).toBe(textarea());
    expect(document.querySelector("input[type='date']")).toBeNull();

    act(() => button("Optional details").click());
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe("");
    expect([...document.querySelectorAll("select")].map((item) => item.value)).toEqual(["", "self-1", "normal"]);
  });

  it("keeps Enter as a line break and saves with Cmd/Ctrl+Enter through the public form", async () => {
    const onSave = vi.fn(async (_task: CaptureTask) => savedTask());
    const onViewTask = vi.fn();
    act(() => root.render(<CapturePanel projects={[]} owners={[]} selfId="self-1" readOnly={false} onSave={onSave} onViewTask={onViewTask} />));
    change(textarea(), "Call Marie\nBring the revised figures");

    act(() => textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));

    expect(onSave).toHaveBeenCalledWith({ text: "Call Marie\nBring the revised figures", primaryProjectId: undefined, dueOn: undefined, ownerPersonId: "self-1", sensitivity: "normal" });
    expect(textarea().value).toBe("");
    expect(document.body.textContent).toContain("Task saved");
    act(() => button("View task").click());
    expect(onViewTask).toHaveBeenCalledWith("0199b4d6-a708-7000-8000-000000000131");
  });

  it("keeps a device-local draft across close/reopen and while read-only", async () => {
    const onSave = vi.fn(async () => savedTask());
    const render = (readOnly: boolean) => <CapturePanel projects={[]} owners={[]} selfId="self-1" readOnly={readOnly} onSave={onSave} onViewTask={vi.fn()} />;
    act(() => root.render(render(true)));
    change(textarea(), "Draft while the other Mac is active");
    expect(button("Save").disabled).toBe(true);
    expect(document.body.textContent).toContain("Keep editing here");

    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(render(false)));
    expect(textarea().value).toBe("Draft while the other Mac is active");
    expect(button("Save").disabled).toBe(false);
    await act(async () => button("Save").click());
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("persists optional context and reports a failed save without losing the draft", async () => {
    const onSave = vi.fn(async () => { throw new Error("Write access changed"); });
    act(() => root.render(<CapturePanel projects={[{ id: "project-1", title: "Launch" }]} owners={[{ id: "self-1", title: "Rahul" }, { id: "person-2", title: "Marie" }]} selfId="self-1" readOnly={false} onSave={onSave} onViewTask={vi.fn()} />));
    change(textarea(), "Send the deck");
    act(() => button("Optional details").click());
    const selects = [...document.querySelectorAll("select")] as HTMLSelectElement[];
    change(selects[0]!, "project-1");
    change(selects[1]!, "person-2");
    change(selects[2]!, "restricted");
    change(document.querySelector("input[type='date']") as HTMLInputElement, "2026-10-20");
    await act(async () => button("Save").click());

    expect(document.querySelector("[role='alert']")?.textContent).toBe("Write access changed");
    expect(textarea().value).toBe("Send the deck");
    expect(onSave).toHaveBeenCalledWith({ text: "Send the deck", primaryProjectId: "project-1", dueOn: "2026-10-20", ownerPersonId: "person-2", sensitivity: "restricted" });
  });
});
