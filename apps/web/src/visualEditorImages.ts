// #91: Milkdown Crepe loses images in two ways, both fixed here by adjusting its two image schemas.
//
// 1. An image without a title (`![alt](path)`, the form Markdown mode inserts) reaches the editor with
//    `title: null`. Both image schemas declare `title`/`caption` as strings, so ProseMirror rejects
//    the node and the parser silently drops it — the image vanishes from the editor and from the save.
// 2. A paragraph holding only an image becomes Crepe's "image block", which stores the alt text as a
//    display size and writes it back as `![1.00](...)` — the alt text is overwritten on save.
//
// The schemas are Milkdown context slices named after the node, so they are adjusted in place before
// the editor is created. Block images keep their alt text in an extra attribute; their resize handle
// still works on screen but its size is not saved (plain Markdown has nowhere to keep it).
// The paragraph schema is adjusted the same way for empty lines (#96, `dropNewEmptyLines` below).

type MarkdownImage = { url?: string | null; alt?: string | null; title?: string | null };
type MarkdownParagraph = { children?: unknown[]; value?: unknown };
type ParserState = {
  addNode(type: unknown, attrs: Record<string, unknown>): unknown;
  openNode(type: unknown, attrs?: Record<string, unknown>): unknown;
  next(nodes: unknown): unknown;
  addText(text: string): unknown;
  closeNode(): unknown;
};
type SerializerState = {
  openNode(type: string): unknown;
  /** The Markdown node being built, i.e. the parent of the node being written (`root` for the note itself). */
  top(): { type: string; children?: unknown[] } | undefined;
  addNode(type: string, children?: unknown, value?: unknown, props?: Record<string, unknown>): unknown;
  closeNode(): unknown;
};
type ImageNode = { attrs: Record<string, unknown>; content?: { size: number } };
type NodeSchema = {
  attrs?: Record<string, unknown>;
  parseMarkdown: { match: (node: { type: string }) => boolean; runner: (state: ParserState, node: MarkdownImage & MarkdownParagraph, type: unknown) => void };
  toMarkdown: { match: (node: { type: { name: string } }) => boolean; runner: (state: SerializerState, node: ImageNode) => void };
  [key: string]: unknown;
};
type SchemaFactory = (ctx: unknown) => NodeSchema;
type ConfigContext = { update(slice: string, updater: (previous: SchemaFactory) => SchemaFactory): void };

/** The part of a Crepe instance this module needs (Crepe's published types do not resolve under this tsconfig). */
export type ImageAwareEditor = { editor: { config(configure: (ctx: ConfigContext) => void): unknown } };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Makes the visual editor keep every image, with its alt text and title, exactly. Call before `create()`. */
export function preserveImages(crepe: ImageAwareEditor) {
  crepe.editor.config((ctx) => {
    ctx.update("image", (previous) => (schemaCtx) => {
      const schema = previous(schemaCtx);
      return {
        ...schema,
        parseMarkdown: {
          ...schema.parseMarkdown,
          runner: (state, node, type) => { state.addNode(type, { src: text(node.url), alt: text(node.alt), title: text(node.title) }); }
        }
      };
    });
    ctx.update("image-block", (previous) => (schemaCtx) => {
      const schema = previous(schemaCtx);
      return {
        ...schema,
        attrs: { ...schema.attrs, alt: { default: "", validate: "string" } },
        parseMarkdown: {
          ...schema.parseMarkdown,
          runner: (state, node, type) => { state.addNode(type, { src: text(node.url), caption: text(node.title), ratio: 1, alt: text(node.alt) }); }
        },
        toMarkdown: {
          ...schema.toMarkdown,
          runner: (state, node) => {
            state.openNode("paragraph");
            state.addNode("image", undefined, undefined, { url: text(node.attrs.src), alt: text(node.attrs.alt), title: text(node.attrs.caption) || null });
            state.closeNode();
          }
        }
      };
    });
  });
}

/** The bits of a ProseMirror node the empty-line handling reads. */
type ProseNode = { type: { name: string }; attrs: Record<string, unknown>; content?: { size: number }; childCount: number; child(index: number): ProseNode };

