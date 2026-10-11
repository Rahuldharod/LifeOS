// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { noNoteFilters } from "./noteFilters.js";
import { NotesWorkspace, type NoteEditorMode } from "./NotesWorkspace.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = (id: string, title: string, fields: Record<string, unknown> = {}): LifeObject => ({
  relativePath: `notes/${id}.md`, contentHash: `${id}-hash`, body: fields.body as string ?? `# ${title}\n\nSynthetic body`,
  frontmatter: { id, type: "knowledge-note", schema_version: 1, revision: 1, title, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", ...fields }
});

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); root = undefined; });

const baseProps = {
  notes: [note("one", "Project brief"), note("two", "Meeting notes", { type: "meeting-note" })],
  openCount: 2, deletedCount: 1, tab: "open" as const, selectedId: "one", query: "", filters: noNoteFilters,
  projects: [{ id: "project", title: "Project Alpha" }], clients: [], products: [], people: [{ id: "person", title: "Sam Example" }],
  timeZone: "Europe/Paris", loading: false, readOnly: false, conflictedNoteIds: new Set<string>(),
  onQueryChange: vi.fn(), onFiltersChange: vi.fn(), onTabChange: vi.fn(), onOpen: vi.fn(), onBack: vi.fn(),
  emptyMessage: "No notes have been created yet.",
  renderOpenNote: (mode: NoteEditorMode, readOnly: boolean) => <div data-editor-mode={mode}><textarea aria-label="Note body" disabled={readOnly} /></div>,
  deletedDetail: <article>Deleted note detail</article>, conflictDetail: <article>Conflict detail</article>
};

async function render(props: Partial<React.ComponentProps<typeof NotesWorkspace>> = {}) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<NotesWorkspace {...baseProps} {...props} />));
}

async function click(name: string) {
  const control = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLButtonElement;
  await act(async () => control.click());
}

describe("NotesWorkspace", () => {
  it("keeps Search and note type visible while advanced context and date filters stay disclosed", async () => {
    await render();
    expect(document.querySelector("input[aria-label='Search notes']")).toBeTruthy();
    expect(document.body.textContent).toContain("Type");
    expect(document.body.textContent).not.toContain("Project Alpha");
    expect(document.querySelector("input[type='date']")).toBeNull();
    await click("Advanced");
    expect(document.querySelector("input[aria-label='Project']")).toBeTruthy();
    expect(document.querySelector("input[aria-label='Person']")).toBeTruthy();
    expect(document.querySelectorAll("input[type='date']")).toHaveLength(2);
  });

  it("opens every selected note in Visual while keeping Markdown and Preview available", async () => {
    await render();
    expect(document.querySelector("[data-editor-mode='visual']")).toBeTruthy();
    await click("Markdown");
    expect(document.querySelector("[data-editor-mode='write']")).toBeTruthy();
    await click("Preview");
    expect(document.querySelector("[data-editor-mode='preview']")).toBeTruthy();
    await act(async () => root!.render(<NotesWorkspace {...baseProps} selectedId="two" />));
    expect(document.querySelector("[data-editor-mode='visual']")).toBeTruthy();
  });

  it("uses a resizable desktop split and a list-first narrow workflow with Back", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, media: "(max-width: 760px)", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })));
    const back = vi.fn();
    await render({ onBack: back });
    expect(document.querySelector("[role='separator'][aria-label*='Resize']")).toBeNull();
    expect(document.querySelector(".notes-workspace.detail-open")).toBeTruthy();
    expect((document.querySelector("[aria-label='Notes list']") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector("[aria-label='Note detail']") as HTMLElement).hidden).toBe(false);
    expect(document.body.textContent).toContain("Back to notes");
    await click("Back to notes");
    expect(back).toHaveBeenCalledOnce();
  });

  it("renders empty, loading, deleted, conflict and read-only states with synthetic notes", async () => {
    await render({ notes: [], selectedId: undefined, emptyMessage: "No notes have been created yet." });
    expect(document.body.textContent).toContain("No notes have been created yet.");
    expect(document.body.textContent).toContain("Select a note");

    await act(async () => root!.render(<NotesWorkspace {...baseProps} loading />));
    expect(document.querySelector("[role='status']")?.textContent).toContain("Loading note");

    await act(async () => root!.render(<NotesWorkspace {...baseProps} notes={[note("gone", "Deleted note", { deleted_at: "2026-10-10T09:00:00Z" })]} tab="deleted" detailState="deleted" />));
    expect(document.body.textContent).toContain("Deleted note detail");

    await act(async () => root!.render(<NotesWorkspace {...baseProps} detailState="conflict" />));
    expect(document.body.textContent).toContain("Conflict detail");

    await act(async () => root!.render(<NotesWorkspace {...baseProps} readOnly />));
    expect(document.body.textContent).toContain("Read-only on this Mac");
    expect((document.querySelector("textarea[aria-label='Note body']") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("announces a workspace loading error without hiding the existing notes", async () => {
    await render({ error: "Notes could not be loaded. Try again." });
    expect(document.querySelector("[role='alert']")?.textContent).toBe("Notes could not be loaded. Try again.");
    expect(document.body.textContent).toContain("Project brief");
  });
});
