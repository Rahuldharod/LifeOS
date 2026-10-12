// #173: every Series view editor is a leave-page guard (PB-027), like the opened Note. The editors mount and
// unmount with the Series view, so they register here and the app hands the router one guard for all of them.
import { useRef } from "react";
import type { GuardedEditor } from "./navigationGuard.js";

export type SeriesEditorGuard = {
  /** One guard standing for every registered editor. */
  guard: GuardedEditor;
  /** `read` returns the editor's current state each time; the result unregisters it. */
  register: (id: string, read: () => GuardedEditor) => () => void;
};

export function createSeriesEditorGuard(): SeriesEditorGuard {
  const editors = new Map<string, () => GuardedEditor>();
  const current = () => [...editors.values()].map((read) => read());
  const guard: GuardedEditor = {
    // A conflicted editor cannot save and keeps its draft in the browser, so it never traps the user on the page.
    get dirty() { return current().some((editor) => editor.dirty && !editor.conflict); },
    get conflict() { return false; },
    async saveNow() {
      for (const editor of current()) if (editor.dirty && !editor.conflict && !(await editor.saveNow())) return false;
      return true;
    }
  };
  return { guard, register: (id, read) => { editors.set(id, read); return () => { if (editors.get(id) === read) editors.delete(id); }; } };
}

export function useSeriesEditorGuard(): SeriesEditorGuard {
  const ref = useRef<SeriesEditorGuard | undefined>(undefined);
  ref.current ??= createSeriesEditorGuard();
  return ref.current;
}
