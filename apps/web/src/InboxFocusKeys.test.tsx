// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject, ReviewItem } from "@lifeos/contracts";
import { InboxWorkspace } from "./InboxWorkspace.js";
import { inboxShortcuts } from "./InboxShortcutSheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review = (id: string, title: string, fields: Record<string, unknown> = {}): ReviewItem => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}\n\nProposed from the source.`, evidence: {},
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title, created_at: "2026-10-10T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", source_meeting_id: "meeting-1", source_ids: [], proposed_fields: { title }, ...fields }
});
const meeting: LifeObject = { relativePath: "meetings/meeting-1.md", contentHash: "m", body: "# Pilot review", frontmatter: { id: "meeting-1", type: "meeting", schema_version: 1, revision: 1, title: "Pilot review", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z" } };

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** #238: the Focused item (keys act on it) is separate from the Open item (the reading pane shows it). A stateful Inbox: decided items leave `reviews`. */
const queue = () => [
  review("a", "Alpha task", { created_at: "2026-10-10T10:00:00Z" }),
  review("b", "Bravo task", { created_at: "2026-10-10T09:00:00Z" }),
  review("l", "Link owner", { created_at: "2026-10-10T08:00:00Z", review_type: "link-resolution" }),
  review("c", "Charlie decision", { created_at: "2026-10-10T07:00:00Z", target_object_type: "decision" }),
  review("d", "Delta task", { created_at: "2026-10-10T06:00:00Z" })
];
const decided: string[] = [];
const linkRejected: string[] = [];

function Harness({ selectedId }: { selectedId: string }) {
  const [reviews, setReviews] = React.useState(queue());
  const [route, setRoute] = React.useState<string | undefined>(selectedId);
  const remove = (id: string) => setReviews((current) => current.filter((entry) => entry.frontmatter.id !== id));
  const decide = (outcome: string) => async (item: { frontmatter: { id: string } }) => { decided.push(`${outcome}:${item.frontmatter.id}`); remove(item.frontmatter.id); return true; };
  return <InboxWorkspace reviews={reviews} selectedId={route} objects={[meeting]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris" now={new Date("2026-10-10T12:00:00Z")}
    onOpen={(id) => setRoute(id)} onAccept={decide("accepted")} onReject={decide("rejected")} onSave={async () => true}
    linkActionsFor={(id) => ({ onCreate: async () => ({}) as never, onLink: async () => undefined, onReject: async () => { linkRejected.push(id); remove(id); } })} />;
}

async function mount(selectedId = "a") {
  decided.length = 0; linkRejected.length = 0;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Harness selectedId={selectedId} />));
}
const press = async (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
const focusedTitle = () => document.querySelector(".inbox-row.focused .inbox-row-open strong")?.textContent;
const detailTitle = () => document.querySelector("[aria-label='Review detail'] h2")?.textContent;
const status = () => document.querySelector("[role='status']")?.textContent;
const isTicked = (title: string) => (document.querySelector(`[aria-label='Select proposal: ${title}']`) as HTMLInputElement).checked;
const row = (title: string) => [...document.querySelectorAll<HTMLElement>(".inbox-row:not(.inbox-colhead)")].find((item) => item.querySelector("strong")?.textContent === title);
const clickRow = async (title: string, init: MouseEventInit = {}) => act(async () => { row(title)!.querySelector(".inbox-row-open")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })); });
const tickBox = async (title: string) => act(async () => (document.querySelector(`[aria-label='Select proposal: ${title}']`) as HTMLInputElement).click());
const downs = async (count: number) => { for (let step = 0; step < count; step += 1) await press("ArrowDown"); };

