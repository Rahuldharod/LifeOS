// @vitest-environment happy-dom
import React, { act, useLayoutEffect } from "react";
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
const leave = (area: Element) => act(() => { area.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
const close = () => act(() => { root!.unmount(); root = undefined; });
const TYPED = "- star bullet typed\n";

/** A Note Crepe loads as "- star bullet\n", focused by the user; `changes` collects what it reports. */
async function focusedNote(overrides: Props = {}) {
  fake.output = "- star bullet\n"; // Crepe's own rendering of "* star bullet\n"
  const changes: string[] = [];
  const area = await mount({ onChange: (markdown) => changes.push(markdown), ...overrides });
  focus(area);
  return { area, changes };
}

/** The editor stays mounted and gets the next note (a new editorKey), as the Notes tab and the meeting Note do. */
async function openNext(next: string[], overrides: Props = {}, extra?: React.ReactNode) {
  await act(async () => { root!.render(<><VisualMarkdownEditor {...props({ editorKey: "b", owner: { id: "n2", relativePath: "meetings/n2.md" }, markdown: "other\n", onChange: (markdown) => next.push(markdown), ...overrides })} />{extra}</>); });
  await flushLoad();
}

describe("VisualMarkdownEditor closing", () => {
  it("focusing a Note Crepe re-formats, then closing without typing reports nothing", async () => {
    const { changes } = await focusedNote();
    close();
    expect(changes).toEqual([]);
  });

  it("typing that was not reported yet is reported when the editor closes", async () => {
    const { changes } = await focusedNote();
    fake.output = TYPED;
    close();
    expect(changes).toEqual([TYPED]);
  });

  it("typing that was already reported is not reported twice", async () => {
    const { changes } = await focusedNote();
    fake.output = TYPED;
    fake.listener?.({}, TYPED, "- star bullet\n");
    close();
    expect(changes).toEqual([TYPED]);
  });

  it("a read-only editor (another device holds the lease) never reports on close", async () => {
    const { changes } = await focusedNote({ readOnly: true });
    fake.output = TYPED;
    close();
    expect(changes).toEqual([]);
  });

  it("an editor that cannot be read while closing does not break the teardown", async () => {
    const { changes } = await focusedNote();
    fake.throwOnRead = true;
    expect(() => close()).not.toThrow();
    expect(changes).toEqual([]);
  });
});

// #192: switching to another Note keeps this editor mounted; only its editorKey changes. Typing not reported yet must
// reach the original Note's own change handler, with or without a blur, and never the next Note's.
describe("VisualMarkdownEditor moving to another note", () => {
  it("typing not reported yet goes to the original note when the editor moves to the next note without a blur", async () => {
    const { changes } = await focusedNote();
    fake.output = TYPED;
    const next: string[] = [];
    await openNext(next);
    expect(changes).toEqual([TYPED]);
    expect(next).toEqual([]);
  });

  it("typing not reported yet goes to the original note when focus leaves the editor", async () => {
    const { area, changes } = await focusedNote();
    fake.output = TYPED;
    leave(area);
    expect(changes).toEqual([TYPED]);
  });

  it("a blur between the next note's render and the editor's own switch still reports to the original note", async () => {
    const { area, changes } = await focusedNote();
    fake.output = TYPED;
    const next: string[] = [];
    // A layout effect runs before the editor's own effects: like a list focusing its selected row after the switch.
    function BlurOnRender() { useLayoutEffect(() => { leave(area); }, []); return null; }
    await openNext(next, {}, <BlurOnRender />);
    expect(changes).toEqual([TYPED]);
    expect(next).toEqual([]);
  });

  it("a debounced report after a blur flush of the same text is not reported again", async () => {
    const { area, changes } = await focusedNote();
    fake.output = TYPED;
    leave(area);
    act(() => fake.listener?.({}, TYPED, "- star bullet\n"));
    expect(changes).toEqual([TYPED]);
  });

  it("the previous note's late change report never reaches the next note, even once the next note is focused", async () => {
    const { area, changes } = await focusedNote();
    const previousListener = fake.listener!;
    const next: string[] = [];
    await openNext(next);
    focus(area);
    // Crepe's debounce for the previous note fires only now, after the switch.
    act(() => previousListener({}, TYPED, "- star bullet\n"));
    expect(next).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("leaving the editor without typing reports nothing", async () => {
    const { area, changes } = await focusedNote();
    leave(area);
    expect(changes).toEqual([]);
  });

  it("a read-only editor (lease lost) never reports when focus leaves it or it moves to the next note", async () => {
    const { area, changes } = await focusedNote({ readOnly: true });
    fake.output = TYPED;
    leave(area);
    await openNext([], { readOnly: true });
    expect(changes).toEqual([]);
  });

  it("an editor that is only busy (the next meeting is opening) still reports earlier typing to the original note", async () => {
    const { changes } = await focusedNote();
    fake.output = TYPED;
    await act(async () => { root!.render(<VisualMarkdownEditor {...props({ busy: true, onChange: (markdown) => changes.push(markdown) })} />); });
    const next: string[] = [];
    await openNext(next, { busy: true });
    expect(changes).toEqual([TYPED]);
    expect(next).toEqual([]);
  });
});
