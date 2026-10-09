import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_SIZE_KEY, EditorFrame } from "./EditorFrame.js";
import { readRememberedSize } from "./resizableBox.js";

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); }
  });
  return store;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("EditorFrame (PB-028)", () => {
  it("wraps the editor in the shared frame with a resize handle, at the CSS default size", () => {
    stubStorage();
    const html = renderToStaticMarkup(<EditorFrame><textarea defaultValue="Body" /></EditorFrame>);
    expect(html).toContain('<article class="editor-card editor-frame">');
    expect(html).toContain("<textarea>Body</textarea>");
    expect(html).toContain('class="resize-handle" role="separator" aria-label="Resize editor (double-click to reset)"');
    expect(html).not.toContain("style=");
  });

  it("uses the one remembered size, whichever page renders it", () => {
    stubStorage({ [EDITOR_SIZE_KEY]: JSON.stringify({ width: 900, height: 640 }) });
    const notes = renderToStaticMarkup(<EditorFrame><p>Notes</p></EditorFrame>);
    const calendar = renderToStaticMarkup(<EditorFrame><p>Calendar</p></EditorFrame>);
    for (const html of [notes, calendar]) {
      expect(html).toContain('class="editor-card editor-frame resized" style="width:900px;height:640px"');
    }
  });

  it("moves the size remembered by the old Notes-only key across, once", () => {
    const store = stubStorage({ "lifeos.notesEditorSize": JSON.stringify({ width: 820, height: 500 }) });
    const html = renderToStaticMarkup(<EditorFrame><p>Notes</p></EditorFrame>);
    expect(html).toContain('style="width:820px;height:500px"');
    expect(store.get(EDITOR_SIZE_KEY)).toBe(JSON.stringify({ width: 820, height: 500 }));
    expect(store.has("lifeos.notesEditorSize")).toBe(false);
  });

  it("prefers the shared size over a leftover old key, and still renders without storage", () => {
    stubStorage({ [EDITOR_SIZE_KEY]: JSON.stringify({ width: 700, height: 400 }), "lifeos.notesEditorSize": JSON.stringify({ width: 1, height: 1 }) });
    expect(readRememberedSize(EDITOR_SIZE_KEY, ["lifeos.notesEditorSize"])).toEqual({ width: 700, height: 400 });
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(renderToStaticMarkup(<EditorFrame><p>Body</p></EditorFrame>)).toContain('<article class="editor-card editor-frame">');
  });
});