/** An empty paragraph made in the editor (not one loaded from a `<br />` line). */
const isNewEmptyLine = (node: ProseNode) => node.type.name === "paragraph" && !node.content?.size && node.attrs.lifeosEmptyLine !== true;

/** Blocks that hold other blocks, and the containers being written right now (innermost last). */
const containerBlocks = ["blockquote", "bullet_list", "ordered_list"];
const openContainers: ProseNode[] = [];
const childrenOf = (node: ProseNode) => Array.from({ length: node.childCount }, (_, index) => node.child(index));

/** The quote or list item directly holding `paragraph`, if it is the innermost container being written. */
function holderOf(paragraph: ProseNode, markdownParent: string | undefined) {
  const container = openContainers[openContainers.length - 1];
  if (!container) return undefined;
  if (container.type.name === "blockquote") return markdownParent === "blockquote" && childrenOf(container).includes(paragraph) ? container : undefined;
  return markdownParent === "listItem" ? childrenOf(container).find((item) => childrenOf(item).includes(paragraph)) : undefined;
}

/**
 * #96: Crepe saves an empty paragraph (pressing Enter twice) as a `<br />` line, which then shows up in
 * the note in Markdown mode. With this, an empty paragraph made in the editor saves as nothing; in a list
 * item or quote with nothing else in it, it saves as an empty one (`*` alone), since Markdown cannot leave
 * that out. A `<br />` line an older save already left in the note loads as an empty paragraph that
 * remembers it and is written back exactly as before, so notes are not changed by being opened or edited
 * elsewhere. Anything not covered (a case this cannot place safely) keeps Crepe's own `<br />`.
 * Call before `create()`.
 */
export function dropNewEmptyLines(crepe: ImageAwareEditor) {
  crepe.editor.config((ctx) => {
    for (const name of containerBlocks) {
      ctx.update(name, (previous) => (schemaCtx) => {
        const schema = previous(schemaCtx);
        return {
          ...schema,
          toMarkdown: {
            ...schema.toMarkdown,
            runner: (state, node) => {
              openContainers.push(node as unknown as ProseNode);
              try { schema.toMarkdown.runner(state, node); } finally { openContainers.pop(); }
            }
          }
        };
      });
    }
    ctx.update("paragraph", (previous) => (schemaCtx) => {
      const schema = previous(schemaCtx);
      return {
        ...schema,
        attrs: { ...schema.attrs, lifeosEmptyLine: { default: false } },
        parseMarkdown: {
          ...schema.parseMarkdown,
          runner: (state, node, type) => {
            // Markdown itself has no empty paragraph: one only comes from a `<br />` line Crepe folded.
            state.openNode(type, { lifeosEmptyLine: Array.isArray(node.children) && node.children.length === 0 && !node.value });
            if (node.children) state.next(node.children);
            else state.addText(text(node.value));
            state.closeNode();
          }
        },
        toMarkdown: {
          ...schema.toMarkdown,
          runner: (state, node) => {
            const paragraph = node as unknown as ProseNode;
            if (!isNewEmptyLine(paragraph)) return schema.toMarkdown.runner(state, node);
            const parent = state.top();
            // Between blocks, or after other content in a list item or quote: left out.
            if (parent?.type === "root" || parent?.children?.length) return;
            // At the start of a list item or quote: left out when something else follows, otherwise kept empty.
            const holder = holderOf(paragraph, parent?.type);
            if (holder) {
              const children = childrenOf(holder);
              const index = children.indexOf(paragraph);
              if (index >= 0 && children.slice(0, index).every(isNewEmptyLine)) {
                if (children.some((child) => !isNewEmptyLine(child)) || index > 0) return;
                state.openNode("paragraph");
                state.closeNode();
                return;
              }
            }
            schema.toMarkdown.runner(state, node);
          }
        }
      };
    });
  });
}

/** Everything the visual editor needs before `create()` so that saving keeps the note as written. */
export function prepareVisualEditor(crepe: ImageAwareEditor) {
  preserveImages(crepe);
  dropNewEmptyLines(crepe);
}
