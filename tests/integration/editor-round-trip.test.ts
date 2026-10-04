// @vitest-environment happy-dom
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as crepePackage from "@milkdown/crepe";
import { withSummarySection } from "../../packages/application/src/meeting-material.js";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { roundTripReport, storedMarkdown, unprovenConstructs, visualEditorFeatures, visualMarkdown } from "../../apps/web/src/editorMarkdown.js";

// Issue #89 (PB-003): opening a note in the visual editor and saving it must not change Markdown the
// user did not edit. Every fixture is loaded into the real Milkdown Crepe editor through the app's
// load/save path (visualMarkdown → Crepe → storedMarkdown) and serialised again without any edit —
// which is what any edit in visual mode would save for the rest of the note.
//
// KNOWN FAILURES are listed, not hidden: each must still fail (so a fixed one gets moved to LOSSLESS)
// and must be named by `unprovenConstructs`, which drives the 'Unproven formatting' label.

const fixtures = path.resolve(process.cwd(), "tests/fixtures/editor-round-trip"); // vitest runs from the repository root
const owner = "meetings/2026-10-01-weekly-sync.md";
// The same structural type the app gives Crepe (its published types do not resolve under this tsconfig).
type CrepeEditor = { create(): Promise<unknown>; destroy(): Promise<unknown>; getMarkdown(): string };
const { Crepe } = crepePackage as unknown as { Crepe: new (config: { root: Node; defaultValue: string; features?: Record<string, boolean> }) => CrepeEditor };

const LOSSLESS = [
  "headings.md",
  "emphasis.md",
  "bullets-star.md",
  "ordered-list.md",
  "task-list-star.md",
  "table-padded.md",
  "code-fenced.md",
  "links.md",
  "lifeos-links.md",
  "summary-section-spaced.md",
  "blockquote.md",
  "footnote.md",
  "html-inline-block.md",
  "front-matter.md"
];

/** Fixture → the construct `unprovenConstructs` must name for it. */
const KNOWN_FAILURES: Record<string, string> = {
  "bullets-dash.md": "bullets written with - or +",
  "bullets-plus.md": "bullets written with - or +",
  "task-list-dash.md": "bullets written with - or +",
  "summary-section.md": "blocks not separated by a blank line",
  "image-managed.md": "images",
  "image-inline.md": "images",
  "image-titled.md": "images",
  "heading-setext.md": "underlined (setext) headings",
  "heading-then-text.md": "blocks not separated by a blank line",
  "paragraph-then-list.md": "blocks not separated by a blank line",
  "horizontal-rule-dashes.md": "horizontal rules not written as ***",
  "code-tilde-fence.md": "code fenced with ~~~",
  "code-indented.md": "indented code blocks",
  "reference-links.md": "reference-style links",
  "bare-url.md": "bare web addresses",
  "hard-break-spaces.md": "trailing spaces (including two-space line breaks)",
  "html-entities.md": "HTML entities such as &amp;amp;",
  "backslash-escapes.md": "backslash escapes",
  "literal-asterisk.md": "a literal * or _ on its own",
  "table-unpadded.md": "tables not padded the way the editor writes them",
  "table-aligned.md": "tables not padded the way the editor writes them",
  "ordered-paren.md": "numbered lists written as 1)",
  "ordered-all-ones.md": "numbered lists not numbered 1, 2, 3",
  "nested-four-spaces.md": "nested lists indented differently from the editor",
  "html-block-multiline.md": "blocks not separated by a blank line",
  "blank-lines-extra.md": "several blank lines in a row",
  "front-matter-blank-line.md": "blank lines at the start or end of the note"
};

/** Byte-level cases a file fixture cannot hold reliably (line endings, final newline). */
const INLINE_FAILURES: Array<{ name: string; body: string; construct: string }> = [
  { name: "Windows line endings", body: "First line\r\nSecond line\r\n", construct: "Windows line endings" },
  { name: "no final newline", body: "No final newline", construct: "blank lines at the start or end of the note" },
  { name: "extra final newlines", body: "Text\n\n", construct: "blank lines at the start or end of the note" }
];

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

/** The note body as the app loads it: through the object store, so front matter is split off as in production. */
async function loadBody(name: string) {
  const content = await readFile(path.join(fixtures, name), "utf8");
  if (!content.startsWith("---\n")) return { content, body: content, prefix: "" };
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-editor-"));
  roots.push(root);
  await mkdir(path.join(root, "meetings"), { recursive: true });
  await writeFile(path.join(root, owner), content);
  const { body } = await new MarkdownObjectStore(root).read(owner);
  return { content, body, prefix: content.slice(0, content.length - body.length) };
}

/** Loads `body` into Crepe exactly as the visual editor does and returns what it would save. */
async function throughVisualEditor(body: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = new Crepe({ root, defaultValue: visualMarkdown(body), features: visualEditorFeatures });
  try {
    await editor.create();
    return storedMarkdown(editor.getMarkdown(), owner);
  } finally {
    await editor.destroy();
    root.remove();
  }
}

describe("visual editor round trip (#89, PB-003)", () => {
  it("lists every fixture as lossless or as a known failure", async () => {
    const files = (await readdir(fixtures)).filter((file) => file.endsWith(".md")).sort();
    expect(files).toEqual([...LOSSLESS, ...Object.keys(KNOWN_FAILURES)].sort());
  });

  describe("lossless: byte-for-byte when unedited", () => {
    it.each(LOSSLESS)("%s", async (name) => {
      const { content, body, prefix } = await loadBody(name);
      const saved = await throughVisualEditor(body);
      expect(prefix + saved).toBe(content);
      expect(roundTripReport(body, saved)).toEqual({ lossless: true, constructs: [] });
      // No false alarm: a note with only proven constructs is not labelled.
      expect(unprovenConstructs(body)).toEqual([]);
    });

    it("leaves front matter out of the editor entirely", async () => {
      const { body } = await loadBody("front-matter.md");
      expect(body.startsWith("# Weekly sync")).toBe(true);
      expect(body).not.toContain("custom_field");
    });

    it("an empty note", async () => {
      expect(await throughVisualEditor("")).toBe("");
    });
  });

  describe("known failures: rewritten, and labelled 'Unproven formatting'", () => {
    it.each(Object.entries(KNOWN_FAILURES))("%s (%s)", async (name, construct) => {
      const { body } = await loadBody(name);
      const saved = await throughVisualEditor(body);
      expect(saved, `${name} now round-trips: move it to LOSSLESS`).not.toBe(body);
      const report = roundTripReport(body, saved);
      expect(report.lossless).toBe(false);
      expect(report.constructs).toContain(construct);
    });

    it.each(INLINE_FAILURES)("$name", async ({ body, construct }) => {
      const saved = await throughVisualEditor(body);
      expect(saved).not.toBe(body);
      expect(roundTripReport(body, saved).constructs).toContain(construct);
    });

    it("the Summary section LifeOS itself writes", async () => {
      const body = withSummarySection("# Weekly sync\n\n## Notes\n\nText.\n", "* Agreed the scope\n* Review on Friday");
      const saved = await throughVisualEditor(body);
      expect(saved).not.toBe(body);
      expect(roundTripReport(body, saved).constructs).toContain("blocks not separated by a blank line");
    });
  });
});
