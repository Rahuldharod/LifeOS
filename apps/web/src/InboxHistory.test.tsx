// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxHistoryEntry } from "@lifeos/contracts";
import { InboxHistory } from "./InboxHistory.js";
import { InboxSwitch } from "./InboxSwitch.js";
import type { UndoResult } from "./inboxModel.js";

// #243: the Inbox History tab: rows, the All / Mine / System chips, Undo (with the toast's refusal), Open and Reopen in Inbox.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (id: string, over: Partial<InboxHistoryEntry> = {}): InboxHistoryEntry => ({
  id, at: "2026-11-23T09:30:00.000Z", actor: "you", action: "accepted", source: "review", reviewId: `review-${id}`, reviewType: "create", targetObjectType: "task", title: `Item ${id}`,
  sourceMeetingId: "m1", sourceMeetingTitle: "Pilot sync", objectId: `object-${id}`, restricted: false, undone: false, undoable: true, ...over
});
const all = () => [
  entry("a"),
  entry("b", { action: "rejected", objectId: undefined, title: "Rejected one" }),
  entry("c", { actor: "system", source: "patch", reviewId: undefined, reviewType: "update", targetObjectType: "task", action: "applied", title: "Patched task", summary: "priority none → High" }),
  entry("d", { undone: true, undoable: false, title: "Undone one" }),
  entry("e", { action: "merged", reviewType: "person-merge", targetObjectType: "person", title: "Ana Silva + A. Silva", undoable: false }),
  entry("f", { restricted: true, title: "Secret one" }),
  entry("g", { action: "kept-separate", reviewType: "person-merge", targetObjectType: "person", objectId: undefined, title: "Two Joels" })
];

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.useRealTimers(); });

type Props = { entries?: InboxHistoryEntry[]; onUndo?: (ids: string[]) => Promise<UndoResult>; onUndoPatch?: (entry: InboxHistoryEntry) => Promise<void>; onOpenObject?: (id: string) => void; onReopen?: (id: string) => void; busy?: boolean; readOnly?: boolean };
async function mount({ entries = all(), onUndo = async (ids) => ({ undone: ids, refused: [] }), onUndoPatch = async () => undefined, onOpenObject = () => undefined, onReopen = () => undefined, busy = false, readOnly = false }: Props = {}) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<InboxHistory entries={entries} switcher={<InboxSwitch page="history" onPage={() => undefined} />} busy={busy} readOnly={readOnly} displayTimeZone="Europe/Paris" now={new Date("2026-11-23T12:00:00.000Z")} onUndo={onUndo} onUndoPatch={onUndoPatch} onOpenObject={onOpenObject} onReopen={onReopen} />));
}
const rows = () => [...document.querySelectorAll("tbody tr")].map((row) => (row as HTMLElement).dataset.historyId);
const row = (id: string) => document.querySelector(`tr[data-history-id='${id}']`) as HTMLElement;
const buttons = (id: string) => [...row(id).querySelectorAll("button")].map((button) => button.textContent);
const click = async (element: Element | null) => act(async () => (element as HTMLElement).click());
const chip = (name: string) => [...document.querySelectorAll(".inbox-history-chips button")].find((button) => button.textContent === name)!;
const toast = () => document.querySelector(".inbox-toast")?.textContent;

