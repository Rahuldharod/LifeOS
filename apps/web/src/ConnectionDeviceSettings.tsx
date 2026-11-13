import React, { useEffect, useState } from "react";
import type { BackupSummary, BackupVerification, CalendarOffline, CalendarOption, CalendarPreferences, SystemHealth } from "@lifeos/contracts";
import { BackupFolderCard } from "./BackupFolderCard.js";
import { BackupWarning } from "./BackupWarning.js";
import { CalendarOfflineBanner } from "./CalendarOffline.js";
import { ConnectionsNotice, type ConnectionsState } from "./connections.js";
import { LeaseBanner, takeoverCaution, takeoverLabel, type LeaseBannerSession } from "./LeaseBanner.js";
import { SaveStatus, type SaveState } from "./SaveStatus.js";
import { useSettingsCardGuard, type SettingsSection } from "./SettingsWorkspace.js";
import { dateInTimeZone } from "./zonedTime.js";
import "./ConnectionDeviceSettings.css";

type SettingsProps = {
  calendarCatalog: CalendarOption[];
  calendarCatalogLoaded: boolean;
  calendarPrefs: CalendarPreferences;
  connections?: ConnectionsState;
  health?: SystemHealth;
  backups: BackupSummary[];
  lastVerification?: BackupVerification;
  systemLoading?: boolean;
  systemError?: string;
  busy: boolean;
  readOnly: boolean;
  displayTimeZone: string;
  onRetryConnections: () => Promise<void>;
  onSaveGoogleSecrets: (provider: "calendar" | "drive", clientId: string, clientSecret: string) => Promise<boolean>;
  onSaveCalendarPrefs: (prefs: CalendarPreferences) => Promise<string | undefined>;
  onCreateAndVerifyBackup: () => Promise<BackupVerification>;
  onVerifyBackup: (backupId: string) => Promise<BackupVerification>;
  onTakeOverSession: () => Promise<void>;
};

const connectionStatus = (state?: { configured: boolean; connected: boolean }) => state?.connected ? "Connected" : state?.configured ? "Configured" : "Not connected";
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const formatInstant = (instant: string, timeZone: string) => new Date(instant).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone });

function ConnectionStatusCard({ connections, busy, onRetry }: Pick<SettingsProps, "connections" | "busy"> & { onRetry: () => void }) {
  if (!connections) return <article aria-busy="true"><span>CONNECTION STATUS</span><h3>Loading connection status…</h3></article>;
  return <article className="connection-status-card"><span>CONNECTION STATUS</span><h3>Google services</h3>
    <dl><div><dt>Google Calendar</dt><dd>{connectionStatus(connections.settings?.calendar)}</dd></div><div><dt>Google Drive</dt><dd>{connectionStatus(connections.settings?.drive)}</dd></div></dl>
    <ConnectionsNotice state={connections} busy={busy} onRetry={onRetry} />
  </article>;
}

function GoogleCredentialCard({ provider, title, connections, busy, readOnly, onSave }: Pick<SettingsProps, "connections" | "busy" | "readOnly"> & { provider: "calendar" | "drive"; title: string; onSave: SettingsProps["onSaveGoogleSecrets"] }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setSaved(false); setError("");
    if (!clientId.trim() || !clientSecret.trim()) { setError("Enter both the OAuth client ID and client secret before saving."); return false; }
    try {
      if (await onSave(provider, clientId, clientSecret)) { setClientId(""); setClientSecret(""); setSaved(true); return true; }
    } catch {
      // Keep the write-only draft in this card so the user can retry without retyping it.
    }
    setError("Could not save the credentials. Your input is still here.");
    return false;
  };
  useSettingsCardGuard(`settings-google-${provider}`, { dirty: Boolean(clientId || clientSecret), save, discard: () => { setClientId(""); setClientSecret(""); setSaved(false); setError(""); } });
  if (!connections) return <article aria-busy="true"><span>{title.toUpperCase()}</span><h3>Loading {title} status…</h3></article>;
  const status = connections.settings?.[provider];
  return <article className="secret-card"><span>{title.toUpperCase()}</span><h3>{status?.configured ? "Credentials configured" : "Credentials required"}</h3><p className="muted">{status?.connected ? "Connected" : provider === "calendar" ? "Configure here, then authorize from Calendar." : "Stored for the upcoming Drive source connector."}</p>
    {saved && <div className="inline-success">Saved securely in macOS Keychain.</div>}{error && <p className="connection-local-error" role="alert">{error}</p>}
    <fieldset className="connection-secret-fieldset" disabled={readOnly}><div className="knowledge-form"><input aria-label={`${title} OAuth client ID`} value={clientId} onChange={(event) => { setSaved(false); setError(""); setClientId(event.target.value); }} placeholder="OAuth client ID" autoComplete="off" /><input aria-label={`${title} OAuth client secret`} type="password" value={clientSecret} onChange={(event) => { setSaved(false); setError(""); setClientSecret(event.target.value); }} placeholder={status?.configured ? "Enter a new secret to replace it" : "OAuth client secret"} autoComplete="new-password" /><button className="primary" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => void save()}>{busy ? "Saving…" : status?.configured ? "Replace credentials" : "Save to Keychain"}</button></div></fieldset>
  </article>;
}

