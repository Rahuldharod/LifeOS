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

type MarkdownImage = { url?: string | null; alt?: string | null; title?: string | null };
type ParserState = { addNode(type: unknown, attrs: Record<string, unknown>): unknown };
type SerializerState = {
  openNode(type: string): unknown;
  addNode(type: string, children?: unknown, value?: unknown, props?: Record<string, unknown>): unknown;
  closeNode(): unknown;
};
type ImageNode = { attrs: Record<string, unknown> };
type NodeSchema = {
  attrs?: Record<string, unknown>;
  parseMarkdown: { match: (node: { type: string }) => boolean; runner: (state: ParserState, node: MarkdownImage, type: unknown) => void };
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
