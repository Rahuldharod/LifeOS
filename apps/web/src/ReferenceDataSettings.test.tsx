// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject, PersonLabel } from "@lifeos/contracts";
import { ReferenceDataSettings, type ReferenceDataSettingsProps } from "./ReferenceDataSettings.js";
import type { ReferenceEntityType } from "./referenceSettingsRoutes.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const object = (id: string, type: ReferenceEntityType, title: string, extra: Record<string, unknown> = {}): LifeObject => ({
  relativePath: `${type}s/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}\n\nSynthetic body`,
  frontmatter: { id, type, schema_version: 1, revision: 2, title, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-10T08:00:00Z", updated_by_device: "test", status: "active", ...extra }
});
const projectA = object("project-a", "project", "Autumn launch", { objective: "Ship" });
const projectB = object("project-b", "project", "Winter launch");
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const defaults = (overrides: Partial<ReferenceDataSettingsProps> = {}): ReferenceDataSettingsProps => ({
  type: "project", objects: [projectA, projectB], linkables: [projectA, projectB], personLabels: new Map(), selectedId: "project-a", busy: false, readOnly: false,
  onOpen: vi.fn(), onCreate: vi.fn(async () => undefined), onSave: vi.fn(async () => true), onDelete: vi.fn(async () => true),
  run: async (action) => { await action(); return true; }, onRestored: async () => undefined, ...overrides
});

async function render(props: ReferenceDataSettingsProps) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<ReferenceDataSettings {...props} />));
}
async function click(name: string) {
  const control = [...document.querySelectorAll("button, summary")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLElement;
  expect(control, `control ${name}`).toBeTruthy(); await act(async () => control.click());
}
async function enterText(label: string, value: string) {
  const control = document.querySelector(`[aria-label='${label}']`) as HTMLInputElement;
  expect(control, `input ${label}`).toBeTruthy();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); });
}

function Harness({ initialId, ...props }: Omit<ReferenceDataSettingsProps, "selectedId" | "onOpen"> & { initialId?: string }) {
  const [selectedId, setSelectedId] = useState(initialId);
  return <ReferenceDataSettings {...props} selectedId={selectedId} onOpen={setSelectedId} />;
}

