// Settings (#68): connections and preferences, moved out of the App component. The synced settings only
// this page uses are loaded and saved here; App passes in what other pages share (timezone, calendars, connections).
import React, { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import type { CalendarOption, CalendarPrefs } from "./calendarPrefs.js";
import { ConnectionsNotice, type ConnectionsState } from "./connections.js";
import { PageHeader } from "./pageParts.js";
import { parseDomains, parseEmails } from "./personLabels.js";
import { SaveStatus, type SaveState } from "./SaveStatus.js";
import { BackupFolderCard } from "./BackupFolderCard.js";
import { internalDomainsCardId, selfEmailsCardId } from "./SelfEmailWarning.js";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type TodaySettings = { meetingHoursThreshold: number; briefTime: string; briefTimeZone: string; briefDays: Weekday[]; contentHash?: string };
type Props = {
  displayTimeZone: string; onDisplayTimeZoneChange: (zone: string) => void;
  calendarCatalog: CalendarOption[]; calendarCatalogLoaded: boolean; calendarPrefs: CalendarPrefs; onLoadCalendars: () => Promise<void>; onSaveCalendarPrefs: (prefs: CalendarPrefs) => Promise<string | undefined>;
  connections?: ConnectionsState; onRetryConnections: () => Promise<void>; busy: boolean; readOnly: boolean;
  onSaveGoogleSecrets: (provider: "calendar" | "drive", clientId: string, clientSecret: string) => Promise<boolean>;
  /** Reloads App's shared data after a save that changes other pages (labels, Today). */
  onChanged: () => Promise<void>;
};

const availableTimeZones = (() => {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  return supportedValuesOf ? supportedValuesOf("timeZone") : ["Europe/Paris", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
})();

export function SettingsPage({ displayTimeZone, onDisplayTimeZoneChange, calendarCatalog, calendarCatalogLoaded, calendarPrefs, onLoadCalendars, onSaveCalendarPrefs, connections, onRetryConnections, busy, readOnly, onSaveGoogleSecrets, onChanged }: Props) {
  const [todaySettings, setTodaySettings] = useState<TodaySettings>();
  const [internalDomains, setInternalDomains] = useState<{ domains: string[]; contentHash?: string }>();
  const [selfEmails, setSelfEmails] = useState<{ emails: string[]; contentHash?: string }>();
  const [focusSettings, setFocusSettings] = useState<{ maxMustDos: number; contentHash?: string }>();

  const loadInternalDomains = async () => setInternalDomains(await api<{ domains: string[]; contentHash?: string }>("/api/v1/settings/internal-domains").catch(() => undefined));

  /** #39: saves the synced internal-domains setting; resolves to an error message, or undefined on success. */
  const saveInternalDomains = async (domains: string[]): Promise<string | undefined> => {
    try {
      setInternalDomains(await api<{ domains: string[]; contentHash?: string }>("/api/v1/settings/internal-domains", { method: "PUT", body: JSON.stringify({ domains, expectedHash: internalDomains?.contentHash }) }));
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await loadInternalDomains(); return "The internal domains were changed on another device. The latest version is loaded; make your change again."; }
      return error instanceof Error ? error.message : "Could not save internal domains";
    }
  };

  const loadSelfEmails = async () => setSelfEmails(await api<{ emails: string[]; contentHash?: string }>("/api/v1/settings/self-emails").catch(() => undefined));

  /** #54: saves the synced self-email setting; resolves to an error message, or undefined on success. */
  const saveSelfEmails = async (emails: string[]): Promise<string | undefined> => {
    try {
      setSelfEmails(await api<{ emails: string[]; contentHash?: string }>("/api/v1/settings/self-emails", { method: "PUT", body: JSON.stringify({ emails, expectedHash: selfEmails?.contentHash }) }));
      // #76: reloads Today and System Health so their "not set" warning goes away at once.
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await loadSelfEmails(); return "Your email addresses were changed on another device. The latest version is loaded; make your change again."; }
      return error instanceof Error ? error.message : "Could not save your email addresses";
    }
  };

  const loadTodaySettings = async () => setTodaySettings(await api<TodaySettings>("/api/v1/settings/today").catch(() => undefined));
  /** #48: saves the synced Today settings; resolves to an error message, or undefined on success. */
  const saveTodaySettings = async (changes: Omit<TodaySettings, "contentHash">): Promise<string | undefined> => {
    try {
      setTodaySettings(await api<TodaySettings>("/api/v1/settings/today", { method: "PUT", body: JSON.stringify({ ...changes, expectedHash: todaySettings?.contentHash }) }));
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await loadTodaySettings(); return "The Today settings were changed on another device. The latest version is loaded; make your change again."; }
      return error instanceof Error ? error.message : "Could not save the Today settings";
    }
  };

  const loadFocusSettings = async () => setFocusSettings(await api<{ maxMustDos: number; contentHash?: string }>("/api/v1/settings/daily-focus").catch(() => undefined));
  /** #47: saves the synced max must-dos setting; resolves to an error message, or undefined on success. */
  const saveFocusSettings = async (maxMustDos: number): Promise<string | undefined> => {
    try {
      setFocusSettings(await api<{ maxMustDos: number; contentHash?: string }>("/api/v1/settings/daily-focus", { method: "PUT", body: JSON.stringify({ maxMustDos, expectedHash: focusSettings?.contentHash }) }));
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { await loadFocusSettings(); return "The setting was changed on another device. The latest version is loaded; make your change again."; }
      return error instanceof Error ? error.message : "Could not save the setting";
    }
  };

  // Opening Settings reloads every setting it shows, since another device may have changed them.
  useEffect(() => { void onLoadCalendars(); void loadInternalDomains(); void loadSelfEmails(); void loadFocusSettings(); void loadTodaySettings(); }, []);

  return <><PageHeader eyebrow="SETTINGS / CONNECTIONS" title="Connections and preferences" description="Credentials are write-only from this screen and stored in macOS Keychain, never Markdown or Git." /><article className="timezone-setting"><span>DISPLAY TIMEZONE</span><h3>{displayTimeZone}</h3><p className="muted">Timestamps remain portable UTC instants. LifeOS displays them in this device-specific IANA timezone, including daylight-saving changes.</p><select value={displayTimeZone} onChange={(event) => onDisplayTimeZoneChange(event.target.value)}>{availableTimeZones.map((zone) => <option key={zone}>{zone}</option>)}</select></article><CalendarListCard catalog={calendarCatalog} loaded={calendarCatalogLoaded} prefs={calendarPrefs} onSave={onSaveCalendarPrefs} /><SelfEmailsCard setting={selfEmails} disabled={readOnly} onSave={saveSelfEmails} /><InternalDomainsCard setting={internalDomains} disabled={readOnly} onSave={saveInternalDomains} /><MaxMustDosCard setting={focusSettings} disabled={readOnly} onSave={saveFocusSettings} /><TodaySettingsCard setting={todaySettings} disabled={readOnly} timeZones={availableTimeZones} onSave={saveTodaySettings} /><BackupFolderCard disabled={readOnly} /><ConnectionsNotice state={connections} busy={busy} onRetry={() => void onRetryConnections()} /><div className="settings-grid"><GoogleSecretCard provider="calendar" title="Google Calendar" status={connections?.settings?.calendar} busy={busy || readOnly} onSave={onSaveGoogleSecrets} /><GoogleSecretCard provider="drive" title="Google Drive" status={connections?.settings?.drive} busy={busy || readOnly} onSave={onSaveGoogleSecrets} /></div><article><span>SECURITY</span><p className="muted">LifeOS only reports whether credentials exist. Saved client secrets cannot be read back through the API or UI. Calendar authorization happens from the Calendar page after its credentials are configured.</p></article></>;
}

