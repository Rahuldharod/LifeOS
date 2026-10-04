// #84: the synced "Off-Drive backup folder" setting (ADR 0005). A weekly copy of the latest backup goes there.
// It loads and saves itself, like the other Settings cards, and reports through the shared SaveStatus line.
import React, { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { SaveStatus, type SaveState } from "./SaveStatus.js";

export const backupFolderCardId = "settings-backup-folder";
type BackupSettings = { offDriveFolder?: string; contentHash?: string };

export function BackupFolderCard({ disabled }: { disabled: boolean }) {
  const [setting, setSetting] = useState<BackupSettings>();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<SaveState>();
  const [saving, setSaving] = useState(false);
  const load = async () => {
    const loaded = await api<BackupSettings>("/api/v1/settings/backups").catch(() => undefined);
    setSetting(loaded);
    setText(loaded?.offDriveFolder ?? "");
  };
  useEffect(() => { void load(); }, []);
  const dirty = text.trim() !== (setting?.offDriveFolder ?? "");
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api<BackupSettings>("/api/v1/settings/backups", { method: "PUT", body: JSON.stringify({ offDriveFolder: text.trim(), expectedHash: setting?.contentHash }) });
      setSetting(saved);
      setText(saved.offDriveFolder ?? "");
      setStatus({ kind: "saved", text: saved.offDriveFolder ? "Saved. The next backup copies here if the last copy is a week old." : "Saved. No off-Drive copy will be made." });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await load(); setStatus({ kind: "error", text: "The backup folder was changed on another device. The latest version is loaded; make your change again." }); }
      else setStatus({ kind: "error", text: error instanceof Error ? error.message : "Could not save the backup folder" });
    } finally {
      setSaving(false);
    }
  };
  return <article className="internal-domains-setting" id={backupFolderCardId} tabIndex={-1}><span>BACKUPS</span><h3>Off-Drive backup folder</h3>
    <p className="muted">A local folder outside Google Drive, such as an external disk. Once a week the latest checked backup is copied there; the last four copies are kept.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><input aria-label="Off-Drive backup folder" value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setStatus(undefined); }} placeholder="/Volumes/Backup/LifeOS" /><button type="button" disabled={disabled || saving || !dirty} onClick={save}>{saving ? "Saving…" : "Save"}</button></div>}
    {setting && !setting.offDriveFolder && !text.trim() && !status && <p className="muted" role="status">Not set yet: backups stay only inside the Google Drive folder.</p>}
    <SaveStatus status={status} />
  </article>;
}
