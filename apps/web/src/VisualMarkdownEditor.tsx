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

/** What one Note's editing session reports into: that Note's change handler, owner, read-only state and text. */
type Session = { key: string; onChange: (markdown: string) => void; owner: EditorOwner | undefined; readOnly: boolean; markdown: string; instance?: CrepeInstance; reported: string };

/** `readOnly` is the lease (nothing may be reported); `busy` only locks typing while an operation runs. */
export function VisualMarkdownEditor({ editorKey, owner, ensureOwner, markdown, readOnly, busy = false, onChange, linkObjects }: { linkObjects: LinkedObject[]; editorKey: string; owner: EditorOwner | undefined; ensureOwner?: () => Promise<EditorOwner | undefined>; markdown: string; readOnly: boolean; busy?: boolean; onChange: (markdown: string) => void}) {
  const root = useRef<HTMLDivElement>(null);
  const crepe = useRef<CrepeInstance | undefined>(undefined);
  // Latest props for callbacks created once per mount. Reading these through refs matters: `readOnly`
  // is true while an event is being opened (busy) and the editor finishes loading asynchronously, so
  // a value captured at mount time would leave the editor — and its ribbon, which Crepe hides when
  // read-only — locked until the next remount (PB-019).
  const latest = useRef({ owner, ensureOwner, readOnly: readOnly || busy, onChange, linkObjects });
  latest.current = { owner, ensureOwner, readOnly: readOnly || busy, onChange, linkObjects };
  // Only changes made after the user has focused the editor count as edits. Crepe can re-emit
  // normalized Markdown on its own after loading; that must never dirty the draft or trigger a save.
  const engaged = useRef(false);
  // #89: whether saving from this editor would rewrite Markdown the user did not edit.
  const [roundTrip, setRoundTrip] = useState<RoundTripReport>();
  // #91: images this editor would drop if it saved. When any, the editor stays read-only and never saves.
  const [lost, setLost] = useState<string[]>();
  const blocked = useRef(false);
  // The editor reports changes after a short delay (Crepe debounces markdownUpdated), so typing made just before the editor
  // goes away or moves to another Note would never reach the draft. `flush` reports it at once, but only a real change of
  // the document: `reported` is the last text Crepe produced that the draft already accounts for (its load-time output at
  // first), so Crepe merely re-formatting a Note the user focused never becomes an edit or a save.
  // #192: the Notes tab and the meeting Note keep this editor mounted and only change `editorKey`. Everything a report
  // needs is held per Note in `session`, which stops following the props once the key changes: a flush or report for the
  // previous Note (the switch itself, or a blur before the old editor is torn down) always goes to that Note.
  const created = useRef(false);
  const session = useRef<Session>({ key: editorKey, onChange, owner, readOnly, markdown, reported: "" });
  if (session.current.key === editorKey) Object.assign(session.current, { onChange, owner, readOnly, markdown });
  const report = (target: Session, next: string) => {
    target.reported = next;
    target.onChange(storedMarkdown(next, ownerPath(target.owner), target.markdown));
  };
  const flush = (target: Session) => {
    if (!target.instance || !created.current || !engaged.current || blocked.current || target.readOnly) return;
    try {
      const current = target.instance.getMarkdown();
      if (current !== target.reported) report(target, current);
    } catch { /* the editor is already gone: nothing to flush */ }
  };

  useEffect(() => {
    if (!root.current) return;
    let active = true;
    let instance: CrepeInstance | undefined;
    const editorRoot = root.current;
    const mine: Session = session.current.key === editorKey ? session.current : { key: editorKey, onChange, owner, readOnly, markdown, reported: "" };
    session.current = mine;
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
      mine.instance = instance;
      prepareVisualEditor(instance);
      // Milkdown blanks the href of links it does not consider safe, which includes lifeos://. Keep the
      // target on a data attribute so the app's click handler can still follow it (PB-007).
      instance.editor.config((ctx) => ctx.set("linkAttr", (mark: { attrs: { href?: string } }) => (lifeosLinkId(mark.attrs.href) ? { "data-lifeos-href": mark.attrs.href } : {})));
      instance.on((listener) => listener.markdownUpdated((_context, nextMarkdown) => {
        // `active`: a closed editor's late report (its debounce firing after a note switch) was already flushed on close.
        if (!active || !engaged.current || blocked.current || nextMarkdown === mine.reported) return;
        report(mine, nextMarkdown);
      }));
      await instance.create();
      created.current = true;
      if (!active) return;
      mine.reported = instance.getMarkdown();
      const unedited = storedMarkdown(mine.reported, ownerPath(latest.current.owner), markdown);
      const missing = lostImages(markdown, unedited);
      blocked.current = missing.length > 0;
      instance.setReadonly(latest.current.readOnly || blocked.current);
      setLost(missing);
      setRoundTrip(roundTripReport(markdown, unedited));
    });
    // Closing the editor (the Visual / Markdown switch, #183) or moving to another Note (#192) flushes into this Note.
    return () => { flush(mine); active = false; crepe.current = undefined; if (instance) void instance.destroy(); };
  }, [editorKey]);

  useEffect(() => { crepe.current?.setReadonly(readOnly || busy || blocked.current); }, [readOnly, busy]);
  return <><ImageLossNotice lost={lost} />{!lost?.length && <UnprovenFormattingLabel report={roundTrip} />}<div className="visual-markdown-editor" ref={root} onPasteCapture={(event) => { if (!latest.current.readOnly) pasteLifeosLink(event.nativeEvent, crepe.current as never, latest.current.linkObjects); }} onFocusCapture={() => { engaged.current = true; }} onBlurCapture={() => flush(session.current)} onPointerDownCapture={() => { engaged.current = true; }} /></>;
}
