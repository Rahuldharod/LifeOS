import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";

export type StructuredEditorGuard = { dirty: boolean; conflict: boolean; saveNow: () => Promise<boolean> };
export const createStructuredEditorGuard = (): StructuredEditorGuard => ({ dirty: false, conflict: false, saveNow: async () => true });

/** One Save / Discard / Stay contract for local controls and shell-level navigation. */
export function useStructuredEditorGuard({ guard, dirty, canSave, save, discard, noun }: { guard: StructuredEditorGuard; dirty: boolean; canSave: boolean; save: () => Promise<boolean>; discard: () => void; noun: string }) {
  const [decision, setDecision] = useState<((value: boolean) => void) | undefined>();
  const latest = useRef({ dirty, canSave, save, discard }); latest.current = { dirty, canSave, save, discard };
  const requestLeave = useCallback(() => latest.current.dirty ? new Promise<boolean>((resolve) => setDecision(() => resolve)) : Promise.resolve(true), []);
  useLayoutEffect(() => {
    guard.dirty = dirty; guard.conflict = false; guard.saveNow = requestLeave;
    return () => { guard.dirty = false; guard.conflict = false; guard.saveNow = async () => true; };
  }, [guard, dirty, requestLeave]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = true; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const finish = async (choice: "save" | "discard" | "stay") => {
    const resolve = decision; if (!resolve) return;
    if (choice === "save" && (!latest.current.canSave || !(await latest.current.save()))) return;
    if (choice === "discard") latest.current.discard();
    setDecision(undefined); resolve(choice !== "stay");
  };
  return {
    leaveThen: async (action: () => void | Promise<unknown>) => { if (await requestLeave()) await action(); },
    dialog: decision ? <div className="dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="leave-structured-title" className="leave-dialog"><h3 id="leave-structured-title">Save changes before leaving?</h3><p>Your {noun} has unsaved changes.</p><div><button className="primary" disabled={!canSave} onClick={() => void finish("save")}>Save</button><button onClick={() => void finish("discard")}>Discard</button><button onClick={() => void finish("stay")}>Stay</button></div></section></div> : null
  };
}

/** Shared desktop split that becomes explicit list/detail states at narrow widths. */
export function ListDetailWorkspace({ detailOpen, children, list, detail, listLabel, detailLabel }: { detailOpen: boolean; children?: ReactNode; list?: ReactNode; detail?: ReactNode; listLabel?: string; detailLabel?: string }) {
  const narrow = useNarrowWorkspace();
  return <div className={`task-workspace${detailOpen ? " detail-open" : ""}`}>{children ?? <>
    <section className="task-list-pane" aria-label={listLabel} hidden={narrow && detailOpen}>{list}</section>
    <section className="task-detail-pane" aria-label={detailLabel} hidden={narrow && !detailOpen}>{detail}</section>
  </>}</div>;
}

/** The always-visible search/sort row and consistent advanced-filter disclosure. */
export function WorkspaceFilterBar({ advanced, onToggleAdvanced, children }: { advanced: boolean; onToggleAdvanced: () => void; children: ReactNode }) {
  return <div className="task-common-filters">{children}<button aria-expanded={advanced} onClick={onToggleAdvanced}>Advanced</button></div>;
}

/** Consistent record identity and narrow-screen return action. */
export function RecordHeader({ eyebrow, title, description, onBack }: { eyebrow: string; title: string; description: string; onBack: () => void }) {
  return <header className="record-header"><div><span>{eyebrow}</span><h2>{title}</h2><p className="muted">{description}</p></div><button className="narrow-back" onClick={onBack}>Back to tasks</button></header>;
}

/** Persistent structured-record feedback and explicit Save/Cancel actions. */
export function StickyRecordActions({ status, busy, saveDisabled, onCancel, onSave }: { status: string; busy: boolean; saveDisabled: boolean; onCancel: () => void; onSave: () => void }) {
  return <footer className="sticky-record-actions"><span role="status">{status}</span><div><button disabled={busy} onClick={onCancel}>Cancel</button><button className="primary" disabled={saveDisabled} onClick={onSave}>Save</button></div></footer>;
}
