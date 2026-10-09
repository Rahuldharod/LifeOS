// The visual editor's load/save path (PB-003, #89). A note body goes in through `visualMarkdown`, the
// Milkdown Crepe editor parses it, and what the editor serialises comes back out through
// `storedMarkdown`. The round-trip suite in tests/integration/editor-round-trip.test.ts drives Crepe
// through exactly these functions; constructs it shows are rewritten are listed in
// `unprovenConstructs`, and the visual editor labels a note whose own round trip is not byte-for-byte.

/** The Crepe features the visual editor runs with. The round-trip suite uses the same set. */
export const visualEditorFeatures: Record<string, boolean> = { "top-bar": true, latex: false, ai: false };

const managedImage = /(!\[[^\]]*\]\()((?:\.\.\/)*assets\/([^\s()<>]+))(\))/g; // a name with brackets is left for the editor to show as written
const apiAsset = /\/api\/v1\/assets\/([^\s)>"]+)/g;

/** The address the visual editor shows a managed image at, or undefined if the file name is not valid percent-encoding. */
function apiAssetPath(fileName: string) {
  try { return `/api/v1/assets/${encodeURIComponent(decodeURIComponent(fileName))}`; } catch { return undefined; }
}

/** Note body → the Markdown the visual editor loads (managed images are shown through the API). */
export function visualMarkdown(markdown: string) {
  return markdown.replace(managedImage, (match, before: string, _path: string, fileName: string, after: string) => {
    const api = apiAssetPath(fileName);
    return api ? `${before}${api}${after}` : match;
  });
}

/**
 * What the visual editor emits → the note body that is saved (managed image links relative again).
 * Pass the body the editor was loaded with as `original`: an image it already had is written back with
 * exactly the path it was written with (#91), so `assets/x.png`, `../assets/x.png` and percent-encoded
 * names all survive. Only images added in the editor get a new path, relative to `ownerRelativePath`.
 */
export function storedMarkdown(markdown: string, ownerRelativePath: string, original = "") {
  const known = new Map<string, string>();
  for (const [, , path, fileName] of original.matchAll(managedImage)) {
    const api = apiAssetPath(fileName!);
    if (api && !known.has(api)) known.set(api, path!);
  }
  const depth = Math.max(0, ownerRelativePath.split("/").length - 1);
  const prefix = depth ? "../".repeat(depth) : "";
  return markdown.replace(apiAsset, (match, encoded: string) => known.get(match) ?? `${prefix}assets/${encoded}`);
}

/** An image in a note, as `alt → target`, for checking that saving did not lose any. */
const imageReference = /!\[((?:\\.|[^\]\\])*)\](?:\(\s*(<[^>]*>|(?:\\.|\([^\s()]*\)|[^\s()\\])*)|\[([^\]]*)\])?/g;

/** An HTML `<img>` tag (#96) and one attribute of it (quoted either way, or bare). */
const htmlImage = /<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const htmlAttribute = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Images in `markdown` (outside code), normalised so escaping, `<…>` wrapping, reference style and formatting inside the description do not matter. HTML `<img>` tags count too (#96). */
export function imagesIn(markdown: string): string[] {
  const prose = markdown
    .replace(/\r/g, "")
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/(`+)[^`]*?\1/g, "");
  const definitions = new Map<string, string>();
  for (const [, label, target] of prose.matchAll(/^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/gm)) {
    const key = label!.trim().toLowerCase();
    if (!definitions.has(key)) definitions.set(key, target!);
  }
  const plain = (value: string) => value.replace(/\\(.)/g, "$1").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
  const images: string[] = [];
  for (const match of prose.matchAll(imageReference)) {
    if (match.index > 0 && prose[match.index - 1] === "\\") continue;
    const alt = match[1]!;
    const label = match[3] || alt;
    const written = match[2] ?? definitions.get(label.trim().toLowerCase()) ?? `[${label}]`;
    const target = written.replace(/^<|>$/g, "").replace(/\\(.)/g, "$1");
    let decoded = target;
    try { decoded = decodeURI(target); } catch { /* keep as written */ }
    images.push(`${plain(alt)} → ${decoded}`);
  }
  for (const [, attributes] of prose.matchAll(htmlImage)) {
    const values = new Map<string, string>();
    for (const [, name, double, single, bare] of attributes!.matchAll(htmlAttribute)) {
      const key = name!.toLowerCase();
      if (!values.has(key)) values.set(key, double ?? single ?? bare ?? "");
    }
    images.push(`${plain(values.get("alt") ?? "")} → ${values.get("src") ?? ""}`);
  }
  return images;
}

