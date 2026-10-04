// #84: shown on Today and System Health when a backup or the off-Drive copy failed, or none succeeded in 26 hours.
// Words carry the message (never colour alone): what is wrong, why, and a "Back up now" button.
import React from "react";

export type BackupWarningKind = "backup-failed" | "off-drive-failed" | "overdue";
export type BackupWarningState = { kind: BackupWarningKind; message: string; reason: string; at?: string };

export function BackupWarning({ warning, disabled, onBackUpNow }: { warning?: BackupWarningState; disabled: boolean; onBackUpNow: () => void }) {
  if (!warning) return null;
  return <article className="lease-warning" role="alert"><span>BACKUP PROBLEM</span>
    <h3>{warning.message}</h3>
    <p>Reason: {warning.reason}</p>
    <div className="capture-row"><button type="button" disabled={disabled} onClick={onBackUpNow}>Back up now</button></div>
  </article>;
}
