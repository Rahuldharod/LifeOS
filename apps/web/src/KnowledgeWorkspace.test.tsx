// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { KnowledgeWorkspace } from "./KnowledgeWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const object = (id: string, type: string, title: string, fields: Record<string, unknown> = {}): LifeObject => ({
  relativePath: `${type}/${id}.md`, contentHash: `${id}-hash`, body: String(fields.body ?? `# ${title}\n\nSynthetic published content.`),
  frontmatter: { id, type, schema_version: 1, revision: 1, title, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", ...fields }
});

const notes = [
  object("knowledge-one", "knowledge-note", "Portable loyalty research", { area: "learning", source_ids: ["source-one"], related_object_ids: ["project-one", "person-one"] }),
  object("knowledge-two", "knowledge-note", "Household maintenance", { area: "maintenance", source_ids: ["source-two"], created_at: "2026-09-01T08:00:00Z" })
];
const sources = [
  object("source-one", "source", "Research paper", { source_type: "pasted-text" }),
  object("source-two", "source", "Vendor guide", { source_type: "web-link" })
];
const base = {
  notes, sources, projects: [{ id: "project-one", title: "Loyalty launch" }], people: [{ id: "person-one", title: "Sam Example" }],
  selectedId: "knowledge-one", loading: false, readOnly: false, error: null, displayTimeZone: "Europe/Paris",
  onOpen: vi.fn(), onBack: vi.fn(), onPreserve: vi.fn(async () => undefined)
};

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); root = undefined; });

async function render(props: Partial<React.ComponentProps<typeof KnowledgeWorkspace>> = {}) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<KnowledgeWorkspace {...base} {...props} />));
}

async function click(name: string) {
  const control = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLButtonElement;
  await act(async () => control.click());
}

async function input(label: string, value: string) {
  const control = document.querySelector(`[aria-label='${label}']`) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function change(label: string, value: string) {
  const control = document.querySelector(`[aria-label='${label}']`) as HTMLSelectElement | HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")!.set!.call(control, value); control.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("KnowledgeWorkspace", () => {
  it("makes published Knowledge Notes the primary browse-and-read workspace", async () => {
    await render();
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).toContain("Portable loyalty research");
    expect(document.querySelector("[aria-label='Knowledge detail']")?.textContent).toContain("Synthetic published content");
    expect(document.body.textContent).toContain("Published Knowledge Notes");
  });

  it("keeps Search and Area visible and puts source, period, project and person under Advanced", async () => {
    await render({ selectedId: undefined });
    expect(document.querySelector("input[aria-label='Search knowledge']")).toBeTruthy();
    expect(document.querySelector("select[aria-label='Filter by area']")).toBeTruthy();
    expect(document.querySelector("select[aria-label='Filter by source type']")).toBeNull();
    await click("Advanced");
    expect(document.querySelector("select[aria-label='Filter by source type']")).toBeTruthy();
    expect(document.querySelector("input[aria-label='Published from']")).toBeTruthy();
    expect(document.querySelector("select[aria-label='Filter by project']")).toBeTruthy();
    expect(document.querySelector("select[aria-label='Filter by person']")).toBeTruthy();
  });

  it("filters published notes through the visible controls", async () => {
    await render({ selectedId: undefined });
    await input("Search knowledge", "household");
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).toContain("Household maintenance");
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).not.toContain("Portable loyalty research");
  });

  it("filters projects and people through canonical related_object_ids", async () => {
    await render({ selectedId: undefined });
    await click("Advanced");
    await change("Filter by project", "project-one");
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).toContain("Portable loyalty research");
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).not.toContain("Household maintenance");
    await change("Filter by project", "");
    await change("Filter by person", "person-one");
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).toContain("Portable loyalty research");
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).not.toContain("Household maintenance");
  });

  it("uses the display timezone for published days and day filters", async () => {
    const nearMidnight = object("knowledge-midnight", "knowledge-note", "Midnight research", {
      source_ids: ["source-one"],
      created_at: "2026-10-01T23:30:00.000Z"
    });
    await render({ notes: [nearMidnight], selectedId: undefined, displayTimeZone: "Pacific/Auckland" });
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).toContain("Published 2026-10-02");
    await click("Advanced");
    await change("Published from", "2026-10-02");
    await change("Published to", "2026-10-02");
    expect(document.querySelector("[aria-label='Knowledge list']")?.textContent).toContain("Midnight research");
  });

  it("opens Preserve Source as a focused panel and reports durable completion", async () => {
    const preserve = vi.fn(async () => undefined);
    await render({ onPreserve: preserve });
    expect(document.querySelector("[role='dialog']")).toBeNull();
    await click("Preserve Source");
    expect(document.querySelector("[role='dialog'][aria-label='Preserve Source']")).toBeTruthy();
    await input("Source title", "Synthetic source");
    await input("Source text", "Portable files remain authoritative.");
    await click("Preserve");
    expect(preserve).toHaveBeenCalledWith("Synthetic source", "Portable files remain authoritative.");
    expect(document.querySelector("[role='status']")?.textContent).toContain("Source preserved in Markdown");
  });

  it("keeps intake content and reports a preservation failure", async () => {
    await render({ onPreserve: vi.fn(async () => { throw new Error("Disk unavailable"); }) });
    await click("Preserve Source");
    await input("Source title", "Synthetic source");
    await input("Source text", "Keep this text safe.");
    await click("Preserve");
    expect(document.querySelector("[role='alert']")?.textContent).toBe("Disk unavailable");
    expect((document.querySelector("[aria-label='Source text']") as HTMLTextAreaElement).value).toBe("Keep this text safe.");
  });

  it("renders empty and loading states", async () => {
    await render({ notes: [], selectedId: undefined });
    expect(document.body.textContent).toContain("No published Knowledge Notes yet");
    await act(async () => root!.render(<KnowledgeWorkspace {...base} notes={[]} selectedId={undefined} loading />));
    expect(document.querySelector("[role='status']")?.textContent).toContain("Loading published Knowledge Notes");
  });

  it("uses list then detail with Back on narrow screens", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, media: "(max-width: 760px)", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
    const back = vi.fn();
    await render({ onBack: back });
    expect((document.querySelector("[aria-label='Knowledge list']") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("[aria-label='Knowledge detail']") as HTMLElement).hidden).toBe(false);
    await click("Back to knowledge");
    expect(back).toHaveBeenCalledOnce();
  });
});
