// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject, ReviewItem } from "@lifeos/contracts";
import { InboxWorkspace } from "./InboxWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review = (id: string, title: string, fields: Record<string, unknown> = {}): ReviewItem => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}\n\nProposed from the source.`, evidence: {
    title: [{ field: "title", resolved: true, source_id: "source-1", source_title: "Interview transcript", locator: "00:14", quote: "Ship the pilot" }]
  },
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title, created_at: "2026-10-10T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", source_meeting_id: "meeting-1", source_ids: ["source-1"], proposed_fields: { title }, ...fields }
});

const object = (id: string, type: string, title: string): LifeObject => ({
  relativePath: `${type}s/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}`,
  frontmatter: { id, type, schema_version: 1, revision: 1, title, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z" }
});

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function render(props: Partial<React.ComponentProps<typeof InboxWorkspace>> = {}) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const defaults: React.ComponentProps<typeof InboxWorkspace> = {
    reviews: [review("r1", "Ship the pilot"), review("r2", "Summarise workshop", { review_type: "summary", target_object_type: "meeting", created_at: "2026-09-01T08:00:00Z", source_meeting_id: undefined, proposed_fields: { summary: "A concise summary." } })],
    objects: [object("meeting-1", "meeting", "Pilot review"), object("source-1", "source", "Interview transcript")],
    labels: new Map(), choices: { people: [], projects: [], clients: [], products: [] }, selectedId: "r1", readOnly: false, busy: false, displayTimeZone: "Europe/Paris",
    onAccept: async () => true, onReject: async () => true, onSave: async () => true
  };
  await act(async () => root!.render(<InboxWorkspace {...defaults} {...props} />));
}

async function click(name: string) {
  const control = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLButtonElement;
  expect(control, `button ${name}`).toBeTruthy();
  await act(async () => control.click());
}

async function tab(name: string) {
  const control = [...document.querySelectorAll("[role='tab']")].find((item) => item.textContent?.replace(/\s*\d+$/, "") === name) as HTMLButtonElement;
  expect(control, `tab ${name}`).toBeTruthy();
  await act(async () => control.click());
}

const focusedTitle = () => document.querySelector(".inbox-row.focused .inbox-row-open strong")?.textContent;
const queueText = () => document.querySelector("[aria-label='Review queue']")?.textContent ?? "";
const press = async (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });

