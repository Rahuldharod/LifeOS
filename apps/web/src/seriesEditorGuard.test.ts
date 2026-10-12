import { describe, expect, it, vi } from "vitest";
import { needsSaveBeforeLeaving, saveBeforeLeaving } from "./navigationGuard.js";
import { createSeriesEditorGuard } from "./seriesEditorGuard.js";

// #173: the Series view's editors come and go without main re-rendering, so one guard stands for all of them.
const editor = (overrides: Partial<{ dirty: boolean; conflict: boolean; saveNow: () => Promise<boolean> }> = {}) => ({ dirty: false, conflict: false, saveNow: vi.fn(async () => true), ...overrides });

describe("series editor guard", () => {
  it("is clean with no editors or only clean ones", () => {
    const { guard, register } = createSeriesEditorGuard();
    expect(needsSaveBeforeLeaving([guard], false)).toBe(false);
    register("a", () => editor());
    expect(needsSaveBeforeLeaving([guard], false)).toBe(false);
  });

  it("blocks leaving while any editor has unsaved text, and saves only the dirty ones", async () => {
    const { guard, register } = createSeriesEditorGuard();
    const clean = editor(); const dirty = editor({ dirty: true });
    register("a", () => clean); register("b", () => dirty);
    expect(needsSaveBeforeLeaving([guard], false)).toBe(true);
    expect(await saveBeforeLeaving([guard], false)).toBe(true);
    expect(dirty.saveNow).toHaveBeenCalledTimes(1);
    expect(clean.saveNow).not.toHaveBeenCalled();
  });

  it("fails the leave when one editor cannot save, and does not let a conflicted one trap the user", async () => {
    const { guard, register } = createSeriesEditorGuard();
    register("a", () => editor({ dirty: true, conflict: true }));
    expect(needsSaveBeforeLeaving([guard], false)).toBe(false);
    register("b", () => editor({ dirty: true, saveNow: async () => false }));
    expect(await saveBeforeLeaving([guard], false)).toBe(false);
  });

  it("forgets an editor once it unmounts", () => {
    const { guard, register } = createSeriesEditorGuard();
    const unregister = register("a", () => editor({ dirty: true }));
    unregister();
    expect(needsSaveBeforeLeaving([guard], false)).toBe(false);
  });
});
