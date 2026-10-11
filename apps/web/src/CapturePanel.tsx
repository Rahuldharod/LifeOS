import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { BodyOf, LifeObject } from "@lifeos/contracts";
import { blankCaptureDraft, clearCaptureDraft, readCaptureDraft, writeCaptureDraft, type CaptureDraft } from "./captureDraft.js";
import "./CapturePanel.css";

export type CaptureOption = { id: string; title: string };
export type CaptureRequest = BodyOf<"POST /api/v1/capture">;

type Props = {
  projects: CaptureOption[];
  owners: CaptureOption[];
  selfId?: string;
  busy?: boolean;
  readOnly: boolean;
  onSave: (request: CaptureRequest) => Promise<LifeObject>;
  onViewTask: (id: string) => void;
};

/** Capture content only. The application shell owns the side-panel overlay, focus trap, Escape and shortcut. */
export function CapturePanel({ projects, owners, selfId = "", busy = false, readOnly, onSave, onViewTask }: Props) {
  const [draft, setDraft] = useState<CaptureDraft>(() => readCaptureDraft(selfId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<LifeObject>();

  useEffect(() => { writeCaptureDraft(draft); }, [draft]);
  useEffect(() => {
    if (!draft.ownerPersonId && selfId) setDraft((current) => ({ ...current, ownerPersonId: selfId }));
  }, [draft.ownerPersonId, selfId]);

  const update = <K extends keyof CaptureDraft>(key: K, value: CaptureDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(undefined);
    setError("");
  };

  const save = async () => {
    if (!draft.text.trim() || saving || busy || readOnly) return;
    setSaving(true); setError("");
    try {
      const task = await onSave({
        requestId: draft.requestId,
        text: draft.text,
        primaryProjectId: draft.primaryProjectId || undefined,
        dueOn: draft.dueOn || undefined,
        ownerPersonId: draft.ownerPersonId || undefined,
        sensitivity: draft.sensitivity
      });
      clearCaptureDraft();
      setDraft(blankCaptureDraft(selfId));
      setSaved(task);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The task could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => { event.preventDefault(); void save(); };
  const taskKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
  };

  return <form className="capture-panel" onSubmit={submit}>
    <label className="capture-task-field">Task
      <textarea autoFocus rows={5} value={draft.text} onChange={(event) => update("text", event.target.value)} onKeyDown={taskKeyDown} placeholder="What needs to be done?" />
    </label>
    <div className="capture-primary-actions">
      <button type="button" aria-expanded={draft.detailsOpen} onClick={() => update("detailsOpen", !draft.detailsOpen)}>Optional details</button>
      <button className="primary" type="submit" disabled={!draft.text.trim() || saving || busy || readOnly}>{saving ? "Saving…" : "Save"}</button>
    </div>
    {draft.detailsOpen && <div className="capture-details">
      <label>Project<select value={draft.primaryProjectId} onChange={(event) => update("primaryProjectId", event.target.value)}><option value="">Inbox</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
      <label>Due date<input type="date" value={draft.dueOn} onChange={(event) => update("dueOn", event.target.value)} /></label>
      <label>Owner<select value={draft.ownerPersonId} onChange={(event) => update("ownerPersonId", event.target.value)}><option value="">Self</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.id === selfId ? "Self" : owner.title}</option>)}</select></label>
      <label>Sensitivity<select value={draft.sensitivity} onChange={(event) => update("sensitivity", event.target.value as CaptureDraft["sensitivity"])}><option value="normal">Normal</option><option value="restricted">Restricted</option></select></label>
    </div>}
    {readOnly && <p className="capture-message" role="status">This Mac is read-only. Keep editing here, then save after you take back write access.</p>}
    {error && <p className="capture-error" role="alert">{error}</p>}
    {saved && <p className="capture-message" role="status">Task saved. <button type="button" onClick={() => onViewTask(saved.frontmatter.id)}>View task</button></p>}
    <p className="capture-hint">Press {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to save. Enter starts a new line.</p>
  </form>;
}
