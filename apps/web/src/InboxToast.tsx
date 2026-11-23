import React, { useEffect, useRef, useState } from "react";

/** A button on the toast. `id` lets a key (Z for "undo") find it. */
export type ToastAction = { id: string; label: string; key?: string; run: () => void };
export type Toast = { message: string; actions: ToastAction[] };

/** A plain message stays 3 seconds; one with actions stays 8 (ADR 0025) so there is time to reach Undo. */
const plainMs = 3000;
const actionMs = 8000;

/** The toast and its timer; a new message replaces the old one. Hovering or focusing the toast holds it open. */
export function useInboxToast() {
  const [toast, setToast] = useState<Toast>({ message: "", actions: [] });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ms = useRef(plainMs);
  const held = useRef(false);
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = undefined; };
  const start = () => { stop(); timer.current = setTimeout(() => setToast({ message: "", actions: [] }), ms.current); };
  useEffect(() => stop, []);
  const notify = (message: string, actions: ToastAction[] = []) => {
    ms.current = actions.length ? actionMs : plainMs;
    setToast({ message, actions });
    if (held.current) stop(); else start(); // a message that arrives under the cursor waits there until it is let go
  };
  /** The action with this id, only while the toast is on screen. */
  const action = (id: string) => toast.message ? toast.actions.find((candidate) => candidate.id === id) : undefined;
  return { notification: toast.message, toast, notify, action, held: () => held.current, hold: () => { held.current = true; stop(); }, release: () => { held.current = false; if (toast.message) start(); } };
}

export function InboxToast({ toast, held, onHold, onRelease }: { toast: Toast; held?: () => boolean; onHold?: () => void; onRelease?: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  // A focused button that a new message replaces leaves without a blur event (Enter on Undo, then "back in the Inbox"):
  // after each change, a hold with neither the pointer nor focus still on the toast is let go, so it can time out again.
  useEffect(() => {
    const node = element.current;
    if (!held?.() || (node && (node.matches(":hover") || node.contains(globalThis.document.activeElement)))) return;
    onRelease?.();
  });
  if (!toast.message) return null;
  return <div ref={element} className="inbox-toast" role="status" onMouseEnter={onHold} onMouseLeave={onRelease} onFocus={onHold} onBlur={onRelease}>
    <span>{toast.message}</span>
    {toast.actions.map((action) => <button key={action.id} type="button" className="inbox-toast-action" data-toast-action={action.id} onClick={action.run}>{action.label}{action.key && <kbd>{action.key}</kbd>}</button>)}
  </div>;
}
