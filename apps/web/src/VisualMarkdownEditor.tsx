import React, { useEffect, useRef, useState } from "react";
import { lostImages, roundTripReport, storedMarkdown, visualEditorFeatures, visualMarkdown, type RoundTripReport } from "./editorMarkdown.js";
import { imagePreviewSource, storeManagedImage, type EditorOwner } from "./editorAssets.js";
import { lifeosLinkId, type LinkedObject } from "./lifeosLinks.js";
import { pasteLifeosLink } from "./visualLinkPaste.js";
import { ImageLossNotice } from "./ImageLossNotice.js";
import { UnprovenFormattingLabel } from "./UnprovenFormattingLabel.js";

type CrepeInstance = {
  create(): Promise<unknown>;
  getMarkdown(): string;
  destroy(): Promise<unknown>;
  setReadonly(value: boolean): unknown;
  editor: { config(configure: (ctx: { set(slice: string, value: unknown): void; update(slice: string, updater: (value: never) => unknown): void }) => void): unknown };
  on(callback: (listener: { markdownUpdated(callback: (context: unknown, markdown: string, previousMarkdown: string) => void): unknown }) => void): unknown;
};
type CrepeConstructor = new (config: { root: Node; defaultValue: string; features?: Record<string, boolean>; featureConfigs?: Record<string, unknown> }) => CrepeInstance;

/** Where the Note lives, for rewriting image paths; a Note not saved yet counts as one folder deep. */
const ownerPath = (owner: EditorOwner | undefined) => owner?.relativePath ?? "meetings/pending.md";

export function VisualMarkdownEditor({ editorKey, owner, ensureOwner, markdown, readOnly, onChange, linkObjects }: { linkObjects: LinkedObject[]; editorKey: string; owner: EditorOwner | undefined; ensureOwner?: () => Promise<EditorOwner | undefined>; markdown: string; readOnly: boolean; onChange: (markdown: string) => void}) {
  const root = useRef<HTMLDivElement>(null);
  const crepe = useRef<CrepeInstance | undefined>(undefined);
  // Latest props for callbacks created once per mount. Reading these through refs matters: `readOnly`
  // is true while an event is being opened (busy) and the editor finishes loading asynchronously, so
  // a value captured at mount time would leave the editor — and its ribbon, which Crepe hides when
  // read-only — locked until the next remount (PB-019).
  const latest = useRef({ owner, ensureOwner, readOnly, onChange, linkObjects });
  latest.current = { owner, ensureOwner, readOnly, onChange, linkObjects };
  // Only changes made after the user has focused the editor count as edits. Crepe can re-emit
  // normalized Markdown on its own after loading; that must never dirty the draft or trigger a save.
  const engaged = useRef(false);
  // #89: whether saving from this editor would rewrite Markdown the user did not edit.
  const [roundTrip, setRoundTrip] = useState<RoundTripReport>();
  // #91: images this editor would drop if it saved. When any, the editor stays read-only and never saves.
  const [lost, setLost] = useState<string[]>();
  const blocked = useRef(false);
  // The editor reports changes after a short delay (Crepe debounces markdownUpdated), so typing made just before the editor
  // goes away (the Visual / Markdown switch) would never reach the draft. Closing flushes it (#183), but only a real change
  // of the document: `reported` is the last text Crepe produced that the draft already accounts for (its load-time output
  // at first), so Crepe merely re-formatting a Note the user focused never becomes an edit or a save.
  const created = useRef(false);
  const reported = useRef("");
  const shown = useRef(markdown);
  shown.current = markdown;
  // Declared before the mount effect so its cleanup runs first, while the editor still exists. Runs on unmount only,
  // so a note switch (a new editorKey) never reports into the next note's draft.
  useEffect(() => () => {
    if (!crepe.current || !created.current || !engaged.current || blocked.current || latest.current.readOnly) return;
    try {
      const current = crepe.current.getMarkdown();
      if (current !== reported.current) latest.current.onChange(storedMarkdown(current, ownerPath(latest.current.owner), shown.current));
    } catch { /* the editor is already gone: nothing to flush */ }
  }, []);

  useEffect(() => {
    if (!root.current) return;
    let active = true;
    let instance: CrepeInstance | undefined;
    const editorRoot = root.current;
    engaged.current = false;
    blocked.current = false;
    created.current = false;
    setRoundTrip(undefined);
    setLost(undefined);
    void Promise.all([import("@milkdown/crepe"), import("./visualEditorImages.js")]).then(async ([crepePackage, { prepareVisualEditor }]) => {
      if (!active) return;
      const Crepe = (crepePackage as unknown as { Crepe: CrepeConstructor }).Crepe;
      const uploadManagedImage = async (file: File) => {
        const stored = await storeManagedImage(file, async () => latest.current.owner ?? await latest.current.ensureOwner?.());
        return `/api/v1/assets/${encodeURIComponent(stored.relativePath.replace(/^assets\//, ""))}`;
      };
      instance = new Crepe({
        root: editorRoot,
        defaultValue: visualMarkdown(markdown),
        features: visualEditorFeatures,
        featureConfigs: { "image-block": { onUpload: uploadManagedImage, inlineOnUpload: uploadManagedImage, blockOnUpload: uploadManagedImage, proxyDomURL: imagePreviewSource } }
      });
      crepe.current = instance;
      prepareVisualEditor(instance);
      // Milkdown blanks the href of links it does not consider safe, which includes lifeos://. Keep the
      // target on a data attribute so the app's click handler can still follow it (PB-007).
      instance.editor.config((ctx) => ctx.set("linkAttr", (mark: { attrs: { href?: string } }) => (lifeosLinkId(mark.attrs.href) ? { "data-lifeos-href": mark.attrs.href } : {})));
      instance.on((listener) => listener.markdownUpdated((_context, nextMarkdown) => {
        if (!engaged.current || blocked.current) return;
        reported.current = nextMarkdown;
        latest.current.onChange(storedMarkdown(nextMarkdown, ownerPath(latest.current.owner), markdown));
      }));
      await instance.create();
      created.current = true;
      if (!active) return;
      reported.current = instance.getMarkdown();
      const unedited = storedMarkdown(reported.current, ownerPath(latest.current.owner), markdown);
      const missing = lostImages(markdown, unedited);
      blocked.current = missing.length > 0;
      instance.setReadonly(latest.current.readOnly || blocked.current);
      setLost(missing);
      setRoundTrip(roundTripReport(markdown, unedited));
    });
    return () => { active = false; crepe.current = undefined; if (instance) void instance.destroy(); };
  }, [editorKey]);

  useEffect(() => { crepe.current?.setReadonly(readOnly || blocked.current); }, [readOnly]);
  return <><ImageLossNotice lost={lost} />{!lost?.length && <UnprovenFormattingLabel report={roundTrip} />}<div className="visual-markdown-editor" ref={root} onPasteCapture={(event) => { if (!latest.current.readOnly) pasteLifeosLink(event.nativeEvent, crepe.current as never, latest.current.linkObjects); }} onFocusCapture={() => { engaged.current = true; }} onPointerDownCapture={() => { engaged.current = true; }} /></>;
}
