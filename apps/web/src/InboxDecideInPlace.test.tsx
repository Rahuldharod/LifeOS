// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject, ReviewItem } from "@lifeos/contracts";
import { InboxWorkspace } from "./InboxWorkspace.js";
import { inboxShortcuts } from "./InboxShortcutSheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** PB-046: decide the Focused row in place. The row animates out before its request goes, Undo slides it back, and in Split view A/R asks which item when the Focused row is not the Open item. */
const review = (id: string, title: string, created: string): ReviewItem => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}`, evidence: {},
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title, created_at: created, updated_at: created, updated_by_device: "test", review_type: "create", target_object_type: "task", status: "pending", confidence_label: "High", source_meeting_id: "meeting-1", source_ids: [], proposed_fields: { title } }
});
const meeting: LifeObject = { relativePath: "meetings/meeting-1.md", contentHash: "m", body: "# Pilot review", frontmatter: { id: "meeting-1", type: "meeting", schema_version: 1, revision: 1, title: "Pilot review", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z" } };
const queue = () => [review("a", "Alpha task", "2026-10-10T10:00:00Z"), review("b", "Bravo task", "2026-10-10T09:00:00Z"), review("c", "Charlie task", "2026-10-10T08:00:00Z")];

let root: Root | undefined;
const decided: string[] = [];
/** Where each decided row's class list stood when its request went: the animation has run by then. */
const classesAtRequest: string[] = [];
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; decided.length = 0; classesAtRequest.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Harness({ selectedId, rowExitMs }: { selectedId?: string; rowExitMs: number }) {
  const [gone, setGone] = React.useState<Set<string>>(() => new Set());
  const [route, setRoute] = React.useState(selectedId);
  const decide = (outcome: string) => async (item: { frontmatter: { id: string } }) => {
    const id = item.frontmatter.id;
    classesAtRequest.push(document.querySelector(`[data-review-id='${id}']`)?.className ?? "");
    decided.push(`${outcome}:${id}`); setGone((current) => new Set([...current, id])); return true;
  };
  return <InboxWorkspace rowExitMs={rowExitMs} reviews={queue().filter((entry) => !gone.has(entry.frontmatter.id))} selectedId={route} objects={[meeting]} labels={new Map()} choices={{ people: [], projects: [], clients: [], products: [] }} readOnly={false} busy={false} displayTimeZone="Europe/Paris" now={new Date("2026-10-10T12:00:00Z")}
    onOpen={(id) => setRoute(id)} onAccept={decide("accepted")} onReject={decide("rejected")} onSave={async () => true}
    onDecideMany={async (items, outcome) => { for (const item of items) await decide(outcome)(item); return { decided: items.map((item) => item.frontmatter.id), failures: [] }; }}
    onUndo={async (ids) => { setGone((current) => new Set([...current].filter((id) => !ids.includes(id)))); return { undone: ids, refused: [] }; }} />;
}

async function mount(selectedId: string | undefined, rowExitMs = 0) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Harness selectedId={selectedId} rowExitMs={rowExitMs} />));
}
const press = async (key: string, target: EventTarget = document.body) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const wait = async (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const row = (id: string) => document.querySelector<HTMLElement>(`[data-review-id='${id}']`);
const focusedTitle = () => document.querySelector(".inbox-row.focused .inbox-row-open strong")?.textContent;
const detailTitle = () => document.querySelector("[aria-label='Review detail'] h2")?.textContent;
const question = () => document.querySelector<HTMLElement>("[role='dialog'].inbox-apply-to");
const answer = async (key: string) => { expect(question(), "Apply to question").toBeTruthy(); await press(key, globalThis.document.activeElement ?? question()!); };

describe("the row animates out, then its request goes", () => {
  it("A on the Focused row marks it leaving, moves focus on at once, and sends the request after the animation", async () => {
    await mount("a", 40);
    await press("a");
    expect(row("a")?.classList.contains("leaving")).toBe(true);
    expect(row("a")?.getAttribute("aria-hidden")).toBe("true");
    expect(decided).toEqual([]); // not sent yet: the row is still animating
    expect(focusedTitle()).toBe("Bravo task");
    await wait(80);
    expect(decided).toEqual(["accepted:a"]);
    expect(classesAtRequest[0]).toContain("leaving");
    expect(row("a")).toBeNull();
    expect(document.querySelector("[role='status']")?.textContent).toContain("Proposal accepted");
  });

  it("bulk Accept animates every ticked row out the same way", async () => {
    await mount(undefined, 40);
    await act(async () => (document.querySelector("[aria-label='Select proposal: Alpha task']") as HTMLInputElement).click());
    await act(async () => (document.querySelector("[aria-label='Select proposal: Bravo task']") as HTMLInputElement).click());
    await press("a");
    expect([row("a")?.classList.contains("leaving"), row("b")?.classList.contains("leaving"), row("c")?.classList.contains("leaving")]).toEqual([true, true, false]);
    expect(decided).toEqual([]);
    await wait(80);
    expect(decided).toEqual(["accepted:a", "accepted:b"]);
    expect(classesAtRequest.every((classes) => classes.includes("leaving"))).toBe(true);
  });

  it("Undo slides the row back into its place", async () => {
    await mount("a", 40);
    await press("r");
    await wait(80);
    expect(row("a")).toBeNull();
    await press("z");
    expect(row("a")?.classList.contains("arriving")).toBe(true);
    expect(focusedTitle()).toBe("Alpha task");
    await wait(400);
    expect(row("a")?.classList.contains("arriving")).toBe(false);
  });

  it("reduced motion skips the animation: the request goes at once", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    await mount("a", 40);
    await press("a");
    expect(decided).toEqual(["accepted:a"]);
    expect(classesAtRequest[0]).not.toContain("leaving");
  });
});

describe("Split view asks which item when the Focused row is not the Open item", () => {
  it("F applies to the Focused row; the Open item stays open", async () => {
    await mount("a");
    await press("ArrowDown"); // focus Bravo, Alpha stays open
    await press("a");
    expect(decided).toEqual([]);
    expect(question()?.textContent).toContain("Accept · Apply to:");
    expect(question()?.textContent).toContain("Bravo task");
    await answer("f");
    expect(question()).toBeNull();
    expect(decided).toEqual(["accepted:b"]);
    expect(detailTitle()).toBe("Alpha task");
  });

  it("O applies to the Open item", async () => {
    await mount("a");
    await press("ArrowDown");
    await press("r");
    await answer("o");
    expect(decided).toEqual(["rejected:a"]);
  });

  it("Esc cancels and nothing is decided; focus stays on the Focused row", async () => {
    await mount("a");
    await press("ArrowDown");
    await press("a");
    await answer("Escape");
    expect(question()).toBeNull();
    expect(decided).toEqual([]);
    expect(focusedTitle()).toBe("Bravo task");
  });

  it("does not ask when the Focused row is the Open item", async () => {
    await mount("a");
    await press("a");
    expect(question()).toBeNull();
    expect(decided).toEqual(["accepted:a"]);
  });

  it("lists F / O in the shortcut sheet", () => {
    expect(inboxShortcuts.some((entry) => entry.keys === "F / O" && entry.what.includes("Focused row") && entry.what.includes("Open item"))).toBe(true);
  });
});