describe("Focused item and Open item", () => {
  it("start together; arrows move focus while the reading pane stays on the open item (J and K no longer do: PB-044)", async () => {
    await mount("b");
    expect(focusedTitle()).toBe("Bravo task");
    await press("ArrowDown");
    expect(focusedTitle()).toBe("Link owner");
    await press("ArrowDown");
    expect(focusedTitle()).toBe("Charlie decision");
    await press("k"); // not a key any more
    expect(focusedTitle()).toBe("Charlie decision");
    await press("ArrowUp"); await press("ArrowUp");
    expect(focusedTitle()).toBe("Bravo task");
    await press("ArrowUp"); await press("ArrowUp"); // stops at the top
    expect(focusedTitle()).toBe("Alpha task");
    expect(detailTitle()).toBe("Bravo task");
    expect(row("Bravo task")!.classList.contains("selected")).toBe(true);
    expect(row("Alpha task")!.classList.contains("selected")).toBe(false);
  });

  it("Enter and a click open the focused item", async () => {
    await mount("a");
    await downs(2);
    expect(detailTitle()).toBe("Alpha task");
    await press("Enter");
    expect(detailTitle()).toBe("Link owner");
    await clickRow("Delta task");
    expect(detailTitle()).toBe("Delta task");
    expect(focusedTitle()).toBe("Delta task");
  });

  it("moves real keyboard focus to the focused row, so it scrolls into view and is announced", async () => {
    await mount("a");
    await press("ArrowDown");
    expect(document.activeElement).toBe(row("Bravo task")!.querySelector(".inbox-row-open"));
  });

  it("has no focused row when every group is collapsed", async () => {
    await mount("a");
    await act(async () => (document.querySelector(".inbox-source") as HTMLButtonElement).click());
    expect(row("Alpha task")).toBeUndefined(); // every item shares one meeting, so the whole group is gone
    expect(focusedTitle()).toBeUndefined();
    await press("ArrowDown"); await press("a");
    expect(decided).toEqual([]);
  });
});

describe("A and R", () => {
  it("act on the focused item, not the open one, then focus moves to the next item", async () => {
    await mount("a");
    await press("ArrowDown"); // focus Bravo, Alpha stays open
    await press("a");
    expect(decided).toEqual(["accepted:b"]);
    expect(detailTitle()).toBe("Alpha task");
    expect(focusedTitle()).toBe("Link owner");
    expect(status()).toBe("Proposal accepted");
  });

  it("after the last item, focus moves to the one above", async () => {
    await mount("a");
    await downs(6);
    expect(focusedTitle()).toBe("Delta task");
    await press("r");
    expect(decided).toEqual(["rejected:d"]);
    expect(focusedTitle()).toBe("Charlie decision");
  });

  it("advance both focus and the open item when the focused item is the open one (PB-035)", async () => {
    await mount("b");
    await press("a");
    expect(decided).toEqual(["accepted:b"]);
    expect(detailTitle()).toBe("Link owner");
    expect(focusedTitle()).toBe("Link owner");
  });

  it("on the open item, unsaved edits still block A", async () => {
    await mount("a");
    const title = document.querySelector("[aria-label='Proposed title']") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Alpha task, revised"); title.dispatchEvent(new Event("input", { bubbles: true })); });
    await press("a");
    expect(decided).toEqual([]);
  });

  it("R on a focused link item rejects it through its link actions; A explains it needs a choice", async () => {
    await mount("a");
    await downs(2);
    await press("a");
    expect(decided).toEqual([]);
    expect(status()).toContain("Link proposals need a choice");
    await press("r");
    expect(linkRejected).toEqual(["l"]);
    expect(focusedTitle()).toBe("Charlie decision");
  });

  it("act on every ticked item when any are ticked; bulk Accept skips link items and says so", async () => {
    await mount("a");
    await press("x"); await downs(2); await press("x"); await press("ArrowDown"); await press("x");
    expect(["Alpha task", "Link owner", "Charlie decision"].every(isTicked)).toBe(true);
    await press("a");
    expect(decided).toEqual(["accepted:a", "accepted:c"]);
    expect(status()).toBe("2 proposals accepted · 1 skipped (link or merge needs a choice)");
    expect(isTicked("Link owner")).toBe(true);
    expect(detailTitle()).toBe("Bravo task");
  });

  it("with only link items ticked, A reports the skip instead of doing nothing", async () => {
    await mount("a");
    await downs(2); await press("x"); await press("a");
    expect(decided).toEqual([]);
    expect(status()).toBe("1 skipped (link or merge needs a choice)");
  });

  it("after a bulk action the focus moves to the next item that is left", async () => {
    await mount("a");
    await press("x"); await press("ArrowDown"); await press("x"); // Alpha and Bravo ticked, focus on Bravo
    await press("a");
    expect(decided).toEqual(["accepted:a", "accepted:b"]);
    expect(focusedTitle()).toBe("Link owner");
  });

  it("bulk R rejects without asking first (Undo replaces the confirmation, ADR 0025)", async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
    await mount("a");
    await press("x"); await press("r");
    expect(confirm).not.toHaveBeenCalled();
    expect(decided).toEqual(["rejected:a"]);
  });
});

