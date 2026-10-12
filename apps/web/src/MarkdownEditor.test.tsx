// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor, ModeSwitch, type MarkdownEditorProps } from "./MarkdownEditor.js";

// The editor seam both Notes and the Calendar meeting workspace render, in Markdown and Preview modes.
// (Visual mode needs the real Crepe editor; the round-trip suite in tests/integration covers it.)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); });

const base: MarkdownEditorProps = { mode: "write", editorKey: "n1", draft: "say hello now", onChange: () => undefined, readOnly: false, busy: false, linkObjects: [], setBusy: () => undefined, notify: () => undefined, placeholder: "Write…", codeLanguagePrompt: "Language", caretAfterInsert: true, refocusAfterImage: false };

function render(props: Partial<MarkdownEditorProps>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<MarkdownEditor {...base} {...props} />));
  return host;
}

const click = (element: Element | null | undefined) => act(() => { element?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

describe("MarkdownEditor", () => {
  it("Markdown mode: the Bold button wraps the selected text and reports the new draft", () => {
    const drafts: string[] = [];
    const dom = render({ onChange: (draft) => drafts.push(draft) });
    const area = dom.querySelector("textarea")!;
    area.setSelectionRange(4, 9);
    click(dom.querySelector('button[title="Bold"]'));
    expect(drafts).toEqual(["say **hello** now"]);
  });

  it("Markdown mode: the list button turns the selected line into a bullet", () => {
    const drafts: string[] = [];
    const dom = render({ draft: "one\ntwo", onChange: (draft) => drafts.push(draft) });
    dom.querySelector("textarea")!.setSelectionRange(4, 4);
    click(dom.querySelector('button[title="Bulleted list"]'));
    expect(drafts).toEqual(["one\n- two"]);
  });

  it("Markdown mode: a read-only editor locks the textarea and toolbar", () => {
    const dom = render({ readOnly: true });
    expect(dom.querySelector("textarea")!.disabled).toBe(true);
    expect((dom.querySelector('button[title="Bold"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("is locked while not ready, and Visual falls back to the preview instead of an empty editor", () => {
    expect(render({ ready: false }).querySelector("textarea")!.disabled).toBe(true);
    act(() => root?.unmount());
    host?.remove();
    const dom = render({ mode: "visual", ready: false, draft: "Plan [here](lifeos://object/0a1b2c3d-0000-4000-8000-000000000001) ![b](../assets/b.png)" });
    expect(dom.querySelector(".visual-markdown-editor")).toBeNull();
    expect(dom.querySelector('a[href="lifeos://object/0a1b2c3d-0000-4000-8000-000000000001"]')).not.toBeNull();
    expect(dom.querySelector('img[src="/api/v1/assets/b.png"]')).not.toBeNull();
  });

  it("a body with section anchor lines is kept in Markdown even when Visual is asked for, with a plain-language note (#178)", () => {
    const draft = '## Weekly Prio — 2026-10-12T05:30:00.000Z\n<a id="occurrence-2026-10-12t05-30-00-000z"></a>\n\n- one\n';
    const dom = render({ mode: "visual", draft });
    expect(dom.querySelector(".visual-markdown-editor")).toBeNull();
    expect((dom.querySelector("textarea") as HTMLTextAreaElement).value).toBe(draft);
    expect(dom.textContent).toContain("This shared note opens in Markdown to keep its structure.");
    act(() => root?.unmount());
    host?.remove();
    expect(render({ mode: "write", draft }).textContent).not.toContain("opens in Markdown to keep");
    act(() => root?.unmount());
    host?.remove();
    expect(render({ mode: "preview", draft }).querySelector("textarea")).toBeNull();
  });

  it("Preview mode shows the empty text for a blank draft", () => {
    expect(render({ mode: "preview", draft: "" }).textContent).toContain("Nothing to preview yet.");
  });
});

describe("ModeSwitch", () => {
  it("disables Visual and marks Markdown as the active mode for a shared Note (#178)", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ModeSwitch mode="visual" onChange={() => undefined} visualDisabled />));
    const [visual, markdown] = Array.from(host.querySelectorAll("button"));
    expect(visual!.disabled).toBe(true);
    expect(visual!.title).toContain("opens in Markdown");
    expect(markdown!.className).toBe("selected");
  });

  it("marks the current mode and reports a change", () => {
    const modes: string[] = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ModeSwitch mode="write" onChange={(mode) => modes.push(mode)} />));
    expect(host.querySelector(".selected")?.textContent).toBe("Markdown");
    click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Preview"));
    expect(modes).toEqual(["preview"]);
  });
});
