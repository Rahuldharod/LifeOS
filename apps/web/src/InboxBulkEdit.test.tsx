// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@lifeos/contracts";
import { InboxWorkspace, type BulkEditChange, type EditResult } from "./InboxWorkspace.js";

// PB-043 Inbox Bulk edit: field buttons for the fields the ticked proposals share; one value set on all of them, with Undo.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review = (id: string, title: string, fields: Record<string, unknown> = {}): ReviewItem => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}`, evidence: {},
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title, created_at: "2026-10-10T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", source_meeting_id: "meeting-1", source_ids: [], proposed_fields: { title }, ...fields }
});
const initial = () => [
  review("t1", "Task one", { primary_project_id: "pr1" }),
  review("t2", "Task two"),
  review("d1", "Decision one", { target_object_type: "decision", primary_project_id: "pr1" }),
  review("s1", "Summary one", { review_type: "summary", target_object_type: "meeting" })
];
const choices = { people: [{ id: "p1", title: "Paula Martin" }], projects: [{ id: "pr1", title: "Store rollout" }, { id: "pr2", title: "Harbor onboarding" }], clients: [{ id: "c1", title: "Acme" }], products: [{ id: "pd1", title: "P.Promo" }] };

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.useRealTimers(); });

/** The Inbox over state like the app's: a saved edit changes the item; `fail` names items whose save fails. */
async function mount({ fail = [], readOnly = false }: { fail?: string[]; readOnly?: boolean } = {}) {
  const calls: BulkEditChange[][] = []; const accepted: string[] = [];
  function Harness() {
    const [items, setItems] = useState(initial);
    const onEditMany = async (changes: BulkEditChange[]): Promise<EditResult> => {
      calls.push(changes);
      const result: EditResult = { edited: [], failures: [] };
      setItems((current) => current.map((item) => {
        const change = changes.find((candidate) => candidate.review.frontmatter.id === item.frontmatter.id);
        if (!change) return item;
        if (fail.includes(item.frontmatter.id)) { result.failures.push(`${item.frontmatter.title}: changed elsewhere`); return item; }
        result.edited.push(item.frontmatter.id);
        const proposed = { ...item.frontmatter.proposed_fields as Record<string, unknown> }; const links: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(change.edits)) { if (key.startsWith("primary_")) links[key] = value ?? undefined; else if (value === null) delete proposed[key]; else proposed[key] = value; }
        return { ...item, contentHash: `${item.contentHash}+`, frontmatter: { ...item.frontmatter, ...links, proposed_fields: proposed } };
      }));
      return result;
    };
    return <InboxWorkspace reviews={items} objects={[]} labels={new Map()} choices={choices} busy={false} readOnly={readOnly} displayTimeZone="Europe/Paris"
      onAccept={async (item) => { accepted.push(item.frontmatter.id); return true; }} onReject={async () => true} onSave={async () => true} onEditMany={onEditMany} />;
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Harness />));
  return { calls, accepted };
}

