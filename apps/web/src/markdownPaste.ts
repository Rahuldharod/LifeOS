// What a paste into the Markdown textarea should do: an image is uploaded (as before), a bare known
// `lifeos://object/<id>` becomes a titled link (PB-029), anything else pastes untouched.
import { pastedLinkMarkdown, type TitledObject } from "./objectLinkMarkdown.js";

type Clipboard = { files: ArrayLike<File>; getData(type: string): string };
export type MarkdownPaste = { kind: "image"; file: File } | { kind: "link"; markdown: string };

export function markdownPasteAction(clipboard: Clipboard, objects: TitledObject[]): MarkdownPaste | undefined {
  const file = Array.from(clipboard.files).find((candidate) => candidate.type.startsWith("image/"));
  if (file) return { kind: "image", file };
  const markdown = pastedLinkMarkdown(clipboard.getData("text/plain"), objects);
  return markdown ? { kind: "link", markdown } : undefined;
}