describe("the rows", () => {
  it("show when, who, the action, the Review kind badge, the item and its Source meeting, newest first as given", async () => {
    await mount();
    expect(rows()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    const text = row("a").textContent!;
    expect(text).toContain("Today 10:30");
    expect(text).toContain("You");
    expect(text).toContain("Accepted");
    expect(row("a").querySelector(".inbox-badge")?.textContent).toBe("Task");
    expect(text).toContain("Item a");
    expect(text).toContain("Pilot sync");
    expect(row("e").querySelector(".inbox-badge")?.textContent).toBe("Merge");
    expect(row("c").querySelector(".inbox-badge")?.textContent).toBe("Change");
    expect(row("c").textContent).toContain("priority none → High");
  });

  it("label the System, and show the lock badge on a Restricted item", async () => {
    await mount();
    expect(row("c").querySelector(".inbox-history-system")?.textContent).toBe("System");
    expect(row("a").querySelector(".inbox-history-system")).toBeNull();
    expect(row("f").querySelector(".lock-badge")?.textContent).toContain("Restricted");
    expect(row("a").querySelector(".lock-badge")).toBeNull();
  });

  it("show Undone and no buttons for an undone action, and no Undo where it is not undoable", async () => {
    await mount();
    expect(row("d").querySelector("em")?.textContent).toBe("Undone");
    expect(buttons("d")).toEqual([]);
    expect(buttons("e")).toEqual(["Open person"]);
    expect(buttons("a")).toEqual(["Undo", "Open task"]);
    expect(buttons("b")).toEqual(["Undo", "Reopen in Inbox"]);
    expect(buttons("g")).toEqual(["Undo", "Reopen in Inbox"]);
  });
});

describe("the chips", () => {
  it("default to All, and Mine and System filter by who took the action", async () => {
    await mount();
    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
    await click(chip("System"));
    expect(rows()).toEqual(["c"]);
    await click(chip("Mine"));
    expect(rows()).toEqual(["a", "b", "d", "e", "f", "g"]);
    await click(chip("All"));
    expect(rows()).toHaveLength(7);
  });

  it("say so when a chip matches nothing, and when there is no history", async () => {
    await mount({ entries: [entry("a")] });
    await click(chip("System"));
    expect(document.querySelector(".inbox-state")?.textContent).toContain("No matching actions");
    act(() => root?.unmount()); document.body.innerHTML = "";
    await mount({ entries: [] });
    expect(document.querySelector(".inbox-state")?.textContent).toContain("No Review actions yet");
  });
});

describe("Undo", () => {
  it("undoes the item's Review action and says it is back in the Inbox", async () => {
    const onUndo = vi.fn(async (ids: string[]) => ({ undone: ids, refused: [] }));
    await mount({ onUndo });
    await click(row("a").querySelector("button"));
    expect(onUndo).toHaveBeenCalledWith(["review-a"]);
    expect(toast()).toContain("1 proposal back in the Inbox");
  });

  it("shows the server's refusal, with View on the object that was changed since", async () => {
    const onOpenObject = vi.fn();
    await mount({ onUndo: async (ids) => ({ undone: [], refused: [{ id: ids[0]!, reason: 'Cannot undo: "Item a" was changed after it was accepted (revision 2).' }] }), onOpenObject });
    await click(row("a").querySelector("button"));
    expect(toast()).toContain("Not undone: Cannot undo");
    await click(document.querySelector("[data-toast-action='view']"));
    expect(onOpenObject).toHaveBeenCalledWith("object-a");
  });

  it("undoes an applied Patch Draft by its own call, and shows its refusal", async () => {
    const onUndoPatch = vi.fn().mockRejectedValueOnce(new Error("A patched field changed since")).mockResolvedValueOnce(undefined);
    await mount({ onUndoPatch });
    await click(row("c").querySelector("button"));
    expect(onUndoPatch).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
    expect(toast()).toContain("Not undone: A patched field changed since");
    await click(row("c").querySelector("button"));
    expect(toast()).toContain("Undid the change to Patched task");
  });

  it("is off while the app is busy or read-only", async () => {
    await mount({ readOnly: true });
    expect([...document.querySelectorAll("tbody button")].filter((button) => button.textContent === "Undo").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("changing the result", () => {
  it("Open <object> opens what the accept created", async () => {
    const onOpenObject = vi.fn();
    await mount({ onOpenObject });
    await click([...row("a").querySelectorAll("button")].find((button) => button.textContent === "Open task")!);
    expect(onOpenObject).toHaveBeenCalledWith("object-a");
  });

  it("Reopen in Inbox undoes the reject, then goes to the Inbox with that item", async () => {
    const calls: string[] = [];
    await mount({ onUndo: async (ids) => { calls.push(`undo:${ids}`); return { undone: ids, refused: [] }; }, onReopen: (id) => calls.push(`reopen:${id}`) });
    await click([...row("b").querySelectorAll("button")].find((button) => button.textContent === "Reopen in Inbox")!);
    expect(calls).toEqual(["undo:review-b", "reopen:review-b"]);
  });

  it("Reopen in Inbox stays here and says why when the undo is refused", async () => {
    const onReopen = vi.fn();
    await mount({ onUndo: async (ids) => ({ undone: [], refused: [{ id: ids[0]!, reason: "One of the two People was deleted since" }] }), onReopen });
    await click([...row("g").querySelectorAll("button")].find((button) => button.textContent === "Reopen in Inbox")!);
    expect(onReopen).not.toHaveBeenCalled();
    expect(toast()).toContain("Not undone: One of the two People was deleted since");
  });
});

describe("the Inbox / History switch", () => {
  it("marks the current page and goes to the other", async () => {
    const onPage = vi.fn();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<InboxSwitch page="history" onPage={onPage} />));
    const [inbox, history] = [...document.querySelectorAll("button")];
    expect(history!.getAttribute("aria-current")).toBe("page");
    await click(history!); expect(onPage).not.toHaveBeenCalled();
    await click(inbox!); expect(onPage).toHaveBeenCalledWith("inbox");
  });
});