describe("selection", () => {
  it("X ticks the focused item; Shift+X ticks a range from the last anchor; Esc clears", async () => {
    await mount("a");
    await press("ArrowDown"); await press("x");
    expect(isTicked("Bravo task")).toBe(true);
    expect(isTicked("Alpha task")).toBe(false);
    await downs(2); await press("X", document.body, { shiftKey: true });
    expect(["Bravo task", "Link owner", "Charlie decision"].every(isTicked)).toBe(true);
    expect(isTicked("Delta task")).toBe(false);
    await press("x"); // plain X on a ticked item unticks only it
    expect(isTicked("Charlie decision")).toBe(false);
    await press("Escape");
    expect(["Bravo task", "Link owner"].some(isTicked)).toBe(false);
  });

  it("Shift+click ticks a range and does not open; a plain tick sets the anchor", async () => {
    await mount("a");
    await tickBox("Bravo task");
    await clickRow("Delta task", { shiftKey: true });
    expect(["Bravo task", "Link owner", "Charlie decision", "Delta task"].every(isTicked)).toBe(true);
    expect(isTicked("Alpha task")).toBe(false);
    expect(detailTitle()).toBe("Alpha task");
  });

  it("a range skips items in collapsed groups", async () => {
    const reviews = [review("a", "Alpha", { created_at: "2026-10-10T10:00:00Z" }), review("b", "Bravo", { created_at: "2026-10-10T09:00:00Z", source_meeting_id: undefined }), review("c", "Charlie", { created_at: "2026-10-10T08:00:00Z" })];
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<InboxWorkspace reviews={reviews} selectedId="a" objects={[meeting]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris" now={new Date("2026-10-10T12:00:00Z")} onAccept={async () => true} onReject={async () => true} onSave={async () => true} />));
    await act(async () => ([...document.querySelectorAll(".inbox-source")].find((item) => item.textContent?.includes("Other")) as HTMLButtonElement).click());
    await tickBox("Alpha");
    await clickRow("Charlie", { shiftKey: true });
    expect(isTicked("Alpha") && isTicked("Charlie")).toBe(true);
    await act(async () => ([...document.querySelectorAll(".inbox-source")].find((item) => item.textContent?.includes("Other")) as HTMLButtonElement).click());
    expect(isTicked("Bravo")).toBe(false); // it was collapsed away when the range was ticked
  });

  it("Esc with nothing ticked does nothing", async () => {
    await mount("a");
    await press("Escape");
    expect(detailTitle()).toBe("Alpha task");
  });
});

describe("shortcut sheet and typing", () => {
  it("? opens a sheet with every Inbox shortcut; Esc and the Shortcuts button work", async () => {
    await mount("a");
    await press("?", document.body, { shiftKey: true });
    const dialog = document.querySelector("[role='dialog']")!;
    expect(dialog.getAttribute("aria-label")).toBe("Inbox keyboard shortcuts");
    for (const { keys, what } of inboxShortcuts) { expect(dialog.textContent).toContain(keys); expect(dialog.textContent).toContain(what); }
    expect(inboxShortcuts.map((item) => item.keys).join(" ")).toMatch(/↑ ↓.*Enter.*A.*R.*S.*X.*Shift \+ X.*Esc.*O.*D.*I.*J.*C.*P.*1 – 6.*\?/);
    await press("a", dialog.querySelector("button")!); // keys do nothing inside the sheet
    expect(decided).toEqual([]);
    await press("Escape", dialog.querySelector("button")!);
    expect(document.querySelector("[role='dialog']")).toBeNull();
    await act(async () => (document.querySelector(".inbox-shortcuts-link") as HTMLButtonElement).click());
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
  });

  it("no key fires while typing in a field, including ? and X", async () => {
    await mount("a");
    const search = document.querySelector("[aria-label='Search proposals']")!;
    for (const key of ["a", "r", "x", "j", "p", "Enter", "ArrowDown", "Escape"]) await press(key, search);
    await press("?", search, { shiftKey: true });
    await press("a", document.querySelector("[aria-label='Proposed title']")!);
    expect(decided).toEqual([]);
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(focusedTitle()).toBe("Alpha task");
    expect(isTicked("Alpha task")).toBe(false);
  });

  it("digits switch tabs even with Shift (AZERTY)", async () => {
    await mount("a");
    await press("4", document.body, { shiftKey: true });
    expect(document.querySelector("[role='tab'][aria-selected='true']")?.textContent).toContain("Task");
  });
});

describe("narrow screens", () => {
  it("with a proposal open, the list is hidden, so the arrows step through proposals as before", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    await mount("b");
    await press("ArrowDown");
    expect(detailTitle()).toBe("Link owner");
  });
});
