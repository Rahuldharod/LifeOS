// Pasting a bare `lifeos://object/<id>` into the visual editor writes a titled link (PB-029).
// The decision is `pastedLinkMarkdown`; this only puts the result into the Milkdown document.
import { lifeosLinkId } from "./lifeosLinks.js";
import { pastedLinkMarkdown } from "./objectLinkMarkdown.js";

type Mark = { create(attrs: Record<string, unknown>): unknown };
type EditorView = {
  state: { schema: { marks: Record<string, Mark | undefined>; text(text: string, marks: unknown[]): unknown }; tr: { replaceSelectionWith(node: unknown, inheritMarks: boolean): unknown } };
  dispatch(transaction: unknown): void;
};
type PasteEditor = { editor: { action<T>(action: (ctx: { get(slice: "editorView"): EditorView }) => T): T } };
type PasteEvent = { clipboardData: { getData(type: string): string } | null; preventDefault(): void; stopPropagation(): void };

/** Replaces the selection with the titled link. The text is the plain title: the editor escapes it when it saves. */
export function insertLink(editor: PasteEditor, title: string, href: string): boolean {
  return editor.editor.action((ctx) => {
    const view = ctx.get("editorView");
    const link = view.state.schema.marks.link;
    if (!link) return false;
    view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text(title, [link.create({ href })]), false));
    return true;
  });
}

/** Handles a paste event; returns true when it was a bare known address and a titled link went in instead. */
export function pasteLifeosLink(event: PasteEvent, editor: PasteEditor | undefined, objects: Array<{ frontmatter: { id: string; title: string } }>): boolean {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!editor || !pastedLinkMarkdown(text, objects)) return false; // the same rule as Markdown mode
  const id = lifeosLinkId(text);
  const object = objects.find((candidate) => candidate.frontmatter.id.toLowerCase() === id);
  // Only swallow the paste once the link is in, so a failure still pastes the text.
  if (!object || !insertLink(editor, object.frontmatter.title, `lifeos://object/${object.frontmatter.id}`)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
