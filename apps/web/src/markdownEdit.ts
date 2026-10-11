// The Markdown-mode text edits as pure functions: the draft and the textarea selection go in, the new
// draft and the selection to restore come out. The textarea wiring lives in MarkdownEditor.tsx.
export type Selection = { start: number; end: number };
export type Edit = { draft: string; select: Selection };

/** Wraps the selection (or `placeholder`) in `before`/`after`, keeping the wrapped text selected. */
export function wrapSelection(draft: string, { start, end }: Selection, before: string, after: string, placeholder: string): Edit {
  const selected = draft.slice(start, end) || placeholder;
  return { draft: `${draft.slice(0, start)}${before}${selected}${after}${draft.slice(end)}`, select: { start: start + before.length, end: start + before.length + selected.length } };
}

/** Replaces the selection with `content`; the caret lands `selectFrom` characters in, selecting `selectLength`. */
export function insertAtSelection(draft: string, { start, end }: Selection, content: string, selectFrom = 0, selectLength = 0): Edit {
  return { draft: `${draft.slice(0, start)}${content}${draft.slice(end)}`, select: { start: start + selectFrom, end: start + selectFrom + selectLength } };
}

/** Applies `transform` to every whole line the selection touches (or to `placeholder` on an empty line). */
export function transformLines(draft: string, selection: Selection, transform: (line: string, index: number) => string, placeholder: string): Edit {
  const start = draft.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const nextBreak = draft.indexOf("\n", selection.end);
  const end = nextBreak === -1 ? draft.length : nextBreak;
  const replacement = (draft.slice(start, end) || placeholder).split("\n").map(transform).join("\n");
  return { draft: `${draft.slice(0, start)}${replacement}${draft.slice(end)}`, select: { start, end: start + replacement.length } };
}
