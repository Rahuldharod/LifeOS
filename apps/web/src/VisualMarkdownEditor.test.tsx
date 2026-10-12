// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #183: the Visual editor reports changes after a delay, so closing it (the Visual / Markdown switch) flushes typing that
// has not been reported yet. The flush must never turn "focused but not edited" into a save. Crepe is replaced by a fake
// whose output the test controls; the real editor is covered in the browser tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fake = vi.hoisted(() => ({
  /** What getMarkdown() returns now; the load-time value is set before create(). */
  output: "",
  throwOnRead: false,
  listener: undefined as undefined | ((context: unknown, markdown: string, previous: string) => void)
}));

vi.mock("@milkdown/crepe", () => ({
  Crepe: class {
    editor = { config: () => undefined };
    async create() { return this; }
    getMarkdown() { if (fake.throwOnRead) throw new Error("editor is gone"); return fake.output; }
    async destroy() { return undefined; }
    setReadonly() { return undefined; }
    on(callback: (listener: { markdownUpdated(cb: (context: unknown, markdown: string, previous: string) => void): unknown }) => void) { callback({ markdownUpdated: (cb) => { fake.listener = cb; return undefined; } }); }
  }
}));
vi.mock("./visualEditorImages.js", () => ({ prepareVisualEditor: () => undefined }));

import { VisualMarkdownEditor } from "./VisualMarkdownEditor.js";

let root: Root | undefined;
let host: HTMLElement | undefined;
beforeEach(() => { fake.output = ""; fake.throwOnRead = false; fake.listener = undefined; });
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); });

type Props = Partial<React.ComponentProps<typeof VisualMarkdownEditor>>;
const props = (overrides: Props): React.ComponentProps<typeof VisualMarkdownEditor> => ({ editorKey: "a", owner: { id: "n1", relativePath: "meetings/n1.md" }, markdown: "* star bullet\n", readOnly: false, onChange: () => undefined, linkObjects: [], ...overrides });
const flushLoad = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
async function mount(overrides: Props) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<VisualMarkdownEditor {...props(overrides)} />); });
  await flushLoad();
  return host.querySelector(".visual-markdown-editor")!;
}
const focus = (area: Element) => act(() => { area.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
const close = () => act(() => { root!.unmount(); root = undefined; });

describe("VisualMarkdownEditor closing", () => {
  it("focusing a Note Crepe re-formats, then closing without typing reports nothing", async () => {
    fake.output = "- star bullet\n"; // Crepe's own rendering of "* star bullet\n"
    const changes: string[] = [];
    const area = await mount({ onChange: (markdown) => changes.push(markdown) });
    focus(area);
    close();
    expect(changes).toEqual([]);
  });

  it("typing that was not reported yet is reported when the editor closes", async () => {
    fake.output = "- star bullet\n";
    const changes: string[] = [];
    const area = await mount({ onChange: (markdown) => changes.push(markdown) });
    focus(area);
    fake.output = "- star bullet typed\n";
    close();
    expect(changes).toEqual(["- star bullet typed\n"]);
  });

  it("typing that was already reported is not reported twice", async () => {
    fake.output = "- star bullet\n";
    const changes: string[] = [];
    const area = await mount({ onChange: (markdown) => changes.push(markdown) });
    focus(area);
    fake.output = "- star bullet typed\n";
    fake.listener?.({}, "- star bullet typed\n", "- star bullet\n");
    close();
    expect(changes).toEqual(["- star bullet typed\n"]);
  });

  it("a read-only editor (another device holds the lease) never reports on close", async () => {
    fake.output = "- star bullet\n";
    const changes: string[] = [];
    const area = await mount({ readOnly: true, onChange: (markdown) => changes.push(markdown) });
    focus(area);
    fake.output = "- star bullet typed\n";
    close();
    expect(changes).toEqual([]);
  });

  it("an editor that cannot be read while closing does not break the teardown", async () => {
    fake.output = "- star bullet\n";
    const changes: string[] = [];
    const area = await mount({ onChange: (markdown) => changes.push(markdown) });
    focus(area);
    fake.throwOnRead = true;
    expect(() => close()).not.toThrow();
    expect(changes).toEqual([]);
  });

  it("switching to another note after typing never reports into the next note", async () => {
    fake.output = "- star bullet\n";
    const changes: string[] = [];
    const onChange = (markdown: string) => changes.push(markdown);
    const area = await mount({ onChange });
    focus(area);
    fake.output = "- star bullet typed\n";
    // The editor stays mounted and gets another note: its change handler now belongs to that note.
    const next: string[] = [];
    await act(async () => { root!.render(<VisualMarkdownEditor {...props({ editorKey: "b", markdown: "other\n", onChange: (markdown) => next.push(markdown) })} />); });
    await flushLoad();
    expect(next).toEqual([]);
    expect(changes).toEqual([]);
  });
});
