// #84: shown on Today and System Health when a backup or the off-Drive copy failed, or none succeeded in 26 hours.
// Words carry the message (never colour alone): what is wrong, why, and a "Back up now" button.
import React from "react";
import type { BackupWarning as BackupWarningState } from "@lifeos/contracts";
import { WarningCard } from "./WarningCard.js";


export function BackupWarning({ warning, disabled, onBackUpNow }: { warning?: BackupWarningState; disabled: boolean; onBackUpNow: () => void }) {
  if (!warning) return null;
  return <WarningCard label="BACKUP PROBLEM" title={warning.message} role="alert">
    <p>Reason: {warning.reason}</p>
    <div className="capture-row"><button type="button" disabled={disabled} onClick={onBackUpNow}>Back up now</button></div>
  </WarningCard>;
}