async function type(label: string, value: string) {
  const control = document.querySelector(`[aria-label='${label}']`) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function choose(label: string, value: string) {
  const control = document.querySelector(`select[aria-label='${label}']`) as HTMLSelectElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("InboxWorkspace", () => {
  it("keeps queue, selected source, evidence, edits and decisions together", async () => {
    await render();
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Ship the pilot");
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toMatch(/Pilot review.*Interview transcript.*Ship the pilot/s);
    expect(document.body.textContent).toContain("Evidence");
    expect(document.body.textContent).toContain("Accept task");
    expect(document.body.textContent).toContain("Reject");
    expect([...document.querySelectorAll("[role='tab']")].map((item) => item.textContent)).toEqual(["All 2", "Summary 1", "Decision 0", "Task 1", "Open point 0", "Other 0"]);
  });

  it("saves proposal edits before enabling acceptance", async () => {
    const save = vi.fn(async () => true);
    await render({ onSave: save });
    await type("Proposed title", "Ship the revised pilot");
    expect(([...document.querySelectorAll("button")].find((button) => button.textContent === "Accept task") as HTMLButtonElement).disabled).toBe(true);
    await click("Save edits");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ frontmatter: expect.objectContaining({ id: "r1" }) }), { title: "Ship the revised pilot" });
  });

  it("searches and filters by proposal type, source meeting and created period", async () => {
    await render({ now: new Date("2026-10-11T12:00:00Z") });
    await type("Search proposals", "workshop");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).not.toContain("Ship the pilot");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Summarise workshop");
    await type("Search proposals", "");
    await tab("Summary");
    expect(queueText()).not.toContain("Ship the pilot");
    await tab("All");
    await click("Advanced");
    expect(document.querySelector("select[aria-label='Filter by source meeting']")).toBeTruthy();
    expect(document.querySelector("select[aria-label='Filter by created period']")).toBeTruthy();
    await choose("Filter by source meeting", "meeting-1");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Ship the pilot");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).not.toContain("Summarise workshop");
    await choose("Filter by source meeting", "");
    await choose("Filter by created period", "7d");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).not.toContain("Summarise workshop");
  });

  it("groups proposals into Summary, Decision, Task, Open point and Other tabs", async () => {
    const reviews = [
      review("task", "Task proposal"),
      review("decision", "Decision proposal", { target_object_type: "decision" }),
      review("point", "Open point proposal", { target_object_type: "open-point" }),
      review("update", "Update proposal", { review_type: "update" }),
      review("summary", "Summary proposal", { review_type: "summary", target_object_type: "meeting" })
    ];
    await render({ reviews, selectedId: "task" });
    expect([...document.querySelectorAll("[role='tab']")].map((item) => item.textContent)).toEqual(["All 5", "Summary 1", "Decision 1", "Task 1", "Open point 1", "Other 1"]);
    const rows = () => [...document.querySelectorAll("[aria-label^='Open proposal: ']")].map((item) => item.getAttribute("aria-label")!.replace("Open proposal: ", ""));
    await tab("Task");
    expect(rows()).toEqual(["Task proposal"]);
    await tab("Decision");
    expect(rows()).toEqual(["Decision proposal"]);
    await tab("Open point");
    expect(rows()).toEqual(["Open point proposal"]);
    await tab("Summary");
    expect(rows()).toEqual(["Summary proposal"]);
    await tab("Other");
    expect(rows()).toEqual(["Update proposal"]);
    expect(document.querySelector("[role='tab'][aria-selected='true']")?.textContent).toBe("Other 1");
  });

  it("uses the selected display timezone for Today and created-date labels", async () => {
    const nearMidnight = review("near-midnight", "Auckland today", { created_at: "2026-10-10T12:30:00.000Z" });
    const priorDay = review("prior-day", "Auckland yesterday", { created_at: "2026-10-09T12:29:59.000Z" });
    await render({ reviews: [nearMidnight, priorDay], selectedId: "near-midnight", displayTimeZone: "Pacific/Auckland", now: new Date("2026-10-11T02:00:00.000Z") });
    // Grouped by the Auckland day: the near-midnight item is Today (shown by time), the other Yesterday (shown by date).
    expect([...document.querySelectorAll(".inbox-date")].map((heading) => heading.textContent)).toEqual(["Today", "Yesterday"]);
    expect([...document.querySelectorAll(".inbox-row:not(.inbox-colhead) .c-time")].map((cell) => cell.textContent)).toEqual(["01:30", "10 Oct"]);
    await click("Advanced");
    await choose("Filter by created period", "today");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Auckland today");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).not.toContain("Auckland yesterday");
  });

  it("uses queue then detail with Back on narrow screens", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    await render({ selectedId: undefined });
    expect((document.querySelector("[aria-label='Review detail']") as HTMLElement).hidden).toBe(true);
    await click("Open proposal: Ship the pilot");
    expect((document.querySelector("[aria-label='Review queue']") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("[aria-label='Review detail']") as HTMLElement).hidden).toBe(false);
    await click("Back to review queue");
    expect((document.querySelector("[aria-label='Review queue']") as HTMLElement).hidden).toBe(false);
  });

  it("emits a brief notification after a decision", async () => {
    vi.useFakeTimers();
    const accept = vi.fn(async () => true);
    await render({ selectedId: "r1", onAccept: accept });
    await click("Accept task");
    expect(accept).toHaveBeenCalledOnce();
    expect(document.querySelector("[role='status']")?.textContent).toContain("Proposal accepted");
    await act(async () => vi.advanceTimersByTime(3500));
    expect(document.querySelector("[role='status']")).toBeNull();
  });

  it("shows loading, failure and empty states", async () => {
    await render({ reviews: [], loading: true });
    expect(document.body.textContent).toContain("Loading review queue");
    await act(async () => root!.render(<InboxWorkspace reviews={[]} objects={[]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris" error="Could not load proposals" onAccept={async () => true} onReject={async () => true} onSave={async () => true} />));
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Could not load proposals");
    await act(async () => root!.render(<InboxWorkspace reviews={[]} objects={[]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris" onAccept={async () => true} onReject={async () => true} onSave={async () => true} />));
    expect(document.body.textContent).toContain("Inbox zero");
    expect(document.body.textContent).toContain("Nothing waiting.");
    expect(document.body.textContent).not.toContain("See History"); // no handler, no button
  });

  it("explains read-only state and disables decisions", async () => {
    await render({ readOnly: true });
    expect(document.body.textContent).toContain("Read-only on this Mac");
    expect((document.querySelector("button.primary") as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks a duplicate in-flight decision and shows failures without completing", async () => {
    let release!: () => void;
    const accept = vi.fn(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    await render({ onAccept: accept });
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Accept task") as HTMLButtonElement;
    act(() => { button.click(); button.click(); });
    expect(accept).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    await act(async () => release());

    const reject = vi.fn(async () => { throw new Error("Conflict: proposal changed"); });
    await act(async () => root!.render(<InboxWorkspace reviews={[review("r3", "Ship the pilot")]} selectedId="r3" objects={[object("meeting-1", "meeting", "Pilot review")]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris" onAccept={async () => true} onReject={reject} onSave={async () => true} />));
    await click("Reject");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Conflict: proposal changed");
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).not.toContain("Rejected");
  });

  it("keeps the restricted marker visible while a decision saves", async () => {
    let release!: () => void;
    await render({ reviews: [review("restricted", "Private follow-up", { sensitivity: "restricted" })], selectedId: "restricted", onAccept: () => new Promise<boolean>((resolve) => { release = () => resolve(true); }) });
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toContain("Restricted");
    await click("Accept task");
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toContain("Restricted");
    await act(async () => release());
  });
  it("enables Accept summary when the stored title has surrounding spaces (#195)", async () => {
    await render({ reviews: [review("r3", "Summary: Weekly sync ", { review_type: "summary", target_object_type: "meeting", proposed_fields: { summary: "A concise summary." } })], selectedId: "r3" });
    const button = (name: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement;
    expect(button("Accept summary").disabled).toBe(false);
    expect(button("Save edits").disabled).toBe(true);
  });
});

/** PB-035: a stateful Inbox like the app's — a decided item leaves `reviews`, and the URL follows `onOpen`. */
describe("InboxWorkspace auto-advance (PB-035)", () => {
  const queue = () => [
    review("a", "Alpha task", { created_at: "2026-10-10T10:00:00Z" }),
    review("b", "Bravo task", { created_at: "2026-10-10T09:00:00Z" }),
    review("c", "Charlie decision", { created_at: "2026-10-10T08:00:00Z", target_object_type: "decision" })
  ];
  let opened: Array<[string, { replace?: boolean } | undefined]> = [];

  function Harness({ initial, selectedId }: { initial: ReturnType<typeof queue>; selectedId: string }) {
    const [reviews, setReviews] = React.useState(initial);
    const [route, setRoute] = React.useState<string | undefined>(selectedId);
    const decide = async (item: { frontmatter: { id: string } }) => { setReviews((current) => current.filter((entry) => entry.frontmatter.id !== item.frontmatter.id)); setRoute(undefined); return true; };
    return <InboxWorkspace reviews={reviews} selectedId={route} objects={[object("meeting-1", "meeting", "Pilot review")]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris"
      onOpen={(id, options) => { opened.push([id, options]); setRoute(id); }} onAccept={decide} onReject={decide} onSave={async () => true} />;
  }
  async function mount(selectedId: string, initial = queue()) {
    opened = [];
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Harness initial={initial} selectedId={selectedId} />));
  }
  const heading = () => document.querySelector("[aria-label='Review detail'] h2")?.textContent;
  const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label) as HTMLButtonElement;

  it("opens the item below after accept, replacing the URL", async () => {
    await mount("b");
    await click("Accept task");
    expect(heading()).toBe("Charlie decision");
    expect(opened.at(-1)).toEqual(["c", { replace: true }]);
  });

  it("opens the item above when the bottom item is rejected", async () => {
    await mount("c");
    await click("Reject");
    expect(heading()).toBe("Bravo task");
  });

  it("shows Inbox zero after the last item and moves focus to its heading", async () => {
    await mount("a", [review("a", "Alpha task")]);
    await click("Accept task");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Inbox zero");
    expect(document.activeElement?.textContent).toBe("Inbox zero");
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toContain("Select a proposal");
  });

  it("shows today's count and a working See History button on Inbox zero", async () => {
    const onSeeHistory = vi.fn();
    await render({ reviews: [], processedToday: 4, onSeeHistory });
    expect(document.querySelector("h3")?.textContent).toBe("Inbox zero");
    expect(queueText()).toContain("You processed 4 items today.");
    expect(document.querySelector("[aria-label='Review queue'] p b")?.textContent).toBe("4");
    await click("See History");
    expect(onSeeHistory).toHaveBeenCalledTimes(1);
  });

  it("says Nothing waiting when nothing was processed today", async () => {
    await render({ reviews: [], processedToday: 0, onSeeHistory: () => undefined });
    expect(queueText()).toContain("Nothing waiting.");
    expect(queueText()).not.toContain("You processed");
  });

  it("keeps No matching proposals, not Inbox zero, while filters hide items", async () => {
    await render({ processedToday: 3, onSeeHistory: () => undefined });
    await act(async () => { const input = document.querySelector("input[type='search']") as HTMLInputElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zzz"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(queueText()).toContain("No matching proposals");
    expect(queueText()).not.toContain("Inbox zero");
  });

  it("offers Clear filters when filters hide the remaining items", async () => {
    await mount("c");
    await tab("Decision");
    await click("Accept decision");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("No matching proposals");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("2 proposals are hidden by the filters.");
    await click("Clear filters");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Alpha task");
    expect(heading()).toBe("Alpha task");
  });

  it("keeps the same item open after Save edits", async () => {
    await mount("b");
    await type("Proposed title", "Bravo task, revised");
    await click("Save edits");
    expect(heading()).toBe("Bravo task");
  });

  it("moves with Previous/Next and the arrow keys, but not while typing", async () => {
    await mount("a");
    expect(button("Previous proposal").disabled).toBe(true);
    expect(document.querySelector(".inbox-step")?.textContent).toContain("1 of 3");
    await click("Next proposal");
    expect(heading()).toBe("Bravo task");
    expect(opened.at(-1)).toEqual(["b", undefined]);
    await click("Next proposal");
    expect(heading()).toBe("Charlie decision");
    expect(button("Next proposal").disabled).toBe(true);
    await click("Previous proposal");
    expect(heading()).toBe("Bravo task");
    await press("ArrowDown", document.querySelector("[aria-label='Proposed title']")!);
    expect(focusedTitle()).toBe("Bravo task"); // typing in a field: the key does nothing
  });
});

describe("InboxWorkspace keyboard shortcuts", () => {
  const reviews = () => [
    review("t", "Task one", { created_at: "2026-10-10T10:00:00Z" }),
    review("s", "Summary one", { created_at: "2026-10-10T09:00:00Z", review_type: "summary", target_object_type: "meeting", proposed_fields: { summary: "Short." } }),
    review("d", "Decision one", { created_at: "2026-10-10T08:00:00Z", target_object_type: "decision" })
  ];

  it("A accepts and R rejects the open item, whatever its type", async () => {
    const accept = vi.fn(async () => true); const reject = vi.fn(async () => true);
    await render({ reviews: reviews(), selectedId: "s", onAccept: accept, onReject: reject });
    await press("a");
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ frontmatter: expect.objectContaining({ id: "s" }) }));
    act(() => root?.unmount());
    await render({ reviews: reviews(), selectedId: "t", onAccept: accept, onReject: reject });
    await press("R");
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ frontmatter: expect.objectContaining({ id: "t" }) }));
  });

  it("S saves edits; A waits until they are saved", async () => {
    const accept = vi.fn(async () => true); const save = vi.fn(async () => true);
    await render({ reviews: reviews(), selectedId: "t", onAccept: accept, onSave: save });
    await type("Proposed title", "Task one, revised");
    await press("a");
    expect(accept).not.toHaveBeenCalled();
    await press("s");
    expect(save).toHaveBeenCalledWith(expect.anything(), { title: "Task one, revised" });
  });

  it("ignores keys while typing, with modifiers, or held down", async () => {
    const accept = vi.fn(async () => true);
    await render({ reviews: reviews(), selectedId: "t", onAccept: accept });
    await press("a", document.querySelector("[aria-label='Search proposals']")!);
    await press("a", document.body, { metaKey: true });
    await press("a", document.body, { repeat: true });
    expect(accept).not.toHaveBeenCalled();
  });

  it("X ticks the open item and 1–6 switch tabs, opening the tab's first item", async () => {
    const opened = vi.fn();
    await render({ reviews: reviews(), selectedId: "t", onOpen: opened });
    await press("x");
    expect((document.querySelector("[aria-label='Select proposal: Task one']") as HTMLInputElement).checked).toBe(true);
    await press("2");
    expect(document.querySelector("[role='tab'][aria-selected='true']")?.textContent).toBe("Summary 1");
    expect(document.querySelector("[aria-label='Review detail'] h2")?.textContent).toBe("Summary one");
    expect(opened).toHaveBeenLastCalledWith("s", { replace: true });
    await press("3");
    expect(document.querySelector("[role='tab'][aria-selected='true']")?.textContent).toBe("Decision 1");
    await press("1");
    expect(document.querySelector("[role='tab'][aria-selected='true']")?.textContent).toBe("All 3");
  });

  it("shows each shortcut on its button", async () => {
    await render({ reviews: reviews(), selectedId: "t" });
    const shortcut = (name: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === name)?.getAttribute("aria-keyshortcuts");
    expect([shortcut("Accept task"), shortcut("Reject"), shortcut("Save edits")]).toEqual(["A", "R", "S"]);
  });
});

describe("InboxWorkspace bulk actions", () => {
  const reviews = () => [
    review("a", "Alpha task", { created_at: "2026-10-10T10:00:00Z" }),
    review("b", "Bravo task", { created_at: "2026-10-10T09:00:00Z" }),
    review("l", "Link owner", { created_at: "2026-10-10T08:00:00Z", review_type: "link-resolution" }),
    review("c", "Charlie decision", { created_at: "2026-10-10T07:00:00Z", target_object_type: "decision" })
  ];
  const tick = async (title: string) => act(async () => (document.querySelector(`[aria-label='Select proposal: ${title}']`) as HTMLInputElement).click());
  const isTicked = (title: string) => (document.querySelector(`[aria-label='Select proposal: ${title}']`) as HTMLInputElement).checked;

  it("Select all ticks the items in view; Deselect all clears them; switching tab clears them", async () => {
    await render({ reviews: reviews(), selectedId: "a" });
    expect(document.body.textContent).not.toContain("Accept selected");
    await click("Select all");
    expect(["Alpha task", "Bravo task", "Link owner", "Charlie decision"].every(isTicked)).toBe(true);
    expect(document.querySelector("[aria-label='Bulk actions']")?.textContent).toContain("4 selected");
    await click("Deselect all");
    expect(isTicked("Alpha task")).toBe(false);
    await tab("Task");
    await click("Select all");
    await tab("All");
    expect(isTicked("Alpha task")).toBe(false);
  });

  it("bulk Accept skips link proposals and moves off a decided open item", async () => {
    const decideMany = vi.fn(async (items: Array<{ frontmatter: { id: string } }>) => ({ decided: items.map((item) => item.frontmatter.id), failures: [] }));
    const opened = vi.fn();
    await render({ reviews: reviews(), selectedId: "a", onDecideMany: decideMany, onOpen: opened });
    await tick("Alpha task"); await tick("Link owner"); await tick("Bravo task");
    await click("Accept selected (2)");
    expect(decideMany).toHaveBeenCalledWith([expect.objectContaining({ frontmatter: expect.objectContaining({ id: "a" }) }), expect.objectContaining({ frontmatter: expect.objectContaining({ id: "b" }) })], "accepted");
    expect(document.querySelector("[role='status']")?.textContent).toBe("2 proposals accepted · 1 skipped (link or merge needs a choice)");
    expect(opened).toHaveBeenLastCalledWith("l", { replace: true });
  });

  it("bulk Reject does not ask first, includes link proposals, and reports failures", async () => {
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
    const decideMany = vi.fn(async () => ({ decided: ["b"], failures: ["Link owner: Conflict"] }));
    await render({ reviews: reviews(), selectedId: "a", onDecideMany: decideMany });
    await tick("Bravo task"); await tick("Link owner");
    await click("Reject selected (2)");
    expect(confirm).not.toHaveBeenCalled();
    expect(decideMany).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ frontmatter: expect.objectContaining({ id: "l" }) })]), "rejected");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("1 not rejected: Link owner: Conflict");
  });

  it("falls back to one onAccept per item without onDecideMany", async () => {
    const accept = vi.fn(async () => true);
    await render({ reviews: reviews(), selectedId: "c", onAccept: accept });
    await tick("Alpha task"); await tick("Bravo task");
    await click("Accept selected (2)");
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("disables bulk actions when read-only", async () => {
    await render({ reviews: reviews(), selectedId: "a", readOnly: true });
    await tick("Alpha task");
    expect(([...document.querySelectorAll("button")].find((item) => item.textContent === "Accept selected (1)") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("InboxWorkspace grouped list (#237)", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const objects = [object("meeting-1", "meeting", "Alpha sync"), object("meeting-2", "meeting", "Beta review"), object("p1", "person", "Paula Martin")];
  const rowTitles = () => [...document.querySelectorAll(".inbox-row:not(.inbox-colhead) .inbox-row-open strong")].map((item) => item.textContent);
  const sources = () => [...document.querySelectorAll(".inbox-source")].map((item) => item.textContent?.replace(/\s+/g, " ").trim());
  const detailTitle = () => document.querySelector("[aria-label='Review detail'] h2")?.textContent;
  const items = [
    review("a1", "Alpha newest", { created_at: "2026-10-10T09:00:00Z" }),
    review("b1", "Beta item", { created_at: "2026-10-10T08:00:00Z", source_meeting_id: "meeting-2", target_object_type: "decision" }),
    review("a2", "Alpha older", { created_at: "2026-10-10T05:00:00Z", proposed_fields: { owner_person_id: "p1", due_on: "2026-10-28" }, primary_project_id: "pr1", confidence_label: "Low" }),
    review("o1", "Run item", { created_at: "2026-10-01T05:00:00Z", source_meeting_id: undefined, agent_run_id: "run-7", review_type: "summary", target_object_type: "meeting", proposed_fields: { summary: "s" } }),
    review("x1", "Loose item", { created_at: "2026-10-01T04:00:00Z", source_meeting_id: undefined })
  ];
  const props = { reviews: items, objects, now, selectedId: "a1", choices: { people: [{ id: "p1", title: "Paula Martin" }], projects: [{ id: "pr1", title: "Store rollout" }], clients: [], products: [] } };
  afterEach(() => { try { localStorage.clear(); } catch { /* none */ } });

  it("groups by date, then Source meeting, Agent run and Other, with counts, and lists rows in that order", async () => {
    await render(props);
    expect([...document.querySelectorAll(".inbox-date")].map((item) => item.textContent)).toEqual(["Today", "Older"]);
    expect(sources()).toEqual(["▾ Meeting · Alpha sync 2", "▾ Meeting · Beta review 1", "▾ Agent run · run-7 1", "▾ Other 1"]);
    expect(rowTitles()).toEqual(["Alpha newest", "Alpha older", "Beta item", "Run item", "Loose item"]);
  });

  it("shows the Review kind badge and Owner, Due, Project and Time cells", async () => {
    await render(props);
    const badges = [...document.querySelectorAll(".inbox-row:not(.inbox-colhead) .inbox-badge")].map((item) => item.textContent);
    expect(badges).toEqual(["Task", "Task", "Decision", "Summary", "Task"]);
    const older = document.querySelectorAll(".inbox-row:not(.inbox-colhead)")[1]!;
    expect([".c-owner", ".c-due", ".c-project", ".c-time"].map((cell) => older.querySelector(cell)?.textContent)).toEqual(["Paula Martin", "28 Oct", "Store rollout", "07:00"]);
    expect(older.querySelector(".inbox-low")?.getAttribute("data-tip")).toContain("Low confidence");
    expect(document.querySelectorAll(".inbox-low[data-tip]")).toHaveLength(1);
    expect(document.querySelector(".inbox-legend")?.textContent).toContain("Low confidence");
  });

  it("collapses a group and moves focus with the arrow keys over it", async () => {
    await render({ ...props, selectedId: "a2" });
    const header = [...document.querySelectorAll(".inbox-source")].find((item) => item.textContent?.includes("Alpha sync")) as HTMLButtonElement;
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(rowTitles()).toEqual(["Beta item", "Run item", "Loose item"]);
    expect(focusedTitle()).toBe("Beta item"); // the focused row was collapsed away
    await press("ArrowDown");
    expect(focusedTitle()).toBe("Run item");
    expect(detailTitle()).toBe("Alpha older");
    await act(async () => header.click());
    expect(rowTitles()).toHaveLength(5);
  });

  it("grouping works inside a tab", async () => {
    await render(props);
    await tab("Decision");
    expect(sources()).toEqual(["▾ Meeting · Beta review 1"]);
    await tab("Summary");
    expect(sources()).toEqual(["▾ Agent run · run-7 1"]);
  });

  it("auto-advance follows the grouped order, not the time order", async () => {
    await render(props);
    await click("Accept task"); // by time Beta item is next; in the grouped list Alpha older is
    expect(detailTitle()).toBe("Alpha older");
  });

  it("offers Auto, 1 line and 2 lines; 2 lines puts Owner, Due and Project on a sub line, and the choice is remembered", async () => {
    await render(props);
    expect(document.querySelector(".inbox-colhead")).not.toBeNull();
    await click("2 lines");
    expect(document.querySelector(".inbox-colhead")).toBeNull();
    expect(document.querySelectorAll(".inbox-row-sub")[1]?.textContent).toBe("Paula MartinDue 28 OctStore rollout");
    expect(localStorage.getItem("lifeos.inboxRowLayout")).toBe("two");
    act(() => root?.unmount()); document.body.innerHTML = "";
    await render(props);
    expect(document.querySelector("[aria-label='Row layout'] [aria-pressed='true']")?.textContent).toBe("2 lines");
    await click("Auto");
    expect(localStorage.getItem("lifeos.inboxRowLayout")).toBeNull();
  });
});
