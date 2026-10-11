// Side-by-side conflict resolution for the Notes view (PB-002). Chosen after prototyping three
// directions (inline banner, this split panel, a blocking modal) — see the
// prototype/pb-002-conflict-ui branch for the other two and why this one won.
import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffNoteLines, type LineDiff } from "./noteDraft.js";

const mark = (kind: LineDiff["kind"]) => (kind === "added" ? "+" : kind === "removed" ? "−" : " ");

function DiffLines({ lines, only }: { lines: LineDiff[]; only: "added" | "removed" }) {
  return <>{lines.filter((line) => line.kind === "same" || line.kind === only).map((line, index) => (
    <div key={index} className={`diff-line diff-${line.kind}`}><span className="diff-mark">{mark(line.kind)}</span>{line.text || " "}</div>
  ))}</>;
}

/** Explains the diff colours once, next to wherever they first appear. Colour is never the only
 * signal — each swatch repeats the same +/− mark used on the diff lines themselves. Unchanged
 * lines get no swatch: they're the unhighlighted majority, so labelling them would say less than
 * leaving them alone does. */
function DiffLegend() {
  return (
    <div className="diff-legend">
      <span className="diff-legend-item diff-added"><span className="diff-mark">+</span>Added</span>
      <span className="diff-legend-item diff-removed"><span className="diff-mark">−</span>Removed</span>
    </div>
  );
}

export type NoteConflictPanelProps = {
  noteTitle: string;
  draftText: string;
  diskText: string;
  disabled: boolean;
  onKeepBrowserVersion: () => void;
  onKeepDiskVersion: () => void;
};

/**
 * Full-width side-by-side comparison, replacing the editor while a note's Markdown file and the
 * browser draft disagree. Readable Markdown is the default; exact line changes are optional.
 * User-resizable (native CSS `resize`, like a `<textarea>`): the default
 * width matches the space next to the note list, and the max bound leaves room for the sidebar
 * and note list so widening it can never force the whole page to scroll sideways. Each column
 * scrolls its own diff independently, with its "Keep ... version" button sticky to the bottom of
 * that scroll area, so it's always in view without scrolling past the diff to find it.
 */
export function NoteConflictPanel({ noteTitle, draftText, diskText, disabled, onKeepBrowserVersion, onKeepDiskVersion }: NoteConflictPanelProps) {
  const [precise, setPrecise] = useState(false);
  useEffect(() => { setPrecise(false); }, [noteTitle, draftText, diskText]);
  const lines = diffNoteLines(diskText, draftText);
  return (
    <div className="note-conflict-panel">
      <div className="note-conflict-header">
        <b>“{noteTitle}” has two versions.</b>
        <span>Something changed this file outside LifeOS while you had unsaved edits. Nothing has been overwritten — compare the two below, then pick one.</span>
        <button className="note-conflict-mode" aria-pressed={precise} onClick={() => setPrecise((value) => !value)}>{precise ? "Show readable versions" : "Show precise changes"}</button>
        {precise && <DiffLegend />}
      </div>
      <div className="note-conflict-columns">
        <div className="note-conflict-column">
          <div className="note-conflict-column-heading">Your browser draft <em>(unsaved)</em></div>
          {precise ? <pre className="note-conflict-text"><DiffLines lines={lines} only="added" /></pre> : <div className="note-conflict-rendered"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draftText || "_Empty note._"}</ReactMarkdown></div>}
          <div className="note-conflict-column-footer"><button className="primary" disabled={disabled} onClick={onKeepBrowserVersion}>Keep browser version</button></div>
        </div>
        <div className="note-conflict-column">
          <div className="note-conflict-column-heading">Current file <em>(on disk)</em></div>
          {precise ? <pre className="note-conflict-text"><DiffLines lines={lines} only="removed" /></pre> : <div className="note-conflict-rendered"><ReactMarkdown remarkPlugins={[remarkGfm]}>{diskText || "_Empty note._"}</ReactMarkdown></div>}
          <div className="note-conflict-column-footer"><button disabled={disabled} onClick={onKeepDiskVersion}>Keep current file</button></div>
        </div>
      </div>
    </div>
  );
}

/** Notes-list badge for a note with an unresolved conflict — text + icon, not colour alone. */
export function ConflictBadge() {
  return <span className="note-conflict-badge" title="This note has an unresolved conflict">⚠ Conflict</span>;
}
