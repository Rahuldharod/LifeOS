// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "@lifeos/contracts";
import { InboxWorkspace } from "./InboxWorkspace.js";
import { inboxShortcuts } from "./InboxShortcutSheet.js";
import { inboxViewStorageKey } from "./useInboxView.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review = (id: string, title: string): ReviewItem => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}\n\nProposed from the source.`, evidence: {},
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title, created_at: "2026-10-10T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", source_ids: [], proposed_fields: { title } }
});
const reviews = [review("a", "Alpha task"), review("b", "Bravo task"), review("c", "Charlie task")];

let root: Root | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.unstubAllGlobals(); });

/** #240: Split / List view. The route is kept in the harness so Back and open behave like the real app. */
function Harness({ selectedId }: { selectedId?: string }) {
  const [route, setRoute] = React.useState<string | undefined>(selectedId);
  return <InboxWorkspace reviews={reviews} selectedId={route} objects={[]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris" now={new Date("2026-10-10T12:00:00Z")}
    onOpen={setRoute} onBack={() => setRoute(undefined)} onAccept={async () => true} onReject={async () => true} onSave={async () => true} />;
}
async function mount(selectedId?: string) { root = createRoot(document.body.appendChild(document.createElement("div"))); await act(async () => root!.render(<Harness selectedId={selectedId} />)); }

const press = async (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
const workspace = () => document.querySelector<HTMLElement>(".inbox-workspace")!;
const queue = () => document.querySelector<HTMLElement>("[aria-label='Review queue']")!;
const detail = () => document.querySelector<HTMLElement>("[aria-label='Review detail']")!;
const toggle = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".inbox-view-toggle button")].find((button) => button.textContent === name)!;
const click = async (element: Element) => act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
const row = (title: string) => [...document.querySelectorAll<HTMLElement>(".inbox-row:not(.inbox-colhead)")].find((item) => item.querySelector("strong")?.textContent === title)!;
const openButton = (title: string) => row(title).querySelector<HTMLButtonElement>(".inbox-row-open")!;

describe("Split view (default)", () => {
  it("shows the list, the divider and the open item; the toggle says Split", async () => {
    await mount();
    expect(toggle("Split").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("List").getAttribute("aria-pressed")).toBe("false");
    expect(workspace().dataset.view).toBe("split");
    expect(queue().hidden).toBe(false); expect(detail().hidden).toBe(false);
    expect(document.querySelector("[role='separator']")).not.toBeNull();
    expect(detail().querySelector("h2")?.textContent).toBe("Alpha task"); // the first item opens by itself
  });

  it("V switches to List, which is remembered; V again returns to Split", async () => {
    await mount();
    await press("v");
    expect(workspace().dataset.view).toBe("list");
    expect(localStorage.getItem(inboxViewStorageKey)).toBe("list");
    await press("V".toLowerCase());
    expect(workspace().dataset.view).toBe("split");
    expect(localStorage.getItem(inboxViewStorageKey)).toBeNull();
  });

  it("V does nothing while typing in the search field", async () => {
    await mount();
    await press("v", document.querySelector("input[type='search']")!);
    expect(workspace().dataset.view).toBe("split");
  });

  it("double-clicking the divider goes to List", async () => {
    await mount();
    await act(async () => document.querySelector("[role='separator']")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(workspace().dataset.view).toBe("list");
  });

  it("lists V in the shortcut sheet", () => {
    expect(inboxShortcuts.find((item) => item.keys === "V")?.what).toMatch(/Split and List/);
  });
});

describe("List view", () => {
  it("is restored from storage: full-width list, no divider, no reading pane, nothing opens by itself", async () => {
    localStorage.setItem(inboxViewStorageKey, "list");
    await mount();
    expect(toggle("List").getAttribute("aria-pressed")).toBe("true");
    expect(queue().hidden).toBe(false); expect(detail().hidden).toBe(true);
    expect(document.querySelector("[role='separator']")).toBeNull();
    expect(workspace().classList.contains("detail-open")).toBe(false);
  });

  it("a click opens the item in place of the list; Back returns with focus on that row", async () => {
    localStorage.setItem(inboxViewStorageKey, "list");
    await mount();
    await click(openButton("Bravo task"));
    expect(queue().hidden).toBe(true); expect(detail().hidden).toBe(false);
    expect(detail().querySelector("h2")?.textContent).toBe("Bravo task");
    await click(detail().querySelector("button.narrow-back")!);
    expect(queue().hidden).toBe(false); expect(detail().hidden).toBe(true);
    expect(document.activeElement).toBe(openButton("Bravo task"));
  });

  it("Enter opens the focused item; Esc returns to the list with focus on that row", async () => {
    localStorage.setItem(inboxViewStorageKey, "list");
    await mount();
    await press("ArrowDown"); await press("ArrowDown");
    expect(document.activeElement).toBe(openButton("Charlie task"));
    await press("Enter");
    expect(detail().hidden).toBe(false); expect(detail().querySelector("h2")?.textContent).toBe("Charlie task");
    await press("Escape");
    expect(detail().hidden).toBe(true);
    expect(document.activeElement).toBe(openButton("Charlie task"));
  });

  it("switching to Split shows both again with the first item open; switching to List closes the open item", async () => {
    localStorage.setItem(inboxViewStorageKey, "list");
    await mount();
    await click(openButton("Charlie task"));
    await click(toggle("Split"));
    expect(queue().hidden).toBe(false); expect(detail().hidden).toBe(false);
    expect(document.querySelector("[role='separator']")).not.toBeNull();
    expect(detail().querySelector("h2")?.textContent).toBe("Charlie task");
    await click(toggle("List"));
    expect(detail().hidden).toBe(true); expect(queue().hidden).toBe(false);
  });
});

describe("Narrow screens", () => {
  it("keep their one-pane behaviour, with no view toggle and no V", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    await mount();
    expect(document.querySelector(".inbox-view-toggle")).toBeNull();
    expect(workspace().dataset.view).toBeUndefined();
    await press("v");
    expect(localStorage.getItem(inboxViewStorageKey)).toBeNull();
    expect(queue().hidden).toBe(false); expect(detail().hidden).toBe(true);
  });
});
