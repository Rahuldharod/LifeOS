// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@lifeos/contracts";
import { InboxWorkspace } from "./InboxWorkspace.js";
import type { UndoResult } from "./inboxModel.js";

// ADR 0025 (#241): after a Review action the toast offers Undo (and Z) and View for 8 seconds; one Undo covers a batch.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review = (id: string, title: string, fields: Record<string, unknown> = {}): ReviewItem => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}`, evidence: {},
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title, created_at: "2026-10-10T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", source_meeting_id: "meeting-1", source_ids: [], proposed_fields: { title }, ...fields }
});
const all = () => [review("a", "Alpha task"), review("b", "Bravo task"), review("l", "Link owner", { review_type: "link-resolution" }), review("m", "Merge pair", { review_type: "person-merge", target_object_type: "person" })];

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.useRealTimers(); });

type Props = { onUndo?: (ids: string[]) => Promise<UndoResult>; onView?: (id: string) => void; created?: Record<string, string> };

/** The Inbox over state like the app's: a decided item leaves the list; an undone one comes back. */
async function mount({ onUndo, onView, created = { a: "task-a", b: "task-b" } }: Props = {}) {
  const decided: string[] = [];
  function Harness() {
    const [gone, setGone] = useState<Set<string>>(new Set());
    const drop = (ids: string[]) => setGone((current) => new Set([...current, ...ids]));
    return <InboxWorkspace
      reviews={all().filter((item) => !gone.has(item.frontmatter.id))} objects={[]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }}
      busy={false} readOnly={false} displayTimeZone="Europe/Paris"
      onAccept={async (item) => { decided.push(`accepted:${item.frontmatter.id}`); drop([item.frontmatter.id]); return { objectId: created[item.frontmatter.id] }; }}
      onReject={async (item) => { decided.push(`rejected:${item.frontmatter.id}`); drop([item.frontmatter.id]); return true; }}
      onSave={async () => true}
      onUndo={onUndo && (async (ids) => { const result = await onUndo(ids); setGone((current) => new Set([...current].filter((id) => !result.undone.includes(id)))); return result; })}
      onView={onView}
    />;
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Harness />));
  return decided;
}

const press = async (key: string) => act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const toast = () => document.querySelector(".inbox-toast");
const toastButtons = () => [...(toast()?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("data-toast-action"));
const click = async (selector: string) => act(async () => (document.querySelector(selector) as HTMLElement).click());
const tickBox = async (title: string) => act(async () => (document.querySelector(`[aria-label='Select proposal: ${title}']`) as HTMLInputElement).click());
const focusedTitle = () => document.querySelector(".inbox-row.focused .inbox-row-open strong")?.textContent;

describe("the toast after a Review action", () => {
  it("offers Undo and View after an accept, and only Undo after a reject", async () => {
    const view = vi.fn();
    await mount({ onUndo: async (ids) => ({ undone: ids, refused: [] }), onView: view });
    await press("a");
    expect(toast()?.textContent).toContain("Proposal accepted");
    expect(toastButtons()).toEqual(["undo", "view"]);
    await click("[data-toast-action='view']");
    expect(view).toHaveBeenCalledWith("task-a");
    await press("r");
    expect(toast()?.textContent).toContain("Proposal rejected");
    expect(toastButtons()).toEqual(["undo"]);
  });

  it("stays 8 seconds, and a message without actions stays 3", async () => {
    vi.useFakeTimers();
    await mount({ onUndo: async (ids) => ({ undone: ids, refused: [] }) });
    await press("a");
    await act(async () => { vi.advanceTimersByTime(7900); });
    expect(toast()).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(toast()).toBeNull();
  });

  it("keeps the old 3 seconds and shows no buttons when the app gives no way to undo", async () => {
    vi.useFakeTimers();
    await mount();
    await press("a");
    expect(toastButtons()).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(3100); });
    expect(toast()).toBeNull();
  });

  it("shows no Undo for a decision that cannot be undone yet (a merge suggestion)", async () => {
    await mount({ onUndo: async (ids) => ({ undone: ids, refused: [] }) });
    await act(async () => { (document.querySelector("[aria-label='Select proposal: Merge pair']") as HTMLInputElement).click(); });
    await press("r");
    expect(toast()?.textContent).toContain("1 proposal rejected");
    expect(toastButtons()).toEqual([]);
  });
});

describe("Undo", () => {
  it("brings the item back and makes it the Focused item, from the button and from Z", async () => {
    const onUndo = vi.fn(async (ids: string[]) => ({ undone: ids, refused: [] }));
    await mount({ onUndo });
    await press("r"); // Alpha rejected; focus moves to Bravo
    expect(focusedTitle()).toBe("Bravo task");
    await click("[data-toast-action='undo']");
    expect(onUndo).toHaveBeenCalledWith(["a"]);
    expect(focusedTitle()).toBe("Alpha task");
    expect(toast()?.textContent).toContain("1 proposal back in the Inbox");

    await press("a"); await press("z");
    expect(onUndo).toHaveBeenLastCalledWith(["a"]);
    expect(focusedTitle()).toBe("Alpha task");
  });

  it("Z does nothing once the toast is gone", async () => {
    vi.useFakeTimers();
    const onUndo = vi.fn(async (ids: string[]) => ({ undone: ids, refused: [] }));
    await mount({ onUndo });
    await press("r");
    await act(async () => { vi.advanceTimersByTime(8100); });
    await press("z");
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("is refused with the reason and a View of the edited object", async () => {
    const view = vi.fn();
    await mount({ onUndo: async () => ({ undone: [], refused: [{ id: "a", reason: 'Cannot undo: "Alpha task" was changed after it was accepted' }] }), onView: view });
    await press("a"); await press("z");
    expect(toast()?.textContent).toContain('Not undone: Cannot undo: "Alpha task" was changed after it was accepted');
    expect(toastButtons()).toEqual(["view"]);
    await click("[data-toast-action='view']");
    expect(view).toHaveBeenCalledWith("task-a");
  });
});

describe("a bulk action", () => {
  it("rejects without asking, and one Undo undoes the whole batch", async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
    const onUndo = vi.fn(async (ids: string[]) => ({ undone: ids, refused: [] }));
    await mount({ onUndo });
    await tickBox("Alpha task"); await tickBox("Bravo task"); await tickBox("Link owner");
    await press("r");
    expect(confirm).not.toHaveBeenCalled();
    expect(toast()?.textContent).toContain("3 proposals rejected");
    await click("[data-toast-action='undo']");
    expect(onUndo).toHaveBeenCalledWith(["a", "b", "l"]);
    expect(toast()?.textContent).toContain("3 proposals back in the Inbox");
    vi.unstubAllGlobals();
  });

  it("reports the items that were refused", async () => {
    await mount({ onView: vi.fn(), onUndo: async () => ({ undone: ["a"], refused: [{ id: "b", reason: "was changed after it was accepted" }] }) });
    await tickBox("Alpha task"); await tickBox("Bravo task");
    await press("a");
    expect(toastButtons()).toEqual(["undo"]); // two objects, so no single View
    await press("z");
    expect(toast()?.textContent).toContain("1 of 2 undone · 1 not undone: was changed after it was accepted");
    expect(toastButtons()).toEqual(["view"]);
  });
});

