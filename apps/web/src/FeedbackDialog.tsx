import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BodyOf } from "@lifeos/contracts";
import { OverlayDialog } from "./OverlayDialog.js";

export type FeedbackRequest = BodyOf<"POST /api/v1/feedback">;
type Label = FeedbackRequest["label"];

/**
 * PB-018 / ADR 0022: the App Feedback popup. `onSend` saves one file in the data inbox and rejects with the server's message
 * when it cannot; the popup then stays open with the text so nothing typed is lost. Esc and the shared overlay handle focus.
 * The text, label and error live in `.feedback-dialog` (a form), which closes by unmounting with the overlay.
 */
export function FeedbackDialog({ open, page, object, onClose, onSend }: {
  open: boolean;
  /** The current tab, saved with the feedback. */
  page: string;
  /** `lifeos://object/<id>` of the open object, when one is open. */
  object?: string;
  onClose: () => void;
  onSend: (request: FeedbackRequest) => Promise<void>;
}) {
  return <OverlayDialog open={open} label="Send feedback" onClose={onClose}>
    <FeedbackForm page={page} object={object} onClose={onClose} onSend={onSend} />
  </OverlayDialog>;
}

function FeedbackForm({ page, object, onClose, onSend }: { page: string; object?: string; onClose: () => void; onSend: (request: FeedbackRequest) => Promise<void> }) {
  const [text, setText] = useState("");
  const [label, setLabel] = useState<Label>("feature");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // A late answer after the popup closed must not touch unmounted state.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true); setError("");
    try {
      await onSend({ label, text, page, ...(object ? { object } : {}) });
      onClose();
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "Feedback could not be saved");
    } finally {
      if (alive.current) setSending(false);
    }
  };

  return <form className="feedback-dialog" onSubmit={(event) => void send(event)}>
    <header className="global-search-header"><div><span>FEEDBACK</span><h2>Send feedback</h2></div><button type="button" aria-label="Close feedback" onClick={onClose}>×</button></header>
    <textarea className="feedback-text" aria-label="Feedback" placeholder="What went wrong, or what would help?" value={text} data-overlay-autofocus
      onChange={(event) => { setText(event.target.value); setError(""); }}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
    <fieldset className="feedback-label-toggle">
      <legend className="visually-hidden">Type of feedback</legend>
      {(["feature", "bug"] as const).map((value) => <label key={value}><input type="radio" name="feedback-label" value={value} checked={label === value} onChange={() => setLabel(value)} />{value === "bug" ? "Bug" : "Feature"}</label>)}
    </fieldset>
    {error && <p className="feedback-error" role="alert">{error}</p>}
    <p className="feedback-hint">Saved as a file in your LifeOS inbox. Cmd+Enter sends.</p>
    <div className="feedback-actions">
      <button type="button" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary" disabled={!text.trim() || sending}>{sending ? "Sending…" : "Send"}</button>
    </div>
  </form>;
}
