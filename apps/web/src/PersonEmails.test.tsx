// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { PersonEmails, type PersonEmailsProps } from "./PersonEmails.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ada: LifeObject = {
  relativePath: "people/ada.md", contentHash: "h", body: "# Ada\n",
  frontmatter: { id: "ada", type: "person", schema_version: 1, revision: 1, title: "Ada Example", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", updated_by_device: "test", identifiers: [{ kind: "email", value: "ada@example.com" }] }
};

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = undefined; });

async function render(overrides: Partial<PersonEmailsProps> = {}) {
  const props: PersonEmailsProps = { person: ada, disabled: false, onAdd: vi.fn(async () => ({ kind: "saved" as const })), onRemove: vi.fn(async () => true), onMergeInstead: vi.fn(), ...overrides };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<PersonEmails {...props} />));
  return props;
}
const button = (name: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name) as HTMLElement | undefined;
async function type(value: string) {
  const input = document.querySelector("[aria-label='Add email address']") as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("PersonEmails (#214)", () => {
  it("lists the emails and adds a typed one", async () => {
    const props = await render();
    expect(document.body.textContent).toContain("ada@example.com");
    await type("new@example.com");
    await act(async () => button("Add email")!.click());
    expect(props.onAdd).toHaveBeenCalledWith("new@example.com");
  });

  it("offers the merge when the address belongs to someone else", async () => {
    const props = await render({ onAdd: vi.fn(async () => ({ kind: "taken" as const, person: { id: "grace", name: "Grace Example" } })) });
    await type("grace@example.com");
    await act(async () => button("Add email")!.click());
    expect(document.querySelector("[role='alert']")?.textContent).toContain("This belongs to Grace Example — merge instead?");
    await act(async () => button("Merge with Grace Example")!.click());
    expect(props.onMergeInstead).toHaveBeenCalledWith("grace");
  });

  it("warns before removing and only removes on confirmation", async () => {
    const props = await render();
    await act(async () => button("Remove ada@example.com")!.click());
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("a future invite from this address will create a new unreviewed person");
    await act(async () => button("Keep it")!.click());
    expect(props.onRemove).not.toHaveBeenCalled();
    await act(async () => button("Remove ada@example.com")!.click());
    await act(async () => button("Yes, remove it")!.click());
    expect(props.onRemove).toHaveBeenCalledWith("ada@example.com");
  });
});
