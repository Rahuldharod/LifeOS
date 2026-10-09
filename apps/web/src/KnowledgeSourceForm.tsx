// #98: Preserve only saves the pasted text as a Source. Claude proposes Knowledge Notes from it through the
// LifeOS skills (ADR 0008); the app has no AI of its own.
import React from "react";

export const knowledgeSkillHelp = "Preserve saves the text as a Source. To turn it into Knowledge Notes, ask Claude to run LifeOS capture on it; proposals then appear in Inbox for review.";
export const sourcePreservedToast = "Source preserved. Ask Claude to run LifeOS capture to propose Knowledge Notes.";

export function KnowledgeSourceForm({ title, text, disabled, onTitleChange, onTextChange, onPreserve }: { title: string; text: string; disabled: boolean; onTitleChange: (value: string) => void; onTextChange: (value: string) => void; onPreserve: () => void }) {
  return <article><span>ADD RAW TEXT SOURCE</span>
    <div className="knowledge-form">
      <input value={title} onChange={(event) => onTitleChange(event.target.value)} placeholder="Source title" aria-label="Source title" />
      <textarea value={text} onChange={(event) => onTextChange(event.target.value)} placeholder="Paste source text or Markdown…" aria-label="Source text" />
      <button type="button" className="primary" disabled={disabled || !title.trim() || !text.trim()} onClick={onPreserve}>Preserve</button>
    </div>
    <p className="muted">{knowledgeSkillHelp}</p>
  </article>;
}
