// PB-027: every navigation, including Back/Forward, saves the open note first. A failed save keeps
// the user on the page with the editor's own save-error status.

export type GuardedEditor = { dirty: boolean; conflict: boolean; saveNow: () => Promise<boolean> };

/**
 * An editor must be saved before leaving when it has unsaved edits that can be saved. A conflicted
 * draft or a read-only device cannot save at all; its draft is already kept in the browser, so it
 * never traps the user on the page.
 */
const blocking = (editor: GuardedEditor, readOnly: boolean) => editor.dirty && !editor.conflict && !readOnly;

export function needsSaveBeforeLeaving(editors: GuardedEditor[], readOnly: boolean) {
  return editors.some((editor) => blocking(editor, readOnly));
}

/** Saves each editor that needs it, in order; false as soon as one cannot be saved. */
export async function saveBeforeLeaving(editors: GuardedEditor[], readOnly: boolean) {
  for (const editor of editors) if (blocking(editor, readOnly) && !(await editor.saveNow())) return false;
  return true;
}

/** Finishes a navigation the router held back: lets it go after a successful save, cancels it otherwise. */
export async function settleBlockedNavigation(blocker: { proceed(): void; reset(): void }, save: () => Promise<boolean>, onFailed: () => void) {
  let saved = false;
  try { saved = await save(); } catch { saved = false; }
  if (saved) { blocker.proceed(); return; }
  blocker.reset();
  onFailed();
}