describe("ReferenceDataSettings (#140)", () => {
  it.each([
    ["project", "Projects"], ["client", "Clients"], ["product", "Products"], ["person", "People"]
  ] as Array<[ReferenceEntityType, string]>)("shows a searchable %s list and focused editor", async (type, title) => {
    const first = object(`${type}-one`, type, `First ${type}`); const second = object(`${type}-two`, type, `Second ${type}`);
    await render(defaults({ type, objects: [first, second], linkables: [first, second], selectedId: first.frontmatter.id }));
    expect(document.querySelector(`[aria-label='Search ${title}']`)).toBeTruthy();
    expect((document.querySelector(`[aria-label='${type} title']`) as HTMLInputElement).value).toBe(`First ${type}`);
    await enterText(`Search ${title}`, "Second");
    expect(document.querySelector(".reference-list")?.textContent).toContain(`Second ${type}`); expect(document.querySelector(".reference-list")?.textContent).not.toContain(`First ${type}`);
  });

  it("shows empty and blank-new states with sticky actions", async () => {
    const create = vi.fn(async (_type, fields) => object("created", "project", String(fields.title)));
    const props = defaults({ objects: [], linkables: [], onCreate: create });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Harness {...props} initialId={undefined} />));
    expect(document.body.textContent).toContain("No projects yet");
    await click("New project");
    expect((document.querySelector("[aria-label='project title']") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).toContain("Not saved yet");
    await enterText("project title", "Spring launch"); await click("Save");
    expect(create).toHaveBeenCalledWith("project", expect.objectContaining({ title: "Spring launch", sensitivity: "normal" }));
  });

  it("guards dirty list navigation with Save, Discard and Stay", async () => {
    const save = vi.fn(async () => true);
    const props = defaults({ onSave: save });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Harness {...props} initialId="project-a" />));
    await enterText("project title", "Changed title"); await click("Open project: Winter launch");
    expect(document.querySelector("[role='dialog']")?.textContent).toMatch(/Save.*Discard.*Stay/s);
    await click("Stay"); expect((document.querySelector("[aria-label='project title']") as HTMLInputElement).value).toBe("Changed title");
    await click("Open project: Winter launch"); await click("Discard");
    expect((document.querySelector("[aria-label='project title']") as HTMLInputElement).value).toBe("Winter launch");
    await enterText("project title", "Saved winter"); await click("Open project: Autumn launch");
    const dialogSave = document.querySelector("[role='dialog'] .primary") as HTMLButtonElement;
    await act(async () => { dialogSave.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(save).toHaveBeenCalledWith(projectB, expect.objectContaining({ title: "Saved winter" }));
    expect((document.querySelector("[aria-label='project title']") as HTMLInputElement).value).toBe("Autumn launch");
  });

  it("opens an archived record from a direct link without adding every archive to the list", async () => {
    const archived = object("archived-project", "project", "Archived launch", { archived_at: "2026-10-09T08:00:00Z" });
    await render(defaults({ objects: [], linkables: [archived], selectedId: archived.frontmatter.id }));
    expect((document.querySelector("[aria-label='project title']") as HTMLInputElement).value).toBe("Archived launch");
    expect(document.body.textContent).toContain("Archived record opened from a direct link");
  });

  it("preserves person review, External labels and relationship pickers", async () => {
    const person = object("person-a", "person", "Alex Example", { review_state: "unreviewed", origin: "calendar" });
    const personLabels = new Map<string, PersonLabel>([["person-a", { id: "person-a", name: "Alex", label: "Alex - ext", suffix: " - ext", isExternal: true, externalSource: "email", unreviewed: true }]]);
    const external = vi.fn(async () => true); const reviewed = vi.fn(async () => true);
    await render(defaults({ type: "person", objects: [person], linkables: [person], personLabels, selectedId: "person-a", onSetExternal: external, onConfirmReviewed: reviewed }));
    expect(document.body.textContent).toContain("Alex - ext"); expect(document.body.textContent).toContain("Unreviewed");
    expect(document.querySelector("[aria-label='External person label']")).toBeTruthy();
    await click("Confirm Alex Example as reviewed"); expect(reviewed).toHaveBeenCalledWith(person);

    await act(async () => root!.render(<ReferenceDataSettings {...defaults({ objects: [projectA], linkables: [projectA, person], personLabels, selectedId: "project-a" })} />));
    expect(document.querySelector("[aria-label='Owner']")).toBeTruthy();
  });

  it("keeps History, Copy link, Sensitivity and confirmed deletion in the record pattern", async () => {
    const remove = vi.fn(async () => true); const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render(defaults({ onDelete: remove }));
    expect(document.querySelector("[aria-label='Sensitivity']")).toBeTruthy();
    await click("More"); expect(document.body.textContent).toContain("History"); expect(document.body.textContent).toContain("Copy link");
    await click("Delete project"); expect(remove).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); await click("Delete project"); expect(remove).toHaveBeenCalledWith(projectA);
  });

  it("does not let dirty drafts be bypassed by History restore or deletion", async () => {
    const remove = vi.fn(async () => true); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await render(defaults({ onDelete: remove }));
    await enterText("project title", "Unsaved launch"); await click("More");
    const history = [...document.querySelectorAll("button")].find((button) => button.textContent === "History") as HTMLButtonElement;
    const deleteButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete project") as HTMLButtonElement;
    expect(history.disabled).toBe(true); expect(deleteButton.disabled).toBe(true);
    await act(async () => { history.click(); deleteButton.click(); });
    expect(document.querySelector("[aria-label^='History of']")).toBeNull(); expect(confirm).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect((document.querySelector("[aria-label='project title']") as HTMLInputElement).value).toBe("Unsaved launch");
    await click("Cancel");
    expect(([...document.querySelectorAll("button")].find((button) => button.textContent === "History") as HTMLButtonElement).disabled).toBe(false);
    expect(([...document.querySelectorAll("button")].find((button) => button.textContent === "Delete project") as HTMLButtonElement).disabled).toBe(false);
  });

  // #230: People filters, checkboxes and bulk actions.
  it("filters people with AND, selects them, and asks before a bulk archive", async () => {
    const ana = object("ana", "person", "Ana External", { review_state: "unreviewed", origin: "calendar" });
    const ben = object("ben", "person", "Ben Internal", { review_state: "reviewed" });
    const list = object("list", "person", "Team List", { not_a_person: true, archived_at: "2026-11-02T08:00:00Z" });
    const personLabels = new Map<string, PersonLabel>([
      ["ana", { id: "ana", name: "Ana External", label: "Ana External - ext", suffix: " - ext", isExternal: true, externalSource: "email", unreviewed: true } as PersonLabel],
      ["ben", { id: "ben", name: "Ben Internal", label: "Ben Internal", isExternal: false, externalSource: "email" } as PersonLabel]
    ]);
    const bulk = vi.fn(async (action: string, people: LifeObject[]) => ({ action: action as "archive", done: people.length, skipped: 0, failed: [] }));
    await render(defaults({ type: "person", objects: [ana, ben], linkables: [ana, ben], notAPersonPeople: [list], personLabels, selectedId: undefined, onBulkPeople: bulk }));
    const rows = () => [...document.querySelectorAll("[aria-label^='Open person:']")].map((row) => row.getAttribute("aria-label"));
    const choose = async (label: string, value: string) => {
      const select = document.querySelector(`[aria-label='${label}']`) as HTMLSelectElement;
      await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    expect(rows()).toEqual(["Open person: Ana External - ext", "Open person: Ben Internal"]);
    await choose("Type filter", "not-a-person");
    expect(rows()).toEqual(["Open person: Team List"]);
    await choose("Type filter", "all"); await choose("Review status filter", "reviewed");
    expect(rows()).toEqual(["Open person: Ben Internal", "Open person: Team List"]);
    await choose("Internal or external filter", "external");
    expect(rows()).toEqual([]);
    expect(document.body.textContent).toContain("No people match.");
    await choose("Review status filter", "unreviewed");
    expect(rows()).toEqual(["Open person: Ana External - ext"]);
    await choose("Review status filter", "all"); await choose("Internal or external filter", "all"); await choose("Type filter", "person");

    await click("Select all");
    expect(document.body.textContent).toContain("2 selected");
    await act(async () => (document.querySelector("[aria-label='Select Ben Internal']") as HTMLInputElement).click());
    expect(document.body.textContent).toContain("1 selected");
    await click("Select all"); await click("Actions…");
    expect(document.querySelector("[aria-label='Selected people actions']")).toBeTruthy();
    expect(([...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Confirm (1 of 2)") as HTMLButtonElement).disabled).toBe(false);
    expect(([...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Mark as a person (0 of 2)") as HTMLButtonElement).disabled).toBe(true);

    await click("Archive (2 of 2)");
    expect(bulk).not.toHaveBeenCalled();
    const dialog = document.querySelector("[role='dialog']")!;
    expect(dialog.textContent).toContain("Archive 2 people?");
    await click("Cancel");
    expect(document.querySelector("[role='dialog']")).toBeNull(); expect(bulk).not.toHaveBeenCalled();
    await click("Archive (2 of 2)"); await click("Archive");
    expect(bulk).toHaveBeenCalledWith("archive", [ana, ben], expect.any(Function));
    // Done: a toast says what happened, the selection clears and the panel closes.
    expect(document.querySelector(".people-bulk-toast[role='status']")?.textContent).toContain("2 people archived");
    expect(document.body.textContent).toContain("2 shown");
    expect(document.querySelector("[aria-label='Selected people actions']")).toBeNull();
    await click("Dismiss");
    expect(document.querySelector(".people-bulk-toast")).toBeNull();

    // A filter change starts a new selection.
    await click("Select all");
    expect(document.body.textContent).toContain("2 selected");
    await choose("Review status filter", "unreviewed");
    expect(document.body.textContent).toContain("1 shown");
  });

  it("keeps a failed bulk action on screen as an alert, naming who failed", async () => {
    const ana = object("ana", "person", "Ana External", { review_state: "unreviewed", origin: "calendar" });
    const bulk = vi.fn(async () => ({ action: "confirm" as const, done: 0, skipped: 0, failed: [{ title: "Ana External", error: "Changed on another device" }] }));
    await render(defaults({ type: "person", objects: [ana], linkables: [ana], personLabels: new Map(), selectedId: undefined, onBulkPeople: bulk }));
    await click("Select all"); await click("Actions…"); await click("Confirm (1 of 1)");
    const alert = document.querySelector(".people-bulk-toast[role='alert']");
    expect(alert?.textContent).toContain("Some changes failed");
    expect(alert?.textContent).toContain("Ana External: Changed on another device");
  });

  it("disables creation, editing, saving and deletion when read-only", async () => {
    await render(defaults({ readOnly: true }));
    expect((document.querySelector("[aria-label='project title']") as HTMLInputElement).disabled).toBe(true);
    expect(([...document.querySelectorAll("button")].find((button) => button.textContent === "New project") as HTMLButtonElement).disabled).toBe(true);
    await click("More");
    expect(([...document.querySelectorAll("button")].find((button) => button.textContent === "Delete project") as HTMLButtonElement).disabled).toBe(true);
  });
});