/** #47: the synced max must-dos setting: how many items Today's Top 3 shows. */
function MaxMustDosCard({ setting, disabled, onSave }: { setting?: { maxMustDos: number; contentHash?: string }; disabled: boolean; onSave: (maxMustDos: number) => Promise<string | undefined> }) {
  const [value, setValue] = useState(setting?.maxMustDos ?? 3);
  const [status, setStatus] = useState<SaveState>();
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (setting) setValue(setting.maxMustDos); }, [setting?.maxMustDos]);
  const save = async () => {
    setSaving(true);
    const error = await onSave(value);
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. Today's Top 3 now shows at most this many must-dos." });
  };
  return <article className="internal-domains-setting"><span>TODAY</span><h3>Max must-dos</h3>
    <p className="muted">How many items Today's Top 3 shows, whether from the morning brief or the priority rule. Pinned tasks count towards it.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><select aria-label="Max must-dos" value={value} disabled={disabled} onChange={(event) => { setValue(Number(event.target.value)); setStatus(undefined); }}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</select><button type="button" disabled={disabled || saving || value === setting.maxMustDos} onClick={save}>{saving ? "Saving…" : "Save"}</button></div>}
    <SaveStatus status={status} />
  </article>;
}

const weekdayNames: Array<[Weekday, string]> = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
/** #48: the synced Today settings: when a day counts as meeting-heavy, and when the morning routine writes the brief. */
function TodaySettingsCard({ setting, disabled, timeZones, onSave }: { setting?: TodaySettings; disabled: boolean; timeZones: string[]; onSave: (changes: Omit<TodaySettings, "contentHash">) => Promise<string | undefined> }) {
  const [threshold, setThreshold] = useState("");
  const [time, setTime] = useState("");
  const [zone, setZone] = useState("");
  const [days, setDays] = useState<Weekday[]>([]);
  const [status, setStatus] = useState<SaveState>();
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (setting) { setThreshold(String(setting.meetingHoursThreshold)); setTime(setting.briefTime); setZone(setting.briefTimeZone); setDays(setting.briefDays); } }, [setting]);
  const save = async () => {
    setSaving(true);
    const error = await onSave({ meetingHoursThreshold: Number(threshold), briefTime: time, briefTimeZone: zone, briefDays: days });
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved." });
  };
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setStatus(undefined); };
  return <article className="today-setting"><span>TODAY</span><h3>Meetings and morning brief</h3>
    {!setting ? <p className="muted">Loading…</p> : <>
      <label>Meeting-heavy day from (hours) <input type="number" min={0} max={24} step={0.5} value={threshold} disabled={disabled} onChange={(event) => edit(setThreshold)(event.target.value)} /></label>
      <p className="muted">Information only: Today notes a meeting-heavy day; nothing is blocked.</p>
      <label>Brief time <input type="time" value={time} disabled={disabled} onChange={(event) => edit(setTime)(event.target.value)} /></label>
      <label>Brief time zone <select value={zone} disabled={disabled} onChange={(event) => edit(setZone)(event.target.value)}>{[...new Set([zone, ...timeZones])].map((option) => <option key={option}>{option}</option>)}</select></label>
      <fieldset disabled={disabled}><legend>Brief days</legend>{weekdayNames.map(([day, name]) => <label key={day}><input type="checkbox" checked={days.includes(day)} onChange={(event) => edit(setDays)(event.target.checked ? [...days, day] : days.filter((value) => value !== day))} /> {name}</label>)}</fieldset>
      <button type="button" disabled={disabled || saving || !days.length || !threshold.trim() || !time} onClick={save}>{saving ? "Saving…" : "Save"}</button>
      {!days.length && <p className="calendar-error" role="alert">Choose at least one day.</p>}
    </>}
    <SaveStatus status={status} />
  </article>;
}

