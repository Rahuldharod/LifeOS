import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useSplitPane } from "./splitPane.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useNarrowWorkspace, usePublishedShellLayout } from "./useNarrowWorkspace.js";
import { OverlayDialog } from "./OverlayDialog.js";
import { detailMinWidth, listClamps, type ListWorkspace } from "./workspaceLayout.js";

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
    dialog: <OverlayDialog open={Boolean(decision)} label="Save changes before leaving" onClose={() => void finish("stay")}><section className="leave-dialog"><h3>Save changes before leaving?</h3><p>Your {noun} has unsaved changes.</p><div><button className="primary" disabled={!canSave} onClick={() => void finish("save")}>Save</button><button onClick={() => void finish("discard")}>Discard</button><button onClick={() => void finish("stay")}>Stay</button></div></section></OverlayDialog>
  };
}

/**
 * Shared list/detail workspace: a bounded, resizable list beside the detail on wider bands, and explicit
 * list-then-detail states with Back in the narrow band. `children` render after both panes (dialogs).
 */
export function ListDetailWorkspace({ workspace, detailOpen, selectedKey, list, detail, listLabel, detailLabel, listRef, children }: { workspace: ListWorkspace; detailOpen: boolean; selectedKey?: string; list: ReactNode; detail: ReactNode; listLabel: string; detailLabel: string; listRef?: Ref<HTMLElement>; children?: ReactNode }) {
  const narrow = useNarrowWorkspace();
  const shellLayout = usePublishedShellLayout();
  const paneWidth = shellLayout ? shellLayout.workspaceWidth - 2 * (shellLayout.band === "compact" ? 24 : shellLayout.band === "narrow" ? 16 : 32) : Infinity;
  const stacked = narrow || paneWidth < listClamps[workspace].min + detailMinWidth + 12;
  const split = useSplitPane(workspace);
  const ref = useListDetailReturn(selectedKey ?? (detailOpen ? "open" : undefined));
  return <div ref={ref} className={`task-workspace pane-workspace${detailOpen ? " detail-open" : ""}`} data-workspace={workspace} data-stacked={stacked} style={split.style}>
    <section ref={listRef} className="task-list-pane" data-pane="list" aria-label={listLabel} hidden={stacked && detailOpen}>{list}</section>
    {!stacked && <div {...split.dividerProps} />}
    <section className="task-detail-pane" data-pane="detail" aria-label={detailLabel} hidden={stacked && !detailOpen}>{detail}</section>
    {children}
  </div>;
}

/** The always-visible search/sort row and consistent advanced-filter disclosure. */
export function WorkspaceFilterBar({ advanced, onToggleAdvanced, children }: { advanced: boolean; onToggleAdvanced: () => void; children: ReactNode }) {
  return <div className="task-common-filters">{children}<button aria-expanded={advanced} onClick={onToggleAdvanced}>Advanced</button></div>;
}

/** Consistent record identity and narrow-screen return action. */
export function RecordHeader({ eyebrow, title, description, backLabel = "Back to tasks", onBack }: { eyebrow: string; title: string; description: string; backLabel?: string; onBack: () => void }) {
  return <header className="record-header"><button className="narrow-back" onClick={onBack}>{backLabel}</button><div><span>{eyebrow}</span><h2 data-detail-heading tabIndex={-1}>{title}</h2><p className="muted">{description}</p></div></header>;
}

/** Persistent structured-record feedback and explicit Save/Cancel actions. */
export function StickyRecordActions({ status, busy, saveDisabled, onCancel, onSave }: { status: string; busy: boolean; saveDisabled: boolean; onCancel: () => void; onSave: () => void }) {
  return <footer className="sticky-record-actions"><span role="status">{busy ? "Saving…" : status}</span><div><button disabled={busy} onClick={onCancel}>Cancel</button><LoadingButton className="primary" loading={busy} loadingLabel="Saving…" disabled={saveDisabled} onClick={onSave}>Save</LoadingButton></div></footer>;
}

/**
 * An action that keeps its width and context while it works. The label not on show is reserved by a hidden
 * pseudo-element in the same grid cell, so "Save" → "Saving…" never moves the layout; `aria-busy` tells
 * assistive technology what is happening and focus stays on the button.
 */
export function LoadingButton({ loading, loadingLabel, children, className, disabled, onClick }: { loading: boolean; loadingLabel: string; children: string; className?: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={className} aria-busy={loading || undefined} aria-disabled={loading || undefined} disabled={disabled && !loading} onClick={() => { if (!loading) onClick(); }}>
    <span className="button-labels" data-reserve={loading ? children : loadingLabel}>{loading ? loadingLabel : children}</span>
  </button>;
}
