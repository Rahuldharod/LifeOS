import React, { useRef } from "react";
import type { LinkedObject } from "./lifeosLinks.js";
import { storeManagedImage, suggestedImageAlt, type EditorOwner } from "./editorAssets.js";
import { insertAtSelection, transformLines, wrapSelection, type Edit } from "./markdownEdit.js";
import { markdownPasteAction } from "./markdownPaste.js";
import { hasRawAnchorLines } from "./editorMarkdown.js";
import { InlineNotice } from "./InlineNotice.js";
import { MarkdownPreview } from "./MarkdownPreview.js";
import { objectLinkMarkdown } from "./objectLinkMarkdown.js";
import { VisualMarkdownEditor } from "./VisualMarkdownEditor.js";

export type EditorMode = "visual" | "write" | "preview";
export type { EditorOwner };

/** The Visual / Markdown / Preview switch, rendered inside a note header. */
export function ModeSwitch({ mode, onChange, visualDisabled = false }: { mode: EditorMode; onChange: (mode: EditorMode) => void; /** A shared Note with section anchors is kept in Markdown (#178). */ visualDisabled?: boolean }) {
  return <div className="mode-switch"><button className={mode === "visual" && !visualDisabled ? "selected" : ""} disabled={visualDisabled} title={visualDisabled ? "This shared note opens in Markdown to keep its structure" : undefined} onClick={() => onChange("visual")}>Visual</button><button className={mode === "write" || (visualDisabled && mode === "visual") ? "selected" : ""} onClick={() => onChange("write")}>Markdown</button><button className={mode === "preview" ? "selected" : ""} onClick={() => onChange("preview")}>Preview</button></div>;
}

export type MarkdownEditorProps = {
  mode: EditorMode;
  /** Remounts the visual editor when it changes (a different note, or a reopened one). */
  editorKey: string;
  draft: string;
  onChange: (markdown: string) => void;
  readOnly: boolean;
  busy: boolean;
  /** False while there is nothing to edit yet (a calendar event still loading): Markdown is disabled, Visual shows the preview. */
  ready?: boolean;
  /** The note images are stored against. `ensureOwner`, when given, wins and may create the note first (PB-020). */
  owner?: EditorOwner;
  ensureOwner?: () => Promise<EditorOwner | undefined>;
  linkObjects: LinkedObject[];
  setBusy: (busy: boolean) => void;
  notify: (message: string) => void;
  /** Awaited after an image is stored in Markdown mode (the meeting workspace reloads its lists). */
  onImageStored?: () => Promise<void>;
  placeholder: string;
  codeLanguagePrompt: string;
  /** Markdown mode inserts: the meeting editor leaves the caret before the insert, the Notes editor after it. */
  caretAfterInsert: boolean;
  /** The meeting editor refocuses the textarea after an image is inserted; the Notes editor does not. */
  refocusAfterImage: boolean;
};

