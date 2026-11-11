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
    expect(document.querySelector("select[aria-label='Filter by proposal type']")).toBeTruthy();
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
    await choose("Filter by proposal type", "Updates");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).not.toContain("Ship the pilot");
    await choose("Filter by proposal type", "");
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

  it("offers user-facing proposal categories across create targets and updates", async () => {
    const reviews = [
      review("task", "Task proposal"),
      review("decision", "Decision proposal", { target_object_type: "decision" }),
      review("point", "Open point proposal", { target_object_type: "open-point" }),
      review("update", "Update proposal", { review_type: "update" }),
      review("summary", "Summary proposal", { review_type: "summary", target_object_type: "meeting" })
    ];
    await render({ reviews, selectedId: "task" });
    const typeFilter = document.querySelector("select[aria-label='Filter by proposal type']") as HTMLSelectElement;
    expect([...typeFilter.options].map((option) => option.textContent)).toEqual(["All proposal types", "Tasks", "Decisions", "Open points", "Updates"]);
    await choose("Filter by proposal type", "Tasks");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Task proposal");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).not.toContain("Decision proposal");
    await choose("Filter by proposal type", "Decisions");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Decision proposal");
    await choose("Filter by proposal type", "Open points");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Open point proposal");
    await choose("Filter by proposal type", "Updates");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Update proposal");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Summary proposal");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).not.toContain("Task proposal");
  });

  it("uses the selected display timezone for Today and created-date labels", async () => {
    const nearMidnight = review("near-midnight", "Auckland today", { created_at: "2026-10-10T12:30:00.000Z" });
    const priorDay = review("prior-day", "Auckland yesterday", { created_at: "2026-10-09T12:29:59.000Z" });
    await render({ reviews: [nearMidnight, priorDay], selectedId: "near-midnight", displayTimeZone: "Pacific/Auckland", now: new Date("2026-10-11T02:00:00.000Z") });
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Auckland todayCreate task · 2026-10-11");
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
    expect(document.body.textContent).toContain("Inbox clear");
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
  const press = async (key: string, target: EventTarget = document.body) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

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

  it("shows Inbox clear after the last item", async () => {
    await mount("a", [review("a", "Alpha task")]);
    await click("Accept task");
    expect(document.querySelector("[aria-label='Review queue']")?.textContent).toContain("Inbox clear");
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toContain("Select a proposal");
  });

  it("offers Clear filters when filters hide the remaining items", async () => {
    await mount("c");
    await choose("Filter by proposal type", "Decisions");
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
    await press("ArrowDown");
    expect(heading()).toBe("Charlie decision");
    expect(button("Next proposal").disabled).toBe(true);
    await press("ArrowUp");
    expect(heading()).toBe("Bravo task");
    await press("ArrowDown", document.querySelector("[aria-label='Proposed title']")!);
    expect(heading()).toBe("Bravo task");
  });
});
