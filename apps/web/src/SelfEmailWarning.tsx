// #76: shown on Today and System Health while the user's own addresses or the internal domains are unset,
// so the gap is not noticed only by visiting Settings. Words carry the message (never colour alone) and
// each link is a button that moves focus to the matching Settings card.
import React from "react";
import type { SetupWarning } from "@lifeos/contracts";
import { WarningCard } from "./WarningCard.js";

/** The Settings cards the warning links to. */
export const selfEmailsCardId = "settings-self-emails";
export const internalDomainsCardId = "settings-internal-domains";

export function SelfEmailWarning({ warning, onOpenSettings }: { warning?: SetupWarning; onOpenSettings: (cardId: string) => void }) {
  if (!warning || (!warning.selfEmailsMissing && !warning.internalDomainsMissing)) return null;
  const { selfEmailsMissing, internalDomainsMissing } = warning;
  const message = selfEmailsMissing
    ? `Until they are, no calendar attendee is recognised as you${internalDomainsMissing ? ", and nobody is marked External because no internal domain is set either" : ""}.`
    : "Until they are, nobody is marked External automatically.";
  return <WarningCard label="SETUP NEEDED" title={selfEmailsMissing ? "Your email addresses are not set" : "Internal domains are not set"} role="status">
    <p>{message}</p>
    <div className="capture-row">
      {selfEmailsMissing && <button type="button" onClick={() => onOpenSettings(selfEmailsCardId)}>Set my email addresses in Settings</button>}
      {internalDomainsMissing && <button type="button" onClick={() => onOpenSettings(internalDomainsCardId)}>Set internal domains in Settings</button>}
    </div>
  </WarningCard>;
}
