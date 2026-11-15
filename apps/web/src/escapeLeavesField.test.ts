// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { isEditingField, leaveEditorOnEscape, leaveFieldOnEscape } from "./escapeLeavesField.js";

const press = (init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
const mount = <T extends HTMLElement>(element: T) => { document.body.appendChild(element); element.focus(); return element; };
afterEach(() => { document.body.innerHTML = ""; });

describe("Esc leaves the field being edited", () => {
  it("blurs text inputs, textareas, selects and editable content", () => {
    const editable = document.createElement("div"); editable.contentEditable = "true"; editable.tabIndex = 0;
    for (const field of [document.createElement("input"), document.createElement("textarea"), document.createElement("select"), editable]) {
      mount(field);
      const event = press();
      expect(leaveFieldOnEscape(event)).toBe(true);
      expect(event.defaultPrevented).toBe(true); // keeps a search box's text
      expect(document.activeElement).not.toBe(field);
    }
  });

  it("leaves an Esc another handler already used, IME composition and modified keys alone", () => {
    const input = mount(document.createElement("input"));
    const used = press(); used.preventDefault();
    for (const event of [used, press({ isComposing: true }), press({ shiftKey: true }), press({ key: "a" })]) expect(leaveFieldOnEscape(event)).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("does not treat checkboxes, radios or buttons as editing", () => {
    const box = document.createElement("input"); box.type = "checkbox";
    const radio = document.createElement("input"); radio.type = "radio";
    expect([box, radio, document.createElement("button"), null].map(isEditingField)).toEqual([false, false, false, false]);
  });

  it("leaves the Visual editor before its own Esc binding runs, unless a menu already used the Esc", () => {
    const editor = document.createElement("div"); editor.className = "ProseMirror"; editor.contentEditable = "true"; editor.tabIndex = 0;
    const line = document.createElement("p"); editor.appendChild(line); mount(editor);
    const used = press(); used.preventDefault();
    line.dispatchEvent(used);
    expect(leaveEditorOnEscape(used)).toBe(false);
    expect(document.activeElement).toBe(editor);
    const fresh = press(); Object.defineProperty(fresh, "target", { value: line });
    expect(leaveEditorOnEscape(fresh)).toBe(true);
    expect(fresh.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(editor);
  });
});
