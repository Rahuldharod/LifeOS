// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject, PersonMergePreview } from "@lifeos/contracts";
import { PersonMergeDialog, type PersonMergeDialogProps } from "./PersonMerge.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const person = (id: string, title: string, extra: Record<string, unknown> = {}): LifeObject => ({
  relativePath: `people/${id}.md`, contentHash: `${id}-hash`, body: `# ${title}\n`,
  frontmatter: { id, type: "person", schema_version: 1, revision: 1, title, created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", updated_by_device: "test", ...extra }
});
const john = person("john", "John Doe", { family_name: "Doe" });
const jdoe = person("jdoe", "Jdoe", { identifiers: [{ kind: "email", value: "jdoe@example.com" }], aliases: ["JD"] });
const other = person("other", "Someone Else");
const preview = (overrides: Partial<PersonMergePreview> = {}): PersonMergePreview => ({ keepPersonId: "john", nameFromPersonId: "john", keepLocked: false, keep: { id: "john", title: "John Doe" }, merge: { id: "jdoe", title: "Jdoe" }, keptName: "John Doe", aliases: ["Jdoe"], emails: ["jdoe@example.com"], referenceCount: 3, ...overrides });

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; });

async function render(overrides: Partial<PersonMergeDialogProps> = {}) {
  const props: PersonMergeDialogProps = { person: john, people: [john, jdoe, other], personLabels: new Map(), onPreview: vi.fn(async () => preview()), onMerge: vi.fn(async () => john), onClose: vi.fn(), onMerged: vi.fn(), ...overrides };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<PersonMergeDialog {...props} />));
  return props;
}
const button = (name: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLElement | undefined;
async function type(label: string, value: string) {
  const input = document.querySelector(`[aria-label='${label}']`) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("PersonMergeDialog (#213)", () => {
  it("finds the other person by email or alias, never lists the open person, then previews and merges", async () => {
    const props = await render();
    expect(button("Merge with Someone Else")).toBeTruthy();
    expect(button("Merge with John Doe")).toBeUndefined();
    await type("Search people to merge with", "jdoe@example");
    expect(button("Merge with Someone Else")).toBeUndefined();
    await type("Search people to merge with", "jd");
    await act(async () => button("Merge with Jdoe")!.click());
    expect(props.onPreview).toHaveBeenCalledWith({ otherPersonId: "jdoe" });
    expect(document.querySelector("[aria-label='Result of the merge']")!.textContent).toContain("John Doe");
    await act(async () => button("Merge")!.click());
    expect(props.onMerge).toHaveBeenCalledWith({ otherPersonId: "jdoe", keepPersonId: "john", nameFromPersonId: "john" });
    expect(props.onMerged).toHaveBeenCalledWith(john);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("swapping the kept name asks the server for a new preview with both choices", async () => {
    const onPreview = vi.fn(async (choice) => choice.nameFromPersonId === "jdoe" ? preview({ nameFromPersonId: "jdoe", keptName: "Jdoe", aliases: ["John Doe"] }) : preview());
    await render({ onPreview, initialOtherPersonId: "jdoe" });
    expect(onPreview).toHaveBeenCalledWith({ otherPersonId: "jdoe" });
    await act(async () => (document.querySelectorAll("input[name='merge-name']")[1] as HTMLElement).click());
    expect(onPreview).toHaveBeenLastCalledWith({ otherPersonId: "jdoe", keepPersonId: "john", nameFromPersonId: "jdoe" });
    expect(document.querySelector("[aria-label='Result of the merge']")!.textContent).toContain("John Doe");
  });

  it("locks who is kept when the Self person is involved", async () => {
    await render({ onPreview: vi.fn(async () => preview({ keepLocked: true })), initialOtherPersonId: "jdoe" });
    expect((document.querySelectorAll("input[name='merge-keep']")[0] as HTMLInputElement).closest("fieldset")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("always stay");
  });

  it("keeps the dialog open and says so when the merge fails", async () => {
    const props = await render({ onMerge: vi.fn(async () => undefined), initialOtherPersonId: "jdoe" });
    await act(async () => button("Merge")!.click());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[role='alert']")!.textContent).toContain("did not finish");
  });
});