export function CalendarPreferencesCard({ catalog, loaded, prefs, readOnly, onSave }: { catalog: CalendarOption[]; loaded: boolean; prefs: CalendarPreferences; readOnly: boolean; onSave: SettingsProps["onSaveCalendarPrefs"] }) {
  const [disabled, setDisabled] = useState(prefs.disabledCalendarIds);
  const [defaultId, setDefaultId] = useState(prefs.defaultCalendarId);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveState>();
  useEffect(() => { setDisabled(prefs.disabledCalendarIds); setDefaultId(prefs.defaultCalendarId); }, [prefs]);
  const selectedCount = catalog.filter((calendar) => !disabled.includes(calendar.id)).length;
  const noneSelected = catalog.length > 0 && selectedCount === 0;
  const dirty = defaultId !== prefs.defaultCalendarId || [...disabled].sort().join("|") !== [...prefs.disabledCalendarIds].sort().join("|");
  const edit = <T,>(setter: (value: T) => void, value: T) => { setter(value); setStatus(undefined); };
  const save = async () => {
    if (noneSelected) { setStatus({ kind: "error", text: "Select at least one calendar before saving." }); return false; }
    setSaving(true);
    try {
      const error = await onSave({ ...prefs, disabledCalendarIds: disabled, defaultCalendarId: defaultId });
      setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. Your other devices will pick this up when the data folder syncs." });
      return !error;
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "Could not save calendar preferences" });
      return false;
    } finally { setSaving(false); }
  };
  useSettingsCardGuard("settings-calendar-list", { dirty, save, discard: () => { setDisabled(prefs.disabledCalendarIds); setDefaultId(prefs.defaultCalendarId); setStatus(undefined); } });
  return <article className="connection-calendar-card"><span>CALENDARS</span><h3>Calendars in the Calendar view</h3><p className="muted">Choose which calendars appear and which one opens by default.</p>
    {!loaded && <p aria-busy="true">Loading calendars…</p>}
    {loaded && !catalog.length && <p className="muted">No calendars available. Connect Google Calendar to choose from your calendars.</p>}
    {catalog.map((calendar) => { const enabled = !disabled.includes(calendar.id); return <div className="connection-calendar-row" key={calendar.id}><label><input type="checkbox" checked={enabled} disabled={readOnly} onChange={(event) => edit(setDisabled, event.target.checked ? disabled.filter((id) => id !== calendar.id) : [...disabled, calendar.id])} /><i style={{ background: calendar.color ?? "var(--color-border-strong)" }} />{calendar.name}</label>{enabled && <button type="button" disabled={readOnly} onClick={() => edit(setDefaultId, defaultId === calendar.id ? undefined : calendar.id)}>{defaultId === calendar.id ? "Remove default" : "Set as default"}</button>}</div>; })}
    {noneSelected && <p className="connection-local-error" role="alert">Select at least one calendar. You can't save with none selected.</p>}
    {catalog.length > 0 && <div className="connection-actions"><button type="button" disabled={readOnly || saving || !dirty || noneSelected} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button><small>{selectedCount} of {catalog.length} selected</small></div>}
    <SaveStatus status={status} />
  </article>;
}