/**
 * Images in `original` that are missing from `saved` (#91). Visual mode refuses to save a note when this
 * is not empty: losing an image silently is never acceptable, so a false alarm here is the safe failure.
 */
export function lostImages(original: string, saved: string): string[] {
  const remaining = imagesIn(saved);
  const lost: string[] = [];
  for (const image of imagesIn(original)) {
    const index = remaining.indexOf(image);
    if (index === -1) lost.push(image);
    else remaining.splice(index, 1);
  }
  return lost;
}

/** Named when a note does not round-trip but none of the known constructs below explain why. */
export const uncoveredFormatting = "formatting the round-trip suite does not cover";

const fence = /^ {0,3}(`{3,}|~{3,})/;
const listItem = /^( *)([-*+]|\d+[.)])( +|$)/;
const heading = /^ {0,3}#{1,6}(\s|$)/;
const htmlLine = /^ {0,3}(<!--.*-->|<\/?[a-zA-Z][^>]*>)\s*$/;
const thematic = /^ {0,3}([-*_])( *\1){2,} *$/;

/**
 * Constructs in `markdown` that the round-trip suite has shown the visual editor rewrites when it
 * saves. Each name matches a known-failure fixture in tests/fixtures/editor-round-trip. Deliberately
 * conservative: a false alarm costs a label, a miss costs the user's formatting.
 */
export function unprovenConstructs(markdown: string): string[] {
  const found = new Set<string>();
  const add = (name: string) => found.add(name);
  if (markdown.includes("\r")) add("Windows line endings");
  if (markdown && (/^\s*\n/.test(markdown) || !markdown.endsWith("\n") || /\n\s*\n$/.test(markdown))) add("blank lines at the start or end of the note");
  if (/\n[ \t]*\n[ \t]*\n/.test(markdown)) add("several blank lines in a row");

  const lines = markdown.replace(/\r/g, "").split("\n");
  let inFence: string | undefined;
  const prose: Array<{ text: string; index: number }> = [];
  lines.forEach((line, index) => {
    const opener = fence.exec(line)?.[1];
    if (inFence) {
      if (opener && opener[0] === inFence[0] && opener.length >= inFence.length && !line.trim().slice(opener.length).trim()) inFence = undefined;
      return;
    }
    if (opener) {
      inFence = opener;
      if (opener.startsWith("~")) add("code fenced with ~~~");
      const previous = lines[index - 1];
      if (previous !== undefined && previous.trim()) add("blocks not separated by a blank line");
      return;
    }
    prose.push({ text: line, index });
  });

  let previousListItems: Array<{ indent: number; width: number; ordered: boolean; number: number }> = [];
  for (const { text, index } of prose) {
    const previous = index > 0 ? lines[index - 1] ?? "" : "";
    const next = lines[index + 1] ?? "";
    if (!text.trim()) { continue; }
    if (/[ \t]+$/.test(text)) add("trailing spaces (including two-space line breaks)");
    // #91: images themselves survive; only these ways of writing them are rewritten.
    if (/!\[[^\]]*\]\((?:<[^>]*>|[^<)\s][^)\s]*)\s+(?:'|\(|""\s*\))/.test(text)) add("image titles not in double quotes");
    if (/!\[[^\]]*[*_`~][^\]]*\]/.test(text)) add("formatting inside image descriptions");
    if (/!\[[^\]]*\]\((?!<)[^\s)]*\(/.test(text)) add("brackets in image paths");
    if (/^ {0,3}\|/.test(text) && text.includes("![")) add("images inside tables");
    if (/^ {0,3}\[(?!\^)[^\]]+\]:/.test(text)) add("reference-style links");
    if (/(?<![<("'=])\bhttps?:\/\//.test(text)) add("bare web addresses"); // not an HTML attribute value
    if (/&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/.test(text)) add("HTML entities such as &amp;amp;");
    if (/\\[!-/:-@[-`{-~]/.test(text)) add("backslash escapes");
    if (/(^|\s)[*_](\s|$)/.test(text.replace(listItem, ""))) add("a literal * or _ on its own");
    if (thematic.test(text) && text.trim() !== "***") add("horizontal rules not written as ***");
    if (/^ {0,3}(=+|-+) *$/.test(text) && previous.trim() && !thematic.test(previous) && !listItem.test(previous)) add("underlined (setext) headings");
    if (/^( {4}|\t)/.test(text) && !previous.trim() && !listItem.test(text) && previousListItems.length === 0) add("indented code blocks");
    if (/^ {0,3}\|/.test(text) && /^ {0,3}\|?[ :|-]+\|?\s*$/.test(next) && next.includes("-")) {
      if (!canonicalTable(lines, index)) add("tables not padded the way the editor writes them");
    }

    const item = listItem.exec(text);
    if (item) {
      const indent = item[1]!.length;
      const marker = item[2]!;
      const ordered = /\d/.test(marker);
      if (marker === "-" || marker === "+") add("bullets written with - or +");
      if (marker.endsWith(")")) add("numbered lists written as 1)");
      const parentChain = previousListItems.filter((candidate) => candidate.indent < indent);
      const parent = parentChain[parentChain.length - 1];
      if (indent > 0 && (!parent || indent !== parent.indent + parent.width)) add("nested lists indented differently from the editor");
      const sibling = previousListItems.find((candidate) => candidate.indent === indent);
      if (ordered && sibling?.ordered && Number.parseInt(marker, 10) !== sibling.number + 1) add("numbered lists not numbered 1, 2, 3");
      previousListItems = [...parentChain, { indent, width: marker.length + 1, ordered, number: Number.parseInt(marker, 10) }];
    } else if (!/^\s/.test(text)) {
      previousListItems = [];
    }

    // Two blocks touching without a blank line between them: the editor always writes one.
    if (previous.trim() && !fence.test(previous)) {
      const startsBlock = heading.test(text) || htmlLine.test(text) || (item !== null && !listItem.test(previous) && !/^\s/.test(previous) && !/^ {0,3}>/.test(previous));
      const endsBlock = heading.test(previous) || htmlLine.test(previous);
      if (startsBlock || endsBlock) add("blocks not separated by a blank line");
    }
  }
  return [...found];
}

/** True when the table starting at `start` is already in the padded form the editor writes. */
function canonicalTable(lines: string[], start: number) {
  const rows: string[] = [];
  for (let index = start; index < lines.length && /^ {0,3}\|/.test(lines[index] ?? ""); index += 1) rows.push(lines[index]!);
  if (rows.some((row) => row.includes("\\|") || row.includes("`") || !row.trimEnd().endsWith("|") || row !== row.trim())) return false;
  const cells = rows.map((row) => row.slice(1, -1).split("|").map((cell) => cell.trim()));
  const columns = cells[0]!.length;
  if (cells.some((row) => row.length !== columns)) return false;
  const aligns = cells[1]!.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "none");
  const widths = aligns.map((align, column) => Math.max(align === "center" ? 3 : align === "none" ? 1 : 2, ...cells.filter((_row, index) => index !== 1).map((row) => row[column]!.length)));
  const render = (row: string[], index: number) => `| ${row.map((cell, column) => {
    const width = widths[column]!;
    const align = aligns[column]!;
    if (index === 1) return align === "center" ? `:${"-".repeat(width - 2)}:` : align === "left" ? `:${"-".repeat(width - 1)}` : align === "right" ? `${"-".repeat(width - 1)}:` : "-".repeat(width);
    const room = width - cell.length;
    if (align === "right") return cell.padStart(width);
    if (align === "center") return `${" ".repeat(Math.floor(room / 2))}${cell}${" ".repeat(Math.ceil(room / 2))}`;
    return cell.padEnd(width);
  }).join(" | ")} |`;
  return cells.every((row, index) => render(row, index) === rows[index]);
}

export type RoundTripReport = { lossless: boolean; constructs: string[] };

/** Compares a note body with what the visual editor would save for it without any edit. */
export function roundTripReport(original: string, saved: string): RoundTripReport {
  if (original === saved) return { lossless: true, constructs: [] };
  const constructs = unprovenConstructs(original);
  return { lossless: false, constructs: constructs.length ? constructs : [uncoveredFormatting] };
}
