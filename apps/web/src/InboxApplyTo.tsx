import React from "react";
import { OverlayDialog } from "./OverlayDialog.js";
import type { Outcome } from "./inboxModel.js";

export type ApplyTarget = "focused" | "open";

/**
 * PB-046: in Split view, A or R with the Focused row not the Open item asks which one the action is for.
 * F picks the Focused row, O the Open item; Esc cancels and nothing is decided. F and O mean only this while it shows.
 */
export function InboxApplyTo({ outcome, focusedTitle, openTitle, onChoose, onCancel }: {
  outcome?: Outcome; focusedTitle?: string; openTitle?: string; onChoose: (target: ApplyTarget) => void; onCancel: () => void;
}) {
  const verb = outcome === "accepted" ? "Accept" : "Reject";
  const keys = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const lower = event.key.toLowerCase();
    if (lower === "f" || lower === "o") { event.preventDefault(); event.stopPropagation(); onChoose(lower === "f" ? "focused" : "open"); }
  };
  return <OverlayDialog open={outcome !== undefined} label={`${verb}: apply to which item?`} className="inbox-apply-to" onClose={onCancel}>
    <div onKeyDown={keys}>
      <h3>{verb} · Apply to:</h3>
      <div className="inbox-apply-to-choices">
        <button data-overlay-autofocus onClick={() => onChoose("focused")}><kbd>F</kbd> Focused row<small>{focusedTitle}</small></button>
        <button onClick={() => onChoose("open")}><kbd>O</kbd> Open item<small>{openTitle}</small></button>
      </div>
      <p className="muted">Esc cancels: nothing is {outcome}.</p>
    </div>
  </OverlayDialog>;
}