function VerificationResult({ result }: { result: BackupVerification }) {
  return <div className={`connection-verification ${result.valid ? "valid" : "invalid"}`} role={result.valid ? "status" : "alert"}><b>{result.valid ? "Restoration drill passed" : "Verification failed"}</b><span>{result.fileCount} files · {formatBytes(result.totalBytes)} · temporary restore {result.restoredToTemporaryDirectory ? "completed" : "not attempted"}</span>{result.diagnostics.map((item) => <small key={item}>{item}</small>)}</div>;
}

function BackupsCard({ backups, lastVerification, health, busy, readOnly, displayTimeZone, onCreateAndVerifyBackup, onVerifyBackup }: Pick<SettingsProps, "backups" | "lastVerification" | "health" | "busy" | "readOnly" | "displayTimeZone" | "onCreateAndVerifyBackup" | "onVerifyBackup">) {
  const [verification, setVerification] = useState(lastVerification);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setVerification(lastVerification), [lastVerification]);
  const run = async (work: () => Promise<BackupVerification>) => {
    if (working || busy) return;
    setWorking(true); setError("");
    try { setVerification(await work()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Backup action failed"); }
    finally { setWorking(false); }
  };
  return <article className="connection-backup-card"><div className="connection-card-heading"><div><span>VERSIONED BACKUPS</span><h3>Snapshots and restoration drills</h3></div><button type="button" disabled={busy || working || readOnly} onClick={() => void run(onCreateAndVerifyBackup)}>Create &amp; verify snapshot</button></div>
    <p className="muted">Snapshots contain Markdown, assets and a SHA-256 manifest. The live device lease and secrets are excluded.</p>
    <BackupWarning warning={health?.backupWarning} disabled={busy || working || readOnly} onBackUpNow={() => void run(onCreateAndVerifyBackup)} />
    {error && <p className="connection-local-error" role="alert">{error}</p>}
    {verification && <VerificationResult result={verification} />}
    {!backups.length ? <p className="muted">No snapshots have been created yet.</p> : <div className="connection-backup-list">{backups.map((backup) => <div key={backup.backupId}><span><b aria-label={`Created ${dateInTimeZone(new Date(backup.createdAt), displayTimeZone)}`}>{formatInstant(backup.createdAt, displayTimeZone)}</b><small>{backup.fileCount} files · {formatBytes(backup.totalBytes)}</small><code>{backup.backupId}</code></span><button type="button" disabled={busy || working || readOnly} onClick={() => void run(() => onVerifyBackup(backup.backupId))}>Test restore</button></div>)}</div>}
  </article>;
}

function SystemHealthCard({ health, loading, error }: { health?: SystemHealth; loading?: boolean; error?: string }) {
  return <article className="connection-health-card"><span>SYSTEM HEALTH</span><h3>System health</h3>
    {loading ? <p aria-busy="true">Loading system health…</p> : error ? <p className="connection-local-error" role="alert">{error}</p> : health ? <><dl><div><dt>Object graph</dt><dd>{health.diagnostics.length ? "Attention" : "Healthy"}</dd></div><div><dt>Objects</dt><dd>{health.objectCount} indexed objects</dd></div><div><dt>Write access</dt><dd>{health.session.writeAllowed ? "Enabled" : "Read-only"}</dd></div><div><dt>Active device</dt><dd>{health.session.activeDeviceId}</dd></div></dl>{health.diagnostics.length ? <ul>{health.diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}</ul> : <p className="connection-health-ok">No duplicate IDs, broken links, type mismatches or duplicate canonical notes.</p>}</> : <p className="muted">System health is unavailable.</p>}
  </article>;
}

function SafeHandoffCard({ health, busy, onTakeOver }: { health?: SystemHealth; busy: boolean; onTakeOver: () => Promise<void> }) {
  const readOnly = health?.session.writeAllowed === false;
  return <article><span>SAFE HANDOFF</span><h3>Move safely between devices</h3><ol><li>Finish and close LifeOS on this computer.</li><li>Wait until Google Drive reports synchronization complete.</li><li>On the other computer, wait for incoming sync to finish.</li><li>Start LifeOS and confirm System Health before editing.</li></ol>{readOnly && <><p>{health?.session.warning ?? "This Mac does not currently hold the write lease."}</p><p>{takeoverCaution}</p><button type="button" disabled={busy} onClick={() => void onTakeOver()}>{takeoverLabel}</button></>}
  </article>;
}

/** Ticket-owned section definitions; the grouped Settings root appends these without changing write boundaries. */
export function connectionDeviceSettingsSections(props: SettingsProps): SettingsSection[] {
  return [
    { id: "calendars", group: "Connections", label: "Calendars", cards: [{ id: "settings-calendar-list", label: "Calendars in the Calendar view", safeStatus: props.calendarCatalogLoaded ? `${props.calendarCatalog.length} available` : "Loading", content: <CalendarPreferencesCard catalog={props.calendarCatalog} loaded={props.calendarCatalogLoaded} prefs={props.calendarPrefs} readOnly={props.readOnly} onSave={props.onSaveCalendarPrefs} /> }] },
    { id: "google", group: "Connections", label: "Google", cards: [
      { id: "settings-connections-status", label: "Connection status", content: <ConnectionStatusCard connections={props.connections} busy={props.busy} onRetry={() => void props.onRetryConnections()} /> },
      { id: "settings-google-calendar", label: "Google Calendar", safeStatus: props.connections ? connectionStatus(props.connections.settings?.calendar) : "Loading", content: <GoogleCredentialCard provider="calendar" title="Google Calendar" connections={props.connections} busy={props.busy} readOnly={props.readOnly} onSave={props.onSaveGoogleSecrets} /> },
      { id: "settings-google-drive", label: "Google Drive", safeStatus: props.connections ? connectionStatus(props.connections.settings?.drive) : "Loading", content: <GoogleCredentialCard provider="drive" title="Google Drive" connections={props.connections} busy={props.busy} readOnly={props.readOnly} onSave={props.onSaveGoogleSecrets} /> },
      { id: "settings-credentials-security", label: "Credential security", content: <article><span>SECURITY</span><h3>Credentials stay write-only</h3><p className="muted">LifeOS reports only whether credentials exist. Saved client secrets cannot be read back through the API or interface. Explicit Retry may ask macOS Keychain for access, but routine status checks use only remembered presence.</p></article> }
    ] },
    { id: "backups", group: "Data & devices", label: "Backups", cards: [
      { id: "settings-backup-folder", label: "Off-Drive backup folder", content: <BackupFolderCard disabled={props.readOnly} /> },
      { id: "settings-backup-snapshots", label: "Snapshots and restoration drills", safeStatus: props.lastVerification?.valid ? "Verified" : `${props.backups.length} snapshots`, content: <BackupsCard backups={props.backups} lastVerification={props.lastVerification} health={props.health} busy={props.busy} readOnly={props.readOnly} displayTimeZone={props.displayTimeZone} onCreateAndVerifyBackup={props.onCreateAndVerifyBackup} onVerifyBackup={props.onVerifyBackup} /> }
    ] },
    { id: "system-health", group: "Data & devices", label: "System health", cards: [
      { id: "settings-system-health", label: "System health", safeStatus: props.systemLoading ? "Loading" : props.health?.status, content: <SystemHealthCard health={props.health} loading={props.systemLoading} error={props.systemError} /> },
      { id: "settings-safe-handoff", label: "Safe device handoff", content: <SafeHandoffCard health={props.health} busy={props.busy} onTakeOver={props.onTakeOverSession} /> }
    ] }
  ];
}

/** Mount once above the active workspace so global read-only and Calendar-offline state is never buried in Settings. */
export function AppStatusBanners({ session, offline, busy, timeZone, onTakeOver, onRetryCalendar }: { session?: LeaseBannerSession; offline?: CalendarOffline; busy: boolean; timeZone: string; onTakeOver: () => Promise<void>; onRetryCalendar: () => Promise<void> }) {
  return <div className="app-status-banners">
    <LeaseBanner session={session} busy={busy} onTakeOver={() => void onTakeOver()} />
    <CalendarOfflineBanner offline={offline} timeZone={timeZone} busy={busy} onRetry={() => void onRetryCalendar()} />
  </div>;
}
