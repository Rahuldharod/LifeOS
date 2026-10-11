// @vitest-environment happy-dom
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as crepePackage from "@milkdown/crepe";
import { withSummarySection } from "../../packages/application/src/meeting-material.js";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { lostImages, roundTripReport, storedMarkdown, unprovenConstructs, visualEditorFeatures, visualMarkdown } from "../../apps/web/src/editorMarkdown.js";
import { escapeLinkTitle } from "../../apps/web/src/objectLinkMarkdown.js";
import { insertLink } from "../../apps/web/src/visualLinkPaste.js";
import { prepareVisualEditor, type ImageAwareEditor } from "../../apps/web/src/visualEditorImages.js";

// #115: this takes about 4 s even on an idle machine, so a busy full-suite run can push it past Vitest's 5 s
// default. A per-test limit keeps the assertions strict; only the wall-clock allowance grows.
const SLOW_UNDER_LOAD_MS = 30_000;

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
type CrepeEditor = ImageAwareEditor & {
  create(): Promise<unknown>;
  destroy(): Promise<unknown>;
  getMarkdown(): string;
  editor: { action<T>(action: (ctx: { get(slice: "editorView"): EditorView }) => T): T };
};
/** The bits of ProseMirror's EditorView these tests use (reached by Milkdown slice name, as the app does). */
type EditorView = {
  state: { doc: { content: { size: number } }; schema: { nodes: Record<string, { create(attrs: Record<string, unknown>): unknown }> }; tr: { insert(at: number, node: unknown): unknown; insertText(text: string, at: number): unknown } };
  dispatch(transaction: unknown): void;
};
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
  // #96: the Summary section exactly as withSummarySection writes it (checked against it below).
  "summary-section-written.md",
  // #96: an empty line saved by an older version as <br /> is kept as written.
  "empty-line-br.md",
  // #96: an empty bullet stays an empty bullet, not `* <br />`.
  "bullets-empty-item.md",
  // #96: HTML <img> tags are kept as written (and covered by the image-loss guard).
  "image-html.md",
  "blockquote.md",
  "footnote.md",
  "html-inline-block.md",
  "front-matter.md",
  // #91: every image form survives a Visual round trip byte-for-byte.
  "image-managed.md",
  "image-inline.md",
  "image-titled.md",
  "image-untitled-same-folder.md",
  "image-special-path.md",
  "image-empty-alt.md",
  "image-in-list-and-link.md"
];

/** Fixture → the construct `unprovenConstructs` must name for it. */
const KNOWN_FAILURES: Record<string, string> = {
  "bullets-dash.md": "bullets written with - or +",
  "bullets-plus.md": "bullets written with - or +",
  "task-list-dash.md": "bullets written with - or +",
  "summary-section.md": "blocks not separated by a blank line", // the form written before #96; still read, rewritten on the next summary
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
  // PB-029: a link whose title needed escaping (as the copy button and pickers write it).
  "lifeos-link-escaped-title.md": "backslash escapes",
  "literal-asterisk.md": "a literal * or _ on its own",
  "table-unpadded.md": "tables not padded the way the editor writes them",
  "table-aligned.md": "tables not padded the way the editor writes them",
  "ordered-paren.md": "numbered lists written as 1)",
  "ordered-all-ones.md": "numbered lists not numbered 1, 2, 3",
  "nested-four-spaces.md": "nested lists indented differently from the editor",
  "html-block-multiline.md": "blocks not separated by a blank line",
  "blank-lines-extra.md": "several blank lines in a row",
  "front-matter-blank-line.md": "blank lines at the start or end of the note",
  // #91: the image is kept; only the way it is written changes.
  "image-title-single-quotes.md": "image titles not in double quotes",
  "image-alt-formatting.md": "formatting inside image descriptions",
  "image-in-table.md": "images inside tables",
  "image-reference.md": "reference-style links",
  "image-path-brackets.md": "brackets in image paths"
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
async function throughVisualEditor(body: string, edit?: (editor: CrepeEditor) => void) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = new Crepe({ root, defaultValue: visualMarkdown(body), features: visualEditorFeatures });
  prepareVisualEditor(editor);
  try {
    await editor.create();
    edit?.(editor);
    return storedMarkdown(editor.getMarkdown(), owner, body);
  } finally {
    await editor.destroy();
    root.remove();
  }
}