/** #39: the synced internal-domains setting. People with addresses only on other domains are shown as External. */
function InternalDomainsCard({ setting, disabled, onSave }: { setting?: { domains: string[]; contentHash?: string }; disabled: boolean; onSave: (domains: string[]) => Promise<string | undefined> }) {
  const saved = setting?.domains.join(", ") ?? "";
  const [text, setText] = useState(saved);
  const [status, setStatus] = useState<SaveState>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(saved), [saved]);
  const domains = parseDomains(text);
  const dirty = domains.join("|") !== (setting?.domains ?? []).join("|");
  const save = async () => {
    setSaving(true);
    const error = await onSave(domains);
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. People labels now use these domains." });
  };
  // #76: Today and System Health link here; tabIndex lets the link move keyboard focus to the card.
  return <article className="internal-domains-setting" id={internalDomainsCardId} tabIndex={-1}><span>PEOPLE</span><h3>Internal domains</h3>
    <p className="muted">Email domains of your own organisations, separated by commas. Anyone with addresses only on other domains is shown as "Name<span className="ext-suffix"> - ext</span>". You can override this on each person.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><input aria-label="Internal domains" value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setStatus(undefined); }} placeholder="example.com, example.org" /><button type="button" disabled={disabled || saving || !dirty || !domains.length} onClick={save}>{saving ? "Saving…" : "Save"}</button></div>}
    {setting && !setting.domains.length && !text.trim() && <p className="muted" role="status">Not set yet: nobody is marked External automatically.</p>}
    {setting && setting.domains.length > 0 && !domains.length && <p className="calendar-error" role="alert">Enter at least one domain.</p>}
    <SaveStatus status={status} />
  </article>;
}

