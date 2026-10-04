// #76: shown on Today and System Health while the user's own addresses are unset, so the gap is not
// noticed only by visiting Settings. Words carry the message (never colour alone) and the link is a button.
import React from "react";

export type SetupWarning = { selfEmailsMissing: true; internalDomainsMissing: boolean };
/** The Settings card the warning links to. */
export const selfEmailsCardId = "settings-self-emails";

export function SelfEmailWarning({ warning, onOpenSettings }: { warning?: SetupWarning; onOpenSettings: () => void }) {
  if (!warning) return null;
  return <article className="lease-warning" role="status"><span>SETUP NEEDED</span><h3>Your email addresses are not set</h3>
    <p>Until they are, no calendar attendee is recognised as you{warning.internalDomainsMissing ? ", and nobody is marked External because no internal domain is set either" : ""}.</p>
    <button type="button" onClick={onOpenSettings}>Set my email addresses in Settings</button>
  </article>;
}
