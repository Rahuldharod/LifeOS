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
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it("keeps completion inline and emits a brief notification", async () => {
    vi.useFakeTimers();
    const accept = vi.fn(async () => true);
    await render({ selectedId: "r1", onAccept: accept });
    await click("Accept task");
    expect(accept).toHaveBeenCalledOnce();
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toContain("Accepted");
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

  it("keeps the restricted marker visible through a decision", async () => {
    await render({ reviews: [review("restricted", "Private follow-up", { sensitivity: "restricted" })], selectedId: "restricted" });
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toContain("Restricted");
    await click("Accept task");
    expect(document.querySelector("[aria-label='Review detail']")?.textContent).toMatch(/Restricted.*Accepted|Accepted.*Restricted/s);
  });
});
