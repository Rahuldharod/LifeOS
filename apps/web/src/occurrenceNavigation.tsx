import type { ReactNode } from "react";

const marker = /<a id="([^"]+)"><\/a>/g;

export function occurrenceHeading(markdown: string, sectionId: string) {
  const offset = markdown.indexOf(`<a id="${sectionId}"></a>`);
  if (offset < 0) return undefined;
  return markdown.slice(0, offset).split("\n").reverse().find((line) => /^##\s+/.test(line))?.replace(/^##\s+/, "");
}

/** Milkdown omits raw HTML anchors. Bind the stored occurrence ID to its rendered heading instead. */
export function scrollVisualOccurrence(root: HTMLElement, markdown: string, sectionId?: string) {
  if (!sectionId) return false;
  const heading = occurrenceHeading(markdown, sectionId);
  const target = heading ? Array.from(root.querySelectorAll("h2")).find((node) => node.textContent === heading) : undefined;
  if (!target) return false;
  target.id = sectionId;
  target.scrollIntoView({ block: "center" });
  return true;
}

/** ReactMarkdown deliberately ignores raw HTML. Split only the generated empty anchors out so Preview
 * retains its safe renderer while exposing a real browser target for legacy links. */
export function OccurrenceAnchoredMarkdown({ markdown, render }: { markdown: string; render: (chunk: string, key: number) => ReactNode }) {
  const nodes: ReactNode[] = [];
  let start = 0;
  let match: RegExpExecArray | null;
  marker.lastIndex = 0;
  while ((match = marker.exec(markdown))) {
    if (match.index > start) nodes.push(render(markdown.slice(start, match.index), nodes.length));
    nodes.push(<span id={match[1]} key={`anchor:${match[1]}`} aria-label="Linked occurrence" />);
    start = marker.lastIndex;
  }
  if (start < markdown.length) nodes.push(render(markdown.slice(start), nodes.length));
  return <>{nodes}</>;
}