/** Inserts a block image the way Crepe's image block does after an upload (src = what `onUpload` returned). */
function insertImageBlock(src: string) {
  return (editor: CrepeEditor) => editor.editor.action((ctx) => {
    const view = ctx.get("editorView");
    const type = view.state.schema.nodes["image-block"]!;
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, type.create({ src, caption: "", ratio: 1 })));
  });
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

  describe("LifeOS's own Summary section (#96)", () => {
    it("is written in the form the visual editor keeps byte-for-byte, with no 'Unproven formatting' label", async () => {
      const user = "# Weekly sync\n\n## Notes\n\nText.\n";
      for (const body of [
        withSummarySection(user, "* Agreed the scope\n* Review on Friday"),
        withSummarySection("", "Only a summary."),
        // A newer summary replacing one written in the older, unspaced form (summary-section.md).
        withSummarySection((await loadBody("summary-section.md")).body, "Replaced.")
      ]) {
        const saved = await throughVisualEditor(body);
        expect(saved).toBe(body);
        expect(roundTripReport(body, saved)).toEqual({ lossless: true, constructs: [] });
        expect(unprovenConstructs(body)).toEqual([]);
      }
    });

    it("the summary-section-written fixture is what withSummarySection writes", async () => {
      const { body } = await loadBody("summary-section-written.md");
      const summary = "* Agreed the scope\n* Review on Friday\n\n### Risks\n\nBudget.";
      // Migrating an unmarked (pre-#66) summary writes exactly the fixture; writing it again changes nothing.
      expect(withSummarySection("# Weekly sync\n\n## Summary\n\nOld.\n\n## Notes\n\nText.\n", summary)).toBe(body);
      expect(withSummarySection(body, summary)).toBe(body);
    });
  });

  describe("empty lines are never saved as <br /> (#96)", () => {
    const addEmptyParagraphs = (editor: CrepeEditor) => editor.editor.action((ctx) => {
      const view = ctx.get("editorView");
      const paragraph = view.state.schema.nodes["paragraph"]!;
      view.dispatch(view.state.tr.insert(view.state.doc.content.size, paragraph.create({})));
      view.dispatch(view.state.tr.insert(0, paragraph.create({})));
    });

    it("an empty paragraph added in Visual mode saves as nothing", async () => {
      const saved = await throughVisualEditor("First.\n\nSecond.\n", (editor) => {
        addEmptyParagraphs(editor);
        editor.editor.action((ctx) => {
          const view = ctx.get("editorView");
          view.dispatch(view.state.tr.insert(9, view.state.schema.nodes["paragraph"]!.create({}))); // between the two paragraphs
        });
      });
      expect(saved).not.toContain("<br");
      expect(saved).toBe("First.\n\nSecond.\n");
    });

    it("an empty line added inside a list item or quote saves as nothing", async () => {
      const insertAt = (...positions: number[]) => (editor: CrepeEditor) => editor.editor.action((ctx) => {
        const view = ctx.get("editorView");
        for (const at of positions) view.dispatch(view.state.tr.insert(at, view.state.schema.nodes["paragraph"]!.create({})));
      });
      expect(await throughVisualEditor("* a\n* b\n", insertAt(5))).toBe("* a\n* b\n"); // after the text of the first item
      expect(await throughVisualEditor("* a\n* b\n", insertAt(2, 2))).toBe("* a\n* b\n"); // before it, twice
      expect(await throughVisualEditor("* [ ] task\n", insertAt(2))).toBe("* [ ] task\n");
      expect(await throughVisualEditor("> Quote\n", insertAt(1, 9))).toBe("> Quote\n");
    });

    it("a <br /> an older save left in the note is kept, also when the note is edited elsewhere", async () => {
      const body = "First.\n\n<br />\n\nSecond.\n";
      expect(await throughVisualEditor(body)).toBe(body);
      const edited = await throughVisualEditor(body, (editor) => editor.editor.action((ctx) => {
        const view = ctx.get("editorView");
        view.dispatch(view.state.tr.insertText("Edited. ", 1));
      }));
      expect(edited).toBe("Edited. First.\n\n<br />\n\nSecond.\n");
    });
  });

  describe("images are never lost (#91)", () => {
    it("an untitled image survives an edit elsewhere in the note", async () => {
      const body = "Sketch: ![alt](assets/x.png)\n\n![Board](../assets/board.png)\n";
      const saved = await throughVisualEditor(body, (editor) => editor.editor.action((ctx) => {
        const view = ctx.get("editorView");
        view.dispatch(view.state.tr.insertText("Edited. ", 1));
      }));
      expect(saved).toBe("Edited. Sketch: ![alt](assets/x.png)\n\n![Board](../assets/board.png)\n");
    });

    it("an image inserted (uploaded) in Visual mode is saved and still there when the note is reopened", async () => {
      const uploaded = "/api/v1/assets/2026-10-04-whiteboard--0123456789abcdef.png"; // what the app's onUpload returns
      const saved = await throughVisualEditor("Notes.\n", insertImageBlock(uploaded));
      expect(saved).toBe("Notes.\n\n![](../assets/2026-10-04-whiteboard--0123456789abcdef.png)\n");
      expect(await throughVisualEditor(saved)).toBe(saved);
      expect(lostImages(saved, await throughVisualEditor(saved))).toEqual([]);
    });

    it("a block image keeps its alt text (Crepe would otherwise overwrite it with the image size)", async () => {
      const body = "![Quarterly chart](https://example.com/chart.png \"Q3\")\n";
      expect(await throughVisualEditor(body)).toBe(body);
    });

    it("no fixture loses an image, even the ones the editor rewrites", async () => {
      for (const name of [...LOSSLESS, ...Object.keys(KNOWN_FAILURES)]) {
        const { body } = await loadBody(name);
        expect(lostImages(body, await throughVisualEditor(body)), name).toEqual([]);
      }
    }, SLOW_UNDER_LOAD_MS);

    it("the save guard catches a real loss: unpatched Crepe drops an untitled image", async () => {
      const body = "Whiteboard:\n\n![Whiteboard photo](../assets/whiteboard.png)\n\nEnd.\n";
      const root = document.createElement("div");
      document.body.append(root);
      const editor = new Crepe({ root, defaultValue: visualMarkdown(body), features: visualEditorFeatures });
      try {
        await editor.create();
        const saved = storedMarkdown(editor.getMarkdown(), owner, body);
        expect(saved).toBe("Whiteboard:\n\nEnd.\n");
        expect(lostImages(body, saved)).toEqual(["Whiteboard photo → ../assets/whiteboard.png"]);
      } finally {
        await editor.destroy();
        root.remove();
      }
    });

    it("an asset name that is not valid percent-encoding still loads and survives", async () => {
      const body = "![Odd](../assets/100%.png)\n";
      expect(await throughVisualEditor(body)).toBe(body);
    });
  });

  describe("a pasted LifeOS link (PB-029)", () => {
    const id = "0190a1b2-0000-7000-8000-000000000001";
    const pasteLink = (title: string) => (editor: CrepeEditor) => insertLink(editor as never, title, `lifeos://object/${id}`);

    it("a plain title is saved as [Title](lifeos://object/<id>)", async () => {
      const saved = await throughVisualEditor("Start.\n", pasteLink("Pricing ideas"));
      expect(saved).toContain(`[Pricing ideas](lifeos://object/${id})`);
      expect(await throughVisualEditor(saved)).toBe(saved);
    });

    it("a title with \\, [, ] or | is saved escaped, stays one link and survives the next round trip", async () => {
      const title = "Q3 [draft] a|b \\ c";
      const saved = await throughVisualEditor("Start.\n", pasteLink(title));
      const link = saved.match(/\[.*\]\(lifeos:\/\/object\/[^)]+\)/)?.[0];
      // The editor writes its own escapes (it leaves | and a lone \ bare, which is also valid); what matters is one intact link.
      expect(link).toBe(`[Q3 \\[draft\\] a|b \\ c](lifeos://object/${id})`);
      expect(await throughVisualEditor(saved)).toBe(saved);
      // The helper's fuller escaping is read back as the same single link.
      const helperForm = `[${escapeLinkTitle(title)}](lifeos://object/${id})`;
      expect((await throughVisualEditor(`${helperForm}\n`)).match(/\(lifeos:\/\/object\/[^)]+\)/g)).toHaveLength(1);
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
  });
});
