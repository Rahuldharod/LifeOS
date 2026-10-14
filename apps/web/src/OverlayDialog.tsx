import React, { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

const focusable = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/** Shared modal behaviour for Search, Capture and the narrow navigation sheet: focus enters, stays inside, then returns to its trigger. */
export function OverlayDialog({ open, label, variant = "panel", onClose, children, className, style, decoration }: {
  open: boolean; label: string; variant?: "panel" | "sheet"; onClose: () => void; children: ReactNode;
  /** Extra class, inline size and a child placed on the dialog box itself (a resize handle), for dialogs that resize. */
  className?: string; style?: CSSProperties; decoration?: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const root = dialog.current;
    (root?.querySelector<HTMLElement>("[data-overlay-autofocus]") ?? root?.querySelector<HTMLElement>(focusable))?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab" || !root) return;
      const controls = [...root.querySelectorAll<HTMLElement>(focusable)].filter((control) => !control.hidden);
      if (!controls.length) return;
      const first = controls[0]!; const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [open]);
  if (!open) return null;
  return <div className={`overlay-backdrop${variant === "sheet" ? " overlay-sheet" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className={className ? `overlay-dialog ${className}` : "overlay-dialog"} style={style} role="dialog" aria-modal="true" aria-label={label}>{children}{decoration}</div>
  </div>;
}
