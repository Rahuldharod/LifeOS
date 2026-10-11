// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { TaskWorkspace, createStructuredEditorGuard } from "./TaskWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const object = (id: string, title: string, fields: Record<string, unknown> = {}): LifeObject => ({
  relativePath: `tasks/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}`,
  frontmatter: { id, type: "task", schema_version: 1, revision: 1, title, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", status: "Next", owner_person_id: "self", ...fields }
});

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; window.history.replaceState({}, "", "/"); sessionStorage.clear(); root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function click(name: string) {
  const control = [...document.querySelectorAll("button, input")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLElement;
  await act(async () => control.click());
}

async function choose(label: string, value: string) {
  const control = document.querySelector(`select[aria-label='${label}']`) as HTMLSelectElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("TaskWorkspace", () => {
  it("filters the task list and keeps completion separate from opening detail", async () => {
    const open = vi.fn(); const complete = vi.fn(async () => true);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[object("mine", "Prepare proposal", { priority: "High", due_on: "2026-10-11" }), object("waiting", "Confirm venue", { status: "Waiting", waiting_for_person_id: "sam" }), object("theirs", "Their task", { owner_person_id: "other" })]} linkables={[]} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={open} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={complete} onRestored={async () => undefined} />));

    expect(document.body.textContent).toContain("Prepare proposal");
    await click("Waiting on others");
    expect(document.body.textContent).toContain("Confirm venue");
    await click("Other people's tasks");
    expect(document.body.textContent).toContain("Their task");
    expect(document.body.textContent).not.toContain("Confirm venue");
    await click("Waiting on others");
    await click("Open task: Confirm venue");
    expect(open).toHaveBeenCalledWith("waiting");
    await click("My Tasks");
    await click("Complete Prepare proposal");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ frontmatter: expect.objectContaining({ id: "mine" }) }), true);
  });

  it("hides finished work by default and reveals it through the status filter", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const tasks = [object("active", "Active work"), object("done", "Finished work", { status: "Done", completed_at: "2026-10-10T08:00:00Z" }), object("cancelled", "Cancelled work", { status: "Cancelled", cancelled_at: "2026-10-10T08:00:00Z" })];
    await act(async () => root!.render(<TaskWorkspace tasks={tasks} linkables={tasks} labels={new Map()} projects={[]} selfId="self" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    expect(document.body.textContent).toContain("Active work");
    expect(document.body.textContent).not.toContain("Finished work");
    await click("Advanced");
    await choose("Filter by status", "Done");
    expect(document.body.textContent).toContain("Finished work");
    expect(document.body.textContent).not.toContain("Active work");
  });

  it("offers exact due periods and stores view, filters and sort in the URL", async () => {
    window.history.replaceState({}, "", "/tasks?taskView=others&taskDue=later&taskSort=title");
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const tasks = [object("soon", "Soon", { owner_person_id: "other", due_on: "2026-10-15" }), object("later", "Later", { owner_person_id: "other", due_on: "2026-10-20" })];
    await act(async () => root!.render(<TaskWorkspace tasks={tasks} linkables={tasks} labels={new Map()} projects={[]} selfId="self" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    expect(document.body.textContent).toContain("Later");
    expect(document.body.textContent).not.toContain("Soon");
    const due = document.querySelector("select[aria-label='Filter by due period']") as HTMLSelectElement;
    expect([...due.options].map((option) => option.textContent)).toEqual(["Any time", "Overdue", "Today", "Next 7 days", "Later", "No due date"]);
    await choose("Filter by due period", "next7");
    expect(window.location.search).toContain("taskDue=next7");
    expect(document.body.textContent).toContain("Soon");
  });

  it("offers one-step Undo after completing any visible task", async () => {
    const complete = vi.fn(async () => true);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const task = object("theirs", "Delegated item", { owner_person_id: "other" });
    await act(async () => root!.render(<TaskWorkspace tasks={[task]} linkables={[task]} labels={new Map()} projects={[]} selfId="self" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={complete} onRestored={async () => undefined} />));
    await click("Other people's tasks");
    await click("Complete Delegated item");
    expect(document.querySelector("[role='status']")?.textContent).toContain("Task completed");
    await click("Undo");
    expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ frontmatter: expect.objectContaining({ id: "theirs" }) }), false);
  });

  it("uses the approved default order for each task view", async () => {
    const tasks = [
      object("later", "Mine later", { due_on: "2026-10-13", priority: "High" }),
      object("overdue-low", "Mine overdue low", { due_on: "2026-10-10", priority: "Low" }),
      object("overdue-high", "Mine overdue high", { due_on: "2026-10-10", priority: "High" }),
      object("waiting-new", "Waiting newer", { status: "Waiting", waiting_for_person_id: "sam", waiting_since: "2026-10-09T08:00:00Z" }),
      object("waiting-old", "Waiting older", { status: "Waiting", waiting_for_person_id: "sam", waiting_since: "2026-10-01T08:00:00Z" }),
      object("zoe", "Zoe item", { owner_person_id: "zoe", due_on: "2026-10-12" }),
      object("anna", "Anna item", { owner_person_id: "anna", due_on: "2026-10-20" })
    ];
    const labels = new Map([
      ["zoe", { id: "zoe", name: "Zoe", label: "Zoe", isExternal: false, externalSource: "stored" as const }],
      ["anna", { id: "anna", name: "Anna", label: "Anna", isExternal: false, externalSource: "stored" as const }]
    ]);
    const rowTitles = () => [...document.querySelectorAll(".task-row strong")].map((node) => node.textContent);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={tasks} linkables={tasks} labels={labels} projects={[]} selfId="self" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    expect(rowTitles().slice(0, 3)).toEqual(["Mine overdue high", "Mine overdue low", "Mine later"]);
    await click("Waiting on others");
    expect(rowTitles()).toEqual(["Waiting older", "Waiting newer"]);
    await click("Other people's tasks");
    expect(rowTitles()).toEqual(["Anna item", "Zoe item"]);
  });

  it("keeps failed-save input and explains that it can be retried", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[object("mine", "Original")]} linkables={[]} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => false} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    const title = document.querySelector("input[aria-label='Task title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Unsaved title"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    await click("Save");
    expect((document.querySelector("input[aria-label='Task title']") as HTMLInputElement).value).toBe("Unsaved title");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("still here");
  });

  it("opens Advanced filters and New Task in the shared detail form", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[object("mine", "Prepare proposal")]} linkables={[]} labels={new Map()} projects={[{ id: "p1", title: "Autumn launch" }]} selfId="self" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    await click("Advanced");
    expect(document.querySelector("select[aria-label='Filter by status']")).toBeTruthy();
    expect(document.body.textContent).toContain("Clear filters");
    await click("New Task");
    expect((document.querySelector("input[aria-label='Task title']") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).toContain("Not saved yet");
    expect(document.body.textContent).toContain("Save");
    expect(document.body.textContent).toContain("Cancel");
  });

  it("offers Save, Discard and Stay before leaving dirty structured work", async () => {
    const guard = createStructuredEditorGuard(); const save = vi.fn(async () => true);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[object("mine", "Prepare proposal")]} linkables={[]} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={guard} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={save} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    const title = document.querySelector("input[aria-label='Task title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Changed"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
    let result: boolean | undefined;
    await act(async () => { void guard.saveNow().then((value) => { result = value; }); });
    expect(document.querySelector("[role='dialog']")?.textContent).toMatch(/SaveDiscardStay/);
    await click("Stay");
    await act(async () => undefined);
    expect(result).toBe(false);
    expect(save).not.toHaveBeenCalled();

    result = undefined;
    await act(async () => { void guard.saveNow().then((value) => { result = value; }); });
    await click("Discard");
    expect(result).toBe(true);
    expect((document.querySelector("input[aria-label='Task title']") as HTMLInputElement).value).toBe("Prepare proposal");

    const currentTitle = document.querySelector("input[aria-label='Task title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(currentTitle, "Saved change"); currentTitle.dispatchEvent(new Event("input", { bubbles: true })); });
    result = undefined;
    await act(async () => { void guard.saveNow().then((value) => { result = value; }); });
    await act(async () => (document.querySelector("[role='dialog'] button") as HTMLButtonElement).click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(result).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps record utilities in More and confirms deletion", async () => {
    const remove = vi.fn(async () => true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[object("mine", "Prepare proposal")]} linkables={[]} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={remove} onComplete={async () => true} onRestored={async () => undefined} />));
    await act(async () => (document.querySelector("summary") as HTMLElement).click());
    expect(document.body.textContent).toContain("History");
    expect(document.body.textContent).toContain("Copy link");
    await click("Delete task");
    expect(remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click("Delete task");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("uses the caller's timezone date boundary for due filters", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[object("old", "Yesterday", { due_on: "2026-10-11" }), object("today", "Today here", { due_on: "2026-10-12" })]} linkables={[]} labels={new Map()} projects={[]} selfId="self" today="2026-10-12" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    await click("Advanced");
    await choose("Filter by due period", "today");
    expect(document.body.textContent).toContain("Today here");
    expect(document.body.textContent).not.toContain("Yesterday");
  });

  it("preserves established task relationship and envelope fields", async () => {
    const task = object("mine", "Prepare proposal", { primary_client_id: "client", primary_product_id: "product", dependency_ids: ["blocker"], area: "work" });
    const linkables = [task, object("blocker", "Confirm scope"), { ...object("client", "Acme"), frontmatter: { ...object("client", "Acme").frontmatter, type: "client" } }, { ...object("product", "Rewards"), frontmatter: { ...object("product", "Rewards").frontmatter, type: "product" } }];
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[task]} linkables={linkables} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    expect(document.body.textContent).toContain("Client");
    expect(document.body.textContent).toContain("Product");
    expect(document.body.textContent).toContain("Depends on");
    expect(document.body.textContent).toContain("Area");
  });

  it("guards completion while another task has dirty edits", async () => {
    const complete = vi.fn(async () => true);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const tasks = [object("mine", "Prepare proposal"), object("other", "Confirm venue")];
    await act(async () => root!.render(<TaskWorkspace tasks={tasks} linkables={tasks} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => true} onDelete={async () => true} onComplete={complete} onRestored={async () => undefined} />));
    const title = document.querySelector("input[aria-label='Task title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Changed"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    await click("Complete Confirm venue");
    expect(complete).not.toHaveBeenCalled();
    expect(document.querySelector("[role='dialog']")).toBeTruthy();
    await click("Stay");
    expect(complete).not.toHaveBeenCalled();
    await click("Complete Confirm venue");
    await click("Discard");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ frontmatter: expect.objectContaining({ id: "other" }) }), true);
  });

  it("re-resolves a task after Save before completing it", async () => {
    const original = object("mine", "Prepare proposal"); const refreshed = { ...object("mine", "Changed", { revision: 2 }), contentHash: "fresh-hash" };
    const complete = vi.fn(async () => true); const guard = createStructuredEditorGuard();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const render = (tasks: LifeObject[]) => root!.render(<TaskWorkspace tasks={tasks} linkables={tasks} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={guard} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={async () => { await act(async () => render([refreshed])); return true; }} onDelete={async () => true} onComplete={complete} onRestored={async () => undefined} />);
    await act(async () => render([original]));
    const title = document.querySelector("input[aria-label='Task title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Changed"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    await click("Complete Prepare proposal");
    await act(async () => (document.querySelector("[role='dialog'] .primary") as HTMLButtonElement).click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ contentHash: "fresh-hash" }), true);
  });

  it("sends wire-safe nulls when optional fields are cleared", async () => {
    const save = vi.fn(async () => true);
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<TaskWorkspace tasks={[object("mine", "Prepare proposal", { due_on: "2026-10-20", priority: "High" })]} linkables={[]} labels={new Map()} projects={[]} selfId="self" selectedId="mine" today="2026-10-11" guard={createStructuredEditorGuard()} busy={false} readOnly={false} run={async () => true} onOpen={vi.fn()} onCloseDetail={vi.fn()} onCreate={async () => undefined} onSave={save} onDelete={async () => true} onComplete={async () => true} onRestored={async () => undefined} />));
    const due = document.querySelector("input[type='date']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(due, ""); due.dispatchEvent(new Event("input", { bubbles: true })); });
    await click("Save");
    expect(save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ due_on: null, primary_project_id: null }));
  });

  it("keeps saved feedback after refreshed data and exposes the narrow detail state", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, media: "(max-width: 760px)", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
    const task = object("mine", "Prepare proposal"); const save = vi.fn(async () => true);
    let selectedId: string | undefined = "mine";
    const props = { linkables: [task], labels: new Map(), projects: [], selfId: "self", today: "2026-10-11", guard: createStructuredEditorGuard(), busy: false, readOnly: false, run: async () => true, onOpen: vi.fn(), onCreate: async () => undefined, onSave: save, onDelete: async () => true, onComplete: async () => true, onRestored: async () => undefined };
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const render = (tasks: LifeObject[]) => root!.render(<TaskWorkspace tasks={tasks} selectedId={selectedId} onCloseDetail={() => { selectedId = undefined; render(tasks); }} {...props} />);
    await act(async () => render([task]));
    expect(document.querySelector(".task-workspace.detail-open")).toBeTruthy();
    expect((document.querySelector("[aria-label='Tasks list']") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("[aria-label='Task detail']") as HTMLElement).hidden).toBe(false);
    expect(document.body.textContent).toContain("Back to tasks");
    const title = document.querySelector("input[aria-label='Task title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Saved title"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    await click("Save");
    await act(async () => render([object("mine", "Saved title", { revision: 2 })]));
    expect(document.querySelector(".sticky-record-actions [role='status']")?.textContent).toBe("Saved");
    await click("Back to tasks");
    expect(selectedId).toBeUndefined();
    expect((document.querySelector("[aria-label='Tasks list']") as HTMLElement).hidden).toBe(false);
    expect((document.querySelector("[aria-label='Task detail']") as HTMLElement).hidden).toBe(true);
  });
});
