/**
 * Esc leaves the field being edited (search boxes, form fields, the note editors), so single-key shortcuts
 * such as the Inbox's work again. It runs after every component's own handler: an Esc already used to close
 * a dialog, a list or a menu (`preventDefault`) is left alone, so the next Esc leaves the field.
 * The browser's own Esc action is cancelled, so a search box keeps its text (Chrome would clear it).
 */
const notEditing = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color"]);

export function isEditingField(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLInputElement) return !notEditing.has(element.type);
  return element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.isContentEditable;
}

const plainEscape = (event: KeyboardEvent) => event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

export function leaveFieldOnEscape(event: KeyboardEvent) {
  if (!plainEscape(event)) return false;
  const active = document.activeElement;
  if (!isEditingField(active)) return false;
  event.preventDefault();
  active.blur();
  return true;
}

/**
 * The Visual editor (ProseMirror) binds Esc to "select the parent block" and marks it handled, which would swallow
 * every Esc. Called in the capture phase on the editor's wrapper, before ProseMirror: Crepe's open menus have
 * already closed on their own Esc (they listen on window, capture phase), so an Esc still unused leaves the editor.
 */
export function leaveEditorOnEscape(event: KeyboardEvent) {
  if (!plainEscape(event)) return false;
  const editor = event.target instanceof Element ? event.target.closest(".ProseMirror") : null;
  if (!(editor instanceof HTMLElement) || !editor.isContentEditable) return false;
  event.preventDefault(); event.stopPropagation();
  editor.blur();
  return true;
}
