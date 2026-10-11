import React, { type ReactNode } from "react";

/** Shared desktop split that becomes explicit list/detail states at narrow widths. */
export function ListDetailWorkspace({ detailOpen, children }: { detailOpen: boolean; children: ReactNode }) {
  return <div className={`task-workspace${detailOpen ? " detail-open" : ""}`}>{children}</div>;
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
