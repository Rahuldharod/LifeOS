// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionDetail, LifeObject, OpenPointDetail } from "@lifeos/contracts";

const call = vi.fn();
vi.mock("./api.js", () => ({ api: (...args: unknown[]) => call(...args) }));
import { DecisionsPage } from "./DecisionsPage.js";
import { OpenPointsPage } from "./OpenPointsPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const object = (id: string, type: string, title: string, fields: Record<string, unknown> = {}): LifeObject => ({ relativePath: `${type}s/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}`, frontmatter: { id, type, title, schema_version: 1, revision: 1, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", ...fields } });
const decision = object("d1", "decision", "Pilot loyalty offer", { status: "active", decision_text: "Pilot in Lyon", rationale: "Representative stores", decided_at: "2026-10-10T09:00:00Z" });
const point = object("p1", "open-point", "Who owns sign-off?", { status: "open", raised_at: "2026-10-09T09:00:00Z", sensitivity: "normal" });
const source = object("s1", "source", "Workshop transcript", { source_type: "meet-transcript" });
const decisionDetail: DecisionDetail = { decision, sources: [source], people: [], evidence: [{ field: "decision_text", sourceId: "s1", sourceTitle: "Workshop transcript", fragmentId: "f1", text: "Lyon has representative stores" }] };
const pointDetail: OpenPointDetail = { openPoint: point, sources: [source], people: [], evidence: [{ field: "title", sourceId: "s1", sourceTitle: "Workshop transcript", fragmentId: "f2", text: "Ownership is unclear" }] };
const common = { projects: [] as LifeObject[], clients: [] as LifeObject[], products: [] as LifeObject[], people: [] as LifeObject[], busy: false, readOnly: false, timeZone: "Europe/Paris", run: async (action: () => Promise<void>) => { await action(); return true; }, onOpen: vi.fn(), onChanged: async () => undefined, formatDate: (value: unknown) => String(value) };
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; call.mockReset(); vi.restoreAllMocks(); });
async function settle() { await act(async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function click(name: string) { const button = [...document.querySelectorAll("button, summary")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLElement; await act(async () => button.click()); await settle(); }
async function input(label: string, value: string) { const control = document.querySelector(`[aria-label='${label}']`) as HTMLInputElement; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function mount(page: React.ReactNode) { root = createRoot(document.body.appendChild(document.createElement("div"))); await act(async () => root!.render(page)); await settle(); }

describe("Decisions and Open Points workspaces (#136)", () => {
  it("keeps search and status visible and relationships/dates under Advanced", async () => {
    call.mockImplementation(async (endpoint: string) => endpoint === "GET /api/v1/decisions" ? [decision] : decisionDetail);
    await mount(<DecisionsPage {...common} highlightId="d1" />);
    expect(document.querySelector("[aria-label='Search decisions']")).toBeTruthy();
    expect(document.querySelector("[aria-label='Filter decisions by status']")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Decided from");
    await click("Advanced");
    expect(document.body.textContent).toMatch(/Project.*Client.*Product.*Person.*Decided from.*Decided to/s);
    await input("Search decisions", "missing");
    expect(document.body.textContent).toContain("No decisions match these filters");
  });

  it("opens a blank Decision editor with dirty feedback and keeps read-only creation disabled", async () => {
    call.mockImplementation(async (endpoint: string) => endpoint === "GET /api/v1/decisions" ? [] : endpoint === "POST /api/v1/decisions" ? decision : decisionDetail);
    await mount(<DecisionsPage {...common} />);
    await click("New Decision");
    expect((document.querySelector("[aria-label='Decision title']") as HTMLInputElement).value).toBe("");
    expect(document.querySelector("[role='status']")?.textContent).toBe("Not saved yet");
    await input("Decision title", "Choose Lyon");
    expect(document.querySelector("[role='status']")?.textContent).toBe("Unsaved changes");
    await click("Save");
    expect(call).toHaveBeenCalledWith("POST /api/v1/decisions", expect.objectContaining({ body: { fields: expect.objectContaining({ title: "Choose Lyon", sensitivity: "normal" }) } }));
    act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined;
    await mount(<DecisionsPage {...common} readOnly />);
    expect((document.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("expands Supersede inline while keeping evidence visible and puts utilities in More", async () => {
    call.mockImplementation(async (endpoint: string) => endpoint === "GET /api/v1/decisions" ? [decision] : decisionDetail);
    await mount(<DecisionsPage {...common} highlightId="d1" />);
    expect(document.body.textContent).toContain("Lyon has representative stores");
    await click("Supersede…");
    expect(document.body.textContent).toMatch(/Pilot loyalty offer.*Lyon has representative stores/s);
    expect(document.querySelector("[aria-label='New decision that supersedes this one']")).toBeTruthy();
    await click("More");
    expect(document.body.textContent).toMatch(/Copy link.*History.*Mark reversed/s);
    expect(document.body.textContent).toContain("Sensitivity");
  });

  it("shows empty Open Points, then opens blank creation and inline lifecycle forms", async () => {
    call.mockResolvedValueOnce([]);
    await mount(<OpenPointsPage {...common} />);
    expect(document.body.textContent).toContain("No open points yet");
    await click("New Open Point");
    expect((document.querySelector("[aria-label='Open point title']") as HTMLInputElement).value).toBe("");
    act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; call.mockReset();
    call.mockImplementation(async (endpoint: string) => endpoint === "GET /api/v1/open-points" ? [point] : endpoint === "GET /api/v1/decisions" ? [decision] : pointDetail);
    await mount(<OpenPointsPage {...common} highlightId="p1" />);
    await click("Resolve…");
    expect(document.querySelector("[aria-label='Resolve this open point']")).toBeTruthy();
    expect(document.body.textContent).toContain("Ownership is unclear");
    await click("Cancel"); await click("More");
    expect(document.body.textContent).toMatch(/Copy link.*History.*Close/s);
    await click("Close…");
    expect(document.querySelector("[aria-label='Close this open point']")).toBeTruthy();
  });
});