/** One note editor in any of its three modes. Notes and the Calendar meeting workspace both render this;
 * the draft and its saving stay with the caller (useNoteDraftController). */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const { mode: requestedMode, editorKey, draft, onChange, readOnly, busy, ready = true, owner, ensureOwner, linkObjects, setBusy, notify, onImageStored, placeholder, codeLanguagePrompt, caretAfterInsert, refocusAfterImage } = props;
  // #178: a body with section anchor lines never opens in the visual editor, which would rewrite them.
  const keptInMarkdown = hasRawAnchorLines(draft);
  const mode: EditorMode = requestedMode === "visual" && keptInMarkdown ? "write" : requestedMode;
  const area = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  if (mode !== "write") {
    return mode === "visual" && ready
      ? <VisualMarkdownEditor linkObjects={linkObjects} editorKey={editorKey} owner={owner} ensureOwner={ensureOwner} markdown={draft} readOnly={readOnly} busy={busy} onChange={onChange} />
      : <MarkdownPreview markdown={draft} empty="_Nothing to preview yet._" />;
  }

  const selection = () => ({ start: area.current?.selectionStart ?? draft.length, end: area.current?.selectionEnd ?? area.current?.selectionStart ?? draft.length });
  // Runs a pure edit on the textarea's current selection, then restores focus and the new selection.
  const edit = (make: (selected: { start: number; end: number }) => Edit) => {
    const element = area.current;
    if (!element) return;
    const next = make({ start: element.selectionStart, end: element.selectionEnd });
    onChange(next.draft);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(next.select.start, next.select.end); });
  };
  const wrap = (before: string, after = "", placeholder_ = "text") => edit((selected) => wrapSelection(draft, selected, before, after, placeholder_));
  const insert = (content: string) => edit((selected) => insertAtSelection(draft, selected, content, caretAfterInsert ? content.length : 0));
  const lines = (transform: (line: string, index: number) => string, placeholder_ = "List item") => edit((selected) => transformLines(draft, selected, transform, placeholder_));
  const heading = (level: string) => { if (level) lines((line) => `${"#".repeat(Number(level))} ${line.replace(/^#{1,6}\s+/, "")}`, "Heading"); };
  const codeBlock = () => {
    const language = window.prompt(codeLanguagePrompt, "typescript");
    if (language !== null) wrap(`\n\n\`\`\`${language.trim()}\n`, "\n```\n\n", "code");
  };

  async function uploadImage(file: File) {
    if (!ready || !file.type.startsWith("image/")) return;
    const { start, end } = selection();
    const altText = window.prompt("Describe this image for accessibility", suggestedImageAlt(file));
    if (altText === null) return;
    setBusy(true);
    try {
      const stored = await storeManagedImage(file, async () => ensureOwner ? ensureOwner() : owner);
      const markdown = `![${altText.trim()}](${stored.markdownPath})`;
      onChange(`${draft.slice(0, start)}${markdown}${draft.slice(end)}`);
      if (refocusAfterImage) requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(start + markdown.length, start + markdown.length); });
      notify(stored.deduplicated ? "Existing image reused; Markdown link inserted" : "Image stored locally; Markdown link inserted");
      await onImageStored?.();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Image upload failed");
    } finally { setBusy(false); }
  }

  return <>
    {requestedMode === "visual" && keptInMarkdown && <InlineNotice className="unproven-formatting" role="note" title="Opened in Markdown">This shared note opens in Markdown to keep its structure.</InlineNotice>}
    <div className="toolbar">
      <select disabled={readOnly} aria-label="Heading level" defaultValue="" onChange={(event) => { heading(event.target.value); event.target.value = ""; }}><option value="" disabled>Heading</option><option value="1">H1</option><option value="2">H2</option><option value="3">H3</option><option value="4">H4</option></select>
      <button disabled={readOnly} title="Bold" onClick={() => wrap("**", "**")}>B</button>
      <button disabled={readOnly} title="Italic" onClick={() => wrap("*", "*")}><i>I</i></button>
      <button disabled={readOnly} title="Inline code" onClick={() => wrap("`", "`", "code")}>{"</>"}</button>
      <button disabled={readOnly} title="Fenced code block" onClick={codeBlock}>Code block</button>
      <button disabled={readOnly} title="Bulleted list" onClick={() => lines((line) => `- ${line.replace(/^[-*+]\s+/, "")}`)}>• List</button>
      <button disabled={readOnly} title="Numbered list" onClick={() => lines((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, "")}`)}>1. List</button>
      <button disabled={readOnly} title="Task checkbox" onClick={() => lines((line) => `- [ ] ${line.replace(/^- \[[ xX]\]\s+/, "")}`)}>☐ Task</button>
      <button disabled={readOnly} title="Blockquote" onClick={() => lines((line) => `> ${line.replace(/^>\s?/, "")}`)}>❯ Quote</button>
      <button disabled={readOnly} title="Link" onClick={() => wrap("[", "](https://)", "link text")}>Link</button>
      <button disabled={readOnly || busy} title="Upload image" onClick={() => imageInput.current?.click()}>Image</button>
      <input ref={imageInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ""; }} />
      <button disabled={readOnly} title="Horizontal divider" onClick={() => insert("\n\n---\n\n")}>―</button>
      <button disabled={readOnly} title="Insert table" onClick={() => insert("\n\n| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |\n\n")}>Table</button>
      <select disabled={readOnly} aria-label="Link a LifeOS object" defaultValue="" onChange={(event) => { const object = linkObjects.find((candidate) => candidate.frontmatter.id === event.target.value); if (object) insert(objectLinkMarkdown(object)); event.target.value = ""; }}><option value="" disabled>Link object…</option>{linkObjects.filter((object) => !object.frontmatter.deleted_at).sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title)).map((object) => <option key={object.frontmatter.id} value={object.frontmatter.id}>{object.frontmatter.type} · {object.frontmatter.title}</option>)}</select>
    </div>
    <textarea ref={area} disabled={!ready || busy || readOnly} value={draft} onChange={(event) => onChange(event.target.value)} onPaste={(event) => { const paste = markdownPasteAction(event.clipboardData, linkObjects); if (paste?.kind === "image") { event.preventDefault(); void uploadImage(paste.file); } else if (paste) { event.preventDefault(); insert(paste.markdown); } }} onDragOver={(event) => { if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) event.preventDefault(); }} onDrop={(event) => { const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/")); if (file) { event.preventDefault(); void uploadImage(file); } }} placeholder={placeholder} />
  </>;
}