const fieldButtons = () => [...document.querySelectorAll(".inbox-bulk-edit .inbox-bulk-field > button .inbox-bulk-label")].map((label) => label.textContent);
const fieldButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".inbox-bulk-edit .inbox-bulk-field > button")].find((button) => button.textContent?.startsWith(`${label}:`))!;
const toastText = () => document.querySelector(".inbox-toast")?.textContent ?? "";
const tick = async (title: string) => { const box = document.querySelector<HTMLInputElement>(`[aria-label='Select proposal: ${title}']`)!; await act(async () => box.click()); };
const clickButton = async (name: string) => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name)!; await act(async () => button.click()); };
const press = async (key: string, target: EventTarget = document.activeElement ?? document.body) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("Inbox Bulk edit", () => {
  it("shows no field buttons until something is ticked", async () => {
    await mount();
    expect(document.querySelector(".inbox-bulk-edit")).toBeNull();
  });

  it("offers only the fields every ticked kind shares, with the shared value or Mixed, skipping kinds without fields", async () => {
    await mount();
    await tick("Task one"); await tick("Task two");
    expect(fieldButtons()).toEqual(["Owner: Me", "Due: No due date", "Priority: None", "Project: Mixed", "Client: None", "Product: None"]);
    await tick("Decision one"); await tick("Summary one");
    expect(fieldButtons()).toEqual(["Project: Mixed", "Client: None", "Product: None"]);
  });

  it("sets the picked value on every ticked item that has the field, keeps them ticked and pending, and Undo puts the old values back", async () => {
    const { calls } = await mount();
    await clickButton("Select all");
    await act(async () => fieldButton("Project").click());
    const search = document.querySelector<HTMLInputElement>("[aria-label='Find project']")!;
    expect(document.activeElement).toBe(search);
    await typeInto(search, "harb");
    expect([...document.querySelectorAll(".inbox-bulk-list [role='option']")].map((option) => option.textContent)).toEqual(["Harbor onboarding"]);
    await press("Enter", search);
    const byId = (changes: BulkEditChange[]) => changes.map((change) => [change.review.frontmatter.id, change.edits]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(byId(calls[0]!)).toEqual([["d1", { primary_project_id: "pr2" }], ["t1", { primary_project_id: "pr2" }], ["t2", { primary_project_id: "pr2" }]]);
    expect(toastText()).toContain("Project updated on 3 proposals · 1 skipped (no Project)");
    expect(fieldButton("Project").textContent).toContain("Harbor onboarding");
    expect(document.querySelector(".inbox-bulk")?.textContent).toContain("4 selected");
    expect(document.activeElement).toBe(fieldButton("Project"));

    // Z (the toast's Undo) restores each item's own value: Store rollout for two, none for the third.
    await press("z", document.body);
    expect(byId(calls[1]!)).toEqual([["d1", { primary_project_id: "pr1" }], ["t1", { primary_project_id: "pr1" }], ["t2", { primary_project_id: null }]]);
    expect(toastText()).toContain("Project put back on 3 proposals");
    expect(fieldButton("Project").textContent).toContain("Mixed");
  });

  it("keeps Inbox keys out of an open picker: letters type, arrows move, Enter applies, Esc closes without a change", async () => {
    const { calls, accepted } = await mount();
    await tick("Task one"); await tick("Task two");
    await act(async () => fieldButton("Owner").click());
    const search = document.querySelector<HTMLInputElement>("[aria-label='Find owner']")!;
    await press("a", search); await press("r", search); await press("x", search);
    expect(accepted).toEqual([]);
    await press("Escape", search);
    expect(document.querySelector("[aria-label='Find owner']")).toBeNull();
    expect(document.activeElement).toBe(fieldButton("Owner"));
    expect(calls).toHaveLength(0);
    expect(document.querySelector(".inbox-bulk")?.textContent).toContain("2 selected"); // Esc closed the picker, not the selection

    // Priority has no search: the list takes focus; ↓ ↓ Enter picks Medium (None, High, Medium, Low).
    await act(async () => fieldButton("Priority").click());
    const list = document.querySelector<HTMLElement>("[role='listbox'][aria-label='Priority']")!;
    await press("ArrowDown", list); await press("ArrowDown", list); await press("Enter", list);
    expect(calls[0]!.map((change) => change.edits)).toEqual([{ priority: "Medium" }, { priority: "Medium" }]);
    expect(fieldButton("Priority").textContent).toContain("Medium");
  });

  it("clears a field from the first option and sets a due date from the date picker", async () => {
    const { calls } = await mount();
    await tick("Task one"); await tick("Task two");
    await act(async () => fieldButton("Due").click());
    await typeInto(document.querySelector<HTMLInputElement>("[aria-label='Due date']")!, "2026-12-05");
    await clickButton("Apply");
    expect(calls[0]!.map((change) => change.edits)).toEqual([{ due_on: "2026-12-05" }, { due_on: "2026-12-05" }]);
    expect(fieldButton("Due").textContent).toContain("5 Dec");
    await act(async () => fieldButton("Project").click());
    const none = [...document.querySelectorAll<HTMLElement>(".inbox-bulk-list [role='option']")].find((option) => option.textContent === "None")!;
    await act(async () => none.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    expect(calls[1]!.map((change) => [change.review.frontmatter.id, change.edits])).toEqual([["t1", { primary_project_id: null }]]); // t2 already had none
    expect(toastText()).toContain("Project updated on 2 proposals");
  });

  it("keeps going when one save fails and says how many failed", async () => {
    await mount({ fail: ["t2"] });
    await tick("Task one"); await tick("Task two");
    await act(async () => fieldButton("Client").click());
    await press("ArrowDown", document.querySelector("[aria-label='Find client']")!);
    await press("Enter", document.querySelector("[aria-label='Find client']")!);
    expect(toastText()).toContain("Client updated on 1 proposal · 1 failed");
    expect(document.querySelector(".inbox-bulk")?.textContent).toContain("2 selected");
  });

  it("is off on a read-only Mac, and a letter key says why", async () => {
    await mount({ readOnly: true });
    await tick("Task one");
    expect(fieldButton("Project").disabled).toBe(true);
    await press("j", document.body);
    expect(document.querySelector("[aria-label='Find project']")).toBeNull();
    expect(toastText()).toContain("Read-only on this Mac");
  });
});

// PB-044: O, D, I, J, C, P open a field's picker for the ticked items, else the Focused item.
describe("Inbox field keys", () => {
  it("open the field's picker for the ticked items: J searches projects, I focuses the Priority list, and each button shows its key", async () => {
    const { calls } = await mount();
    await tick("Task one"); await tick("Task two");
    expect([...document.querySelectorAll(".inbox-bulk-key")].map((key) => key.textContent)).toEqual(["O", "D", "I", "J", "C", "P"]);
    expect(fieldButton("Project").getAttribute("aria-keyshortcuts")).toBe("J");
    await press("j", document.body);
    const search = document.querySelector<HTMLInputElement>("[aria-label='Find project']")!;
    expect(document.activeElement).toBe(search);
    await typeInto(search, "harb");
    await press("Enter", search);
    expect(calls[0]!.map((change) => change.edits)).toEqual([{ primary_project_id: "pr2" }, { primary_project_id: "pr2" }]);
    await press("i", document.body);
    expect(document.activeElement).toBe(document.querySelector("[role='listbox'][aria-label='Priority']"));
    await press("Escape");
    expect(document.querySelector("[role='listbox'][aria-label='Priority']")).toBeNull();
    expect(document.querySelector(".inbox-bulk")?.textContent).toContain("2 selected");
  });

  it("with nothing ticked, edit only the Focused item, then hand focus back to its row", async () => {
    const { calls } = await mount();
    const focused = document.querySelector(".inbox-row.focused")!;
    const id = focused.getAttribute("data-review-id");
    expect(document.querySelector(".inbox-bulk-edit")).toBeNull();
    await press("c", document.body);
    const group = document.querySelector(".inbox-bulk-edit")!;
    expect(group.getAttribute("aria-label")).toBe("Set a field on the focused item");
    expect(group.textContent).toContain("Focused item");
    const search = document.querySelector<HTMLInputElement>("[aria-label='Find client']")!;
    await press("ArrowDown", search); await press("Enter", search);
    expect(calls[0]!.map((change) => [change.review.frontmatter.id, change.edits])).toEqual([[id, { primary_client_id: "c1" }]]);
    expect(document.querySelector(".inbox-bulk-edit")).toBeNull();
    expect(document.activeElement).toBe(focused.querySelector(".inbox-row-open"));
    // Esc closes without a change and also goes back to the row.
    await press("o", document.body);
    await press("Escape", document.querySelector("[aria-label='Find owner']")!);
    expect(document.querySelector(".inbox-bulk-edit")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(document.activeElement).toBe(focused.querySelector(".inbox-row-open"));
  });

  it("open nothing for a field the targets lack, and say which kinds lack it", async () => {
    await mount();
    await tick("Task one"); await tick("Decision one");
    await press("d", document.body);
    expect(document.querySelector("[aria-label='Due date']")).toBeNull();
    expect(toastText()).toContain("Due isn't available for Decisions");
    await clickButton("Deselect all"); await tick("Summary one");
    await press("p", document.body);
    expect(toastText()).toContain("Product isn't available for Summaries");
  });

  it("skip the Open item while it has unsaved edits, and count it", async () => {
    const { calls } = await mount();
    const openTitle = document.querySelector(".inbox-row.selected .inbox-row-open strong")!.textContent!;
    await typeInto(document.querySelector<HTMLInputElement>("[aria-label='Proposed title']")!, "Typed but not saved");
    await tick("Task one"); await tick("Task two");
    await press("p", document.body);
    const search = document.querySelector<HTMLInputElement>("[aria-label='Find product']")!;
    await press("ArrowDown", search); await press("Enter", search);
    expect(calls[0]!.map((change) => change.review.frontmatter.title)).toEqual(["Task one", "Task two"].filter((title) => title !== openTitle));
    expect(toastText()).toContain("1 skipped (unsaved edits)");
  });
});