/** #54: the user's own addresses, a synced setting. Attendees with one of them are you; unset means nobody is matched as you by email. */
function SelfEmailsCard({ setting, disabled, onSave }: { setting?: { emails: string[]; contentHash?: string }; disabled: boolean; onSave: (emails: string[]) => Promise<string | undefined> }) {
  const saved = setting?.emails.join(", ") ?? "";
  const [text, setText] = useState(saved);
  const [status, setStatus] = useState<SaveState>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(saved), [saved]);
  const emails = parseEmails(text);
  const dirty = emails.map((email) => email.toLowerCase()).join("|") !== (setting?.emails ?? []).join("|");
  const save = async () => {
    setSaving(true);
    const error = await onSave(emails);
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: emails.length ? "Saved. Attendees with these addresses are now you." : "Saved. No address is matched to you." });
  };
  // #76: Today and System Health link here; tabIndex lets the link move keyboard focus to the card.
  return <article className="internal-domains-setting" id={selfEmailsCardId} tabIndex={-1}><span>PEOPLE</span><h3>My email addresses</h3>
    <p className="muted">Every address you use, separated by commas. Calendar attendees with one of these addresses are linked to you instead of creating a new person.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><input aria-label="My email addresses" value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setStatus(undefined); }} placeholder="me@example.com, me@example.org" /><button type="button" disabled={disabled || saving || !dirty} onClick={save}>{saving ? "Saving…" : "Save"}</button></div>}
    {setting && !setting.emails.length && !status && <p className="muted" role="status">Not set yet: no attendee is recognised as you by email.</p>}
    <SaveStatus status={status} />
  </article>;
}

