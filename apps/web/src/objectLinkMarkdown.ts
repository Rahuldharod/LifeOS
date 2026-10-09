// Writing `[Title](lifeos://object/<id>)` links (PB-029): the copy button, the "Link object…" pickers
// and the paste rule all build them here, so a title with `\`, `[`, `]` or `|` stays a valid link.
import { lifeosLinkId } from "./lifeosLinks.js";

export type TitledObject = { frontmatter: { id: string; title: string } };

/** Backslash-escapes the characters that would end or break a Markdown link label. */
export function escapeLinkTitle(title: string): string {
  return title.replace(/[\\[\]|]/g, "\\$&");
}

/** The Markdown link to an object; the title is a snapshot, so a later rename does not change it. */
export function objectLinkMarkdown(object: TitledObject): string {
  return `[${escapeLinkTitle(object.frontmatter.title)}](lifeos://object/${object.frontmatter.id})`;
}

// Exactly an address and nothing after it: no path, query or fragment.
const BARE = /^lifeos:\/\/object\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The object a paste should become a link to, or undefined to paste the text untouched.
 * Only a clipboard that is exactly one address (whitespace around it ignored) for a loaded object
 * converts; deleted and archived objects count as known.
 */
export function pastedLinkTarget<T extends TitledObject>(clipboardText: string, objects: T[]): T | undefined {
  const text = clipboardText.trim();
  if (!BARE.test(text)) return undefined;
  const id = lifeosLinkId(text);
  return id ? objects.find((candidate) => candidate.frontmatter.id.toLowerCase() === id) : undefined;
}

/** The titled link Markdown to paste instead of the clipboard text, or undefined to paste the text untouched. */
export function pastedLinkMarkdown(clipboardText: string, objects: TitledObject[]): string | undefined {
  const object = pastedLinkTarget(clipboardText, objects);
  return object ? objectLinkMarkdown(object) : undefined;
}