function CalendarListCard({ catalog, loaded, prefs, onSave }: { catalog: CalendarOption[]; loaded: boolean; prefs: CalendarPrefs; onSave: (prefs: CalendarPrefs) => Promise<string | undefined> }) {
  // Edits stay in this draft until Save, so a half-finished change (for example, nothing ticked) is never stored.
  const [disabled, setDisabled] = useState(prefs.disabledCalendarIds);
  const [defaultId, setDefaultId] = useState(prefs.defaultCalendarId);
  const [status, setStatus] = useState<SaveState>();
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDisabled(prefs.disabledCalendarIds); setDefaultId(prefs.defaultCalendarId); }, [prefs]);

  const selectedCount = catalog.filter((calendar) => !disabled.includes(calendar.id)).length;
  const allSelected = catalog.length > 0 && selectedCount === catalog.length;
  const noneSelected = catalog.length > 0 && selectedCount === 0;
  const dirty = defaultId !== prefs.defaultCalendarId || [...disabled].sort().join("|") !== [...prefs.disabledCalendarIds].sort().join("|");
  const defaultOff = Boolean(defaultId) && disabled.includes(defaultId!);
  const edit = <T,>(setter: (value: T) => void, value: T) => { setter(value); setStatus(undefined); };

  const save = async () => {
    setSaving(true);
    const error = await onSave({ ...prefs, disabledCalendarIds: disabled, defaultCalendarId: defaultId });
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. Your other devices will pick this up when the data folder syncs." });
  };

  return <article className="calendar-list-setting"><span>CALENDARS</span><h3>Calendars in the Calendar view</h3>
    <p className="muted">Tick the calendars to include. Hover a calendar to make it the default; the Calendar view opens on it.</p>
    {!loaded && <p className="muted">Loading calendars…</p>}
    {loaded && !catalog.length && <p className="muted">No calendars available. Connect Google Calendar to choose from your calendars.</p>}
    {catalog.length > 0 && <div className="calendar-toolbar">
      <button type="button" onClick={() => edit(setDisabled, allSelected ? catalog.map((calendar) => calendar.id) : [])}>{allSelected ? "Unselect all" : "Select all"}</button>
      <small className="muted">{selectedCount} of {catalog.length} selected</small>
    </div>}
    {catalog.map((calendar) => {
      const enabled = !disabled.includes(calendar.id);
      const isDefault = defaultId === calendar.id;
      return <div className="calendar-row" key={calendar.id}>
        <label><input type="checkbox" checked={enabled} onChange={(event) => edit(setDisabled, event.target.checked ? disabled.filter((id) => id !== calendar.id) : [...disabled, calendar.id])} /><i style={{ background: calendar.color ?? "#9aa39d" }} />{calendar.name}{isDefault && <b className="calendar-default-badge">Default</b>}</label>
        {enabled && <span className="calendar-row-actions">
          {isDefault
            ? <button type="button" onClick={() => edit(setDefaultId, undefined)}>Remove default</button>
            : <button type="button" onClick={() => edit(setDefaultId, calendar.id)}>Set as default</button>}
        </span>}
      </div>;
    })}
    {noneSelected && <p className="calendar-error" role="alert">Select at least one calendar. You can't save with none selected.</p>}
    {defaultOff && !noneSelected && <p className="muted" role="status">The default calendar is unticked, so the Calendar view will open on All calendars.</p>}
    {catalog.length > 0 && <div className="calendar-save">
      <button type="button" disabled={!dirty || noneSelected || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
      {dirty && !status && !noneSelected && <small className="muted">Unsaved changes</small>}
      <SaveStatus status={status} />
    </div>}
  </article>;
}

function GoogleSecretCard({ provider, title, status, busy, onSave }: { provider: "calendar" | "drive"; title: string; status?: { configured: boolean; connected: boolean }; busy: boolean; onSave: (provider: "calendar" | "drive", clientId: string, clientSecret: string) => Promise<boolean> }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setSaved(false);
    if (await onSave(provider, clientId, clientSecret)) {
      setClientId(""); setClientSecret(""); setSaved(true);
    }
  };
  return <article className="secret-card"><span>{title.toUpperCase()}</span><h3>{status?.configured ? "Credentials configured" : "Credentials required"}</h3><p className="muted">{status?.connected ? "Connected" : provider === "calendar" ? "Configure here, then authorize from Calendar." : "Stored for the upcoming Drive source connector."}</p>{saved && <div className="inline-success">Saved securely in macOS Keychain.</div>}<div className="knowledge-form"><input value={clientId} onChange={(event) => { setSaved(false); setClientId(event.target.value); }} placeholder="OAuth client ID" autoComplete="off" /><input type="password" value={clientSecret} onChange={(event) => { setSaved(false); setClientSecret(event.target.value); }} placeholder={status?.configured ? "Enter a new secret to replace it" : "OAuth client secret"} autoComplete="new-password" /><button className="primary" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={save}>{busy ? "Saving…" : status?.configured ? "Replace credentials" : "Save to Keychain"}</button></div></article>;
}
