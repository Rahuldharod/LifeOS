// Settings (#68): connections and preferences, moved out of the App component. The synced settings only
// this page uses are loaded and saved here; App passes in what other pages share (timezone, calendars, connections).
import React, { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import type { BackupSummary, BackupVerification, CalendarOption, ClaudeSkillsStatus, CalendarPreferences as CalendarPrefs, FocusSettings, IgnoredAddress, InternalDomains, SelfEmails, SystemHealth, TodaySettings, Weekday } from "@lifeos/contracts";
import type { ConnectionsState } from "./connections.js";
import { parseDomains, parseEmails } from "./personLabels.js";
import { SaveStatus, type SaveState } from "./SaveStatus.js";
import { internalDomainsCardId, selfEmailsCardId } from "./SelfEmailWarning.js";
import { SettingsDesignPrototype } from "./SettingsDesignPrototype.js";
import { createSettingsEditorGuard, SettingsWorkspace, useSettingsCardGuard, type SettingsEditorGuard, type SettingsSection } from "./SettingsWorkspace.js";
import { connectionDeviceSettingsSections } from "./ConnectionDeviceSettings.js";

export type SettingsReferenceData = {
  projects?: string[];
  clients?: string[];
  products?: string[];
  people?: string[];
};

type Props = {
  displayTimeZone: string; onDisplayTimeZoneChange: (zone: string) => boolean | void | Promise<boolean | void>;
  calendarCatalog: CalendarOption[]; calendarCatalogLoaded: boolean; calendarPrefs: CalendarPrefs; onLoadCalendars: () => Promise<void>; onSaveCalendarPrefs: (prefs: CalendarPrefs) => Promise<string | undefined>;
  connections?: ConnectionsState; onRetryConnections: () => Promise<void>; busy: boolean; readOnly: boolean;
  onSaveGoogleSecrets: (provider: "calendar" | "drive", clientId: string, clientSecret: string) => Promise<boolean>;
  /** Reloads App's shared data after a save that changes other pages (labels, Today). */
  onChanged: () => Promise<void>;
  selectedCardId?: string;
  guard?: SettingsEditorGuard;
  onOpenCard?: (cardId: string) => void;
  referenceData?: SettingsReferenceData;
  referenceSections?: SettingsSection[];
  health?: SystemHealth;
  backups?: BackupSummary[];
  lastVerification?: BackupVerification;
  onCreateAndVerifyBackup?: () => Promise<BackupVerification>;
  onVerifyBackup?: (backupId: string) => Promise<BackupVerification>;
  onTakeOverSession?: () => Promise<void>;
};

const availableTimeZones = (() => {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  return supportedValuesOf ? supportedValuesOf("timeZone") : ["Europe/Paris", "UTC", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
})();

export function SettingsPage({ displayTimeZone, onDisplayTimeZoneChange, calendarCatalog, calendarCatalogLoaded, calendarPrefs, onLoadCalendars, onSaveCalendarPrefs, connections, onRetryConnections, busy, readOnly, onSaveGoogleSecrets, onChanged, selectedCardId, guard, onOpenCard, referenceData = {}, referenceSections, health, backups = [], lastVerification, onCreateAndVerifyBackup, onVerifyBackup, onTakeOverSession }: Props) {
  const [todaySettings, setTodaySettings] = useState<TodaySettings>();
  const [internalDomains, setInternalDomains] = useState<InternalDomains>();
  const [selfEmails, setSelfEmails] = useState<SelfEmails>();
  const [ignoredAddresses, setIgnoredAddresses] = useState<IgnoredAddress[]>();
  const [claudeSkills, setClaudeSkills] = useState<ClaudeSkillsStatus | "unavailable">();
  const [focusSettings, setFocusSettings] = useState<FocusSettings>();
  const [loadFailed, setLoadFailed] = useState(false);
  const fallbackGuard = useRef(createSettingsEditorGuard());

  // ADR 0020: informational only, so a failed read does not block the rest of Settings.
  const loadClaudeSkills = async () => {
    try { setClaudeSkills(await api("GET /api/v1/settings/claude-skills")); }
    catch { setClaudeSkills("unavailable"); }
  };

  const loadInternalDomains = async () => {
    try { setInternalDomains(await api("GET /api/v1/settings/internal-domains")); }
    catch { setLoadFailed(true); }
  };

  /** #39: saves the synced internal-domains setting; resolves to an error message, or undefined on success. */
  const saveInternalDomains = async (domains: string[]): Promise<string | undefined> => {
    try {
      setInternalDomains(await api("PUT /api/v1/settings/internal-domains", { body: { domains, expectedHash: internalDomains?.contentHash } }));
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return "The internal domains changed on another device. Your input is still here; reload Settings before trying again.";
      return error instanceof Error ? error.message : "Could not save internal domains";
    }
  };

  const loadSelfEmails = async () => {
    try { setSelfEmails(await api("GET /api/v1/settings/self-emails")); }
    catch { setLoadFailed(true); }
  };

  /** #54: saves the synced self-email setting; resolves to an error message, or undefined on success. */
  const saveSelfEmails = async (emails: string[]): Promise<string | undefined> => {
    try {
      setSelfEmails(await api("PUT /api/v1/settings/self-emails", { body: { emails, expectedHash: selfEmails?.contentHash } }));
      // #76: reloads Today and System Health so their "not set" warning goes away at once.
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return "Your email addresses changed on another device. Your input is still here; reload Settings before trying again.";
      return error instanceof Error ? error.message : "Could not save your email addresses";
    }
  };

  const loadIgnoredAddresses = async () => {
    try { setIgnoredAddresses(await api("GET /api/v1/people/ignored-addresses")); }
    catch { setLoadFailed(true); }
  };
  /** Undoes "Not a person": resolves to an error message, or undefined on success. */
  const undoNotAPerson = async (entry: IgnoredAddress): Promise<string | undefined> => {
    try {
      await api("POST /api/v1/people/:id/not-a-person/undo", { params: { id: entry.personId }, body: { expectedHash: entry.contentHash } });
      await loadIgnoredAddresses();
      await onChanged();
      return undefined;
    } catch (error) { return error instanceof Error ? error.message : "Could not undo"; }
  };

  const loadTodaySettings = async () => {
    try { setTodaySettings(await api("GET /api/v1/settings/today")); }
    catch { setLoadFailed(true); }
  };
  /** #48: saves the synced Today settings; resolves to an error message, or undefined on success. */
  const saveTodaySettings = async (changes: Omit<TodaySettings, "contentHash">): Promise<string | undefined> => {
    try {
      setTodaySettings(await api("PUT /api/v1/settings/today", { body: { ...changes, expectedHash: todaySettings?.contentHash } }));
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return "The Today settings changed on another device. Your input is still here; reload Settings before trying again.";
      return error instanceof Error ? error.message : "Could not save the Today settings";
    }
  };

  const loadFocusSettings = async () => {
    try { setFocusSettings(await api("GET /api/v1/settings/daily-focus")); }
    catch { setLoadFailed(true); }
  };
  /** #47: saves the synced max must-dos setting; resolves to an error message, or undefined on success. */
  const saveFocusSettings = async (maxMustDos: number): Promise<string | undefined> => {
    try {
      setFocusSettings(await api("PUT /api/v1/settings/daily-focus", { body: { maxMustDos, expectedHash: focusSettings?.contentHash } }));
      await onChanged();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return "This setting changed on another device. Your input is still here; reload Settings before trying again.";
      return error instanceof Error ? error.message : "Could not save the setting";
    }
  };

  // Opening Settings reloads every setting it shows, since another device may have changed them.
  useEffect(() => { void onLoadCalendars().catch(() => setLoadFailed(true)); void loadInternalDomains(); void loadSelfEmails(); void loadIgnoredAddresses(); void loadFocusSettings(); void loadTodaySettings(); void loadClaudeSkills(); }, []);

  if ((import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV && new URLSearchParams(window.location.search).has("variant")) return <SettingsDesignPrototype />;

  const sections: SettingsSection[] = [
    { id: "my-lifeos", group: "My LifeOS", label: "Preferences", cards: [
      { id: "settings-display-timezone", label: "Display timezone", safeStatus: displayTimeZone, content: <DisplayTimeZoneCard displayTimeZone={displayTimeZone} disabled={readOnly} onSave={onDisplayTimeZoneChange} /> },
      { id: "settings-max-must-dos", label: "Max must-dos", safeStatus: focusSettings ? String(focusSettings.maxMustDos) : "Loading", content: <MaxMustDosCard setting={focusSettings} disabled={readOnly} onSave={saveFocusSettings} /> },
      { id: "settings-today", label: "Today", safeStatus: todaySettings ? `${todaySettings.briefTime} ${todaySettings.briefTimeZone}` : "Loading", content: <TodaySettingsCard setting={todaySettings} disabled={readOnly} timeZones={availableTimeZones} onSave={saveTodaySettings} /> }
    ] },
    { id: "identity", group: "My LifeOS", label: "Identity", cards: [
      { id: selfEmailsCardId, label: "My email addresses", content: <SelfEmailsCard setting={selfEmails} disabled={readOnly} onSave={saveSelfEmails} /> },
      { id: internalDomainsCardId, label: "Internal domains", content: <InternalDomainsCard setting={internalDomains} disabled={readOnly} onSave={saveInternalDomains} /> },
      { id: ignoredAddressesCardId, label: "Ignored addresses", content: <IgnoredAddressesCard entries={ignoredAddresses} disabled={readOnly} onUndo={undoNotAPerson} /> }
    ] },
    { id: "claude", group: "My LifeOS", label: "Claude skills", cards: [
      { id: "settings-claude-skills", label: "Claude skills", safeStatus: claudeSkillsSummary(claudeSkills), content: <ClaudeSkillsCard status={claudeSkills} displayTimeZone={displayTimeZone} /> }
    ] },
    ...(onCreateAndVerifyBackup && onVerifyBackup && onTakeOverSession ? connectionDeviceSettingsSections({ calendarCatalog, calendarCatalogLoaded, calendarPrefs, connections, health, backups, lastVerification, busy, readOnly, displayTimeZone, onRetryConnections, onSaveGoogleSecrets, onSaveCalendarPrefs, onCreateAndVerifyBackup, onVerifyBackup, onTakeOverSession }) : []),
    ...(referenceSections ?? (["projects", "clients", "products", "people"] as const).map((kind): SettingsSection => ({ id: `reference-${kind}`, group: "Reference data", label: kind[0]!.toUpperCase() + kind.slice(1), cards: [{ id: `settings-reference-${kind}`, label: kind[0]!.toUpperCase() + kind.slice(1), safeNames: referenceData[kind] ?? [], content: <ReferenceDataCard label={kind} names={referenceData[kind] ?? []} /> }] })))
  ];

  return <SettingsWorkspace sections={sections} selectedCardId={selectedCardId} loading={!loadFailed && (!todaySettings || !internalDomains || !selfEmails || !focusSettings || !calendarCatalogLoaded)} failure={loadFailed ? "Settings could not be loaded. Leave this page and try again." : undefined} readOnly={readOnly} guard={guard ?? fallbackGuard.current} onOpenCard={onOpenCard} />;
}

export function DisplayTimeZoneCard({ displayTimeZone, disabled, onSave }: { displayTimeZone: string; disabled: boolean; onSave: (zone: string) => boolean | void | Promise<boolean | void> }) {
  const [value, setValue] = useState(displayTimeZone);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveState>();
  useEffect(() => setValue(displayTimeZone), [displayTimeZone]);
  const dirty = value !== displayTimeZone;
  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const saved = await onSave(value);
      if (saved === false) { setStatus({ kind: "error", text: "Could not save the display timezone. Your choice is still here." }); return false; }
      setStatus({ kind: "saved", text: "Saved on this device." });
      return true;
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "Could not save the display timezone. Your choice is still here." });
      return false;
    } finally {
      setSaving(false);
    }
  };
  useSettingsCardGuard("settings-display-timezone", { dirty, save, discard: () => { setValue(displayTimeZone); setStatus(undefined); } });
  return <article className="timezone-setting"><span>DISPLAY TIMEZONE</span><h3>{displayTimeZone}</h3><p className="muted">Timestamps remain portable UTC instants. LifeOS displays them in this device-specific IANA timezone, including daylight-saving changes.</p><div className="capture-row"><select aria-label="Display timezone" value={value} disabled={disabled} onChange={(event) => { setValue(event.target.value); setStatus(undefined); }}>{[...new Set([displayTimeZone, ...availableTimeZones])].map((zone) => <option key={zone}>{zone}</option>)}</select><button type="button" disabled={disabled || saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button></div><SaveStatus status={status} /></article>;
}

function claudeSkillsSummary(status?: ClaudeSkillsStatus | "unavailable") {
  if (!status) return "Loading";
  if (status === "unavailable" || !status.lastSeen) return `Pack ${status === "unavailable" ? "?" : status.expected}`;
  return status.lastSeen.outdated ? "Out of date" : "Up to date";
}

/** ADR 0020: whether the installed Claude skills match this LifeOS, and how to install or update them. */
function ClaudeSkillsCard({ status, displayTimeZone }: { status?: ClaudeSkillsStatus | "unavailable"; displayTimeZone: string }) {
  const intro = <p className="muted">Claude writes into LifeOS with the LifeOS skills you install in Claude. Formats come from LifeOS itself, so you only reinstall when this card says so.</p>;
  if (!status) return <article className="claude-skills-setting"><span>CLAUDE</span><h3>Claude skills</h3>{intro}<p className="muted">Loading…</p></article>;
  if (status === "unavailable") return <article className="claude-skills-setting"><span>CLAUDE</span><h3>Claude skills</h3>{intro}<p className="calendar-error" role="alert">Could not read the skills status. Reopen Settings to try again.</p></article>;
  const { lastSeen } = status;
  const at = lastSeen ? new Date(lastSeen.at).toLocaleString(undefined, { timeZone: displayTimeZone, dateStyle: "medium", timeStyle: "short" }) : undefined;
  return <article className="claude-skills-setting"><span>CLAUDE</span><h3>Claude skills</h3>{intro}
    <p>This LifeOS expects skill pack {status.expected}{status.oldestAccepted < status.expected ? ` and still accepts pack ${status.oldestAccepted}` : ""}.</p>
    {!lastSeen ? <p className="muted" role="status">No draft from Claude yet.</p>
      : lastSeen.outdated ? <p className="calendar-error" role="alert">Your latest draft ({at}) came from skill pack {lastSeen.skillPack}. Reinstall your LifeOS skills below so they match this LifeOS.</p>
      : <p className="muted" role="status">Up to date: your latest draft ({at}) came from skill pack {lastSeen.skillPack}.</p>}
    <h4>Claude chat and phone</h4>
    <p className="muted">Download each skill, then in Claude open Settings → Capabilities, turn on code execution, and choose Upload skill under Skills. Upload one zip at a time. Skills sync to the Claude phone app.</p>
    {status.skills.length ? <ul className="settings-reference-list">{status.skills.map((skill) => <li key={skill.name}><a href={`/api/v1/settings/claude-skills/${encodeURIComponent(skill.name)}/zip`} download={`${skill.name}.zip`}>Download {skill.name}</a>{skill.version ? <span className="muted"> · version {skill.version}</span> : null}</li>)}</ul> : <p className="muted">This LifeOS ships no skills.</p>}
    <h4>Claude Code</h4>
    {status.plugin ? <>
      <p className="muted">Run these in Claude Code once. Then turn on auto-update for the marketplace under /plugin → Marketplaces, so new versions arrive on their own. The repository must be one your GitHub account can read.</p>
      <CopyCommand command={`/plugin marketplace add ${status.plugin.marketplace}`} />
      <CopyCommand command={`/plugin install ${status.plugin.install}`} />
    </> : <p className="muted">This LifeOS build names no plugin repository, so use the zips above.</p>}
  </article>;
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { setCopied(false); }
  };
  return <div className="claude-skills-command"><code>{command}</code><button type="button" onClick={() => void copy()} aria-label={`Copy ${command}`}>{copied ? "Copied" : "Copy"}</button></div>;
}

function ReferenceDataCard({ label, names }: { label: string; names: string[] }) {
  return <article><span>REFERENCE DATA</span><h3>{label[0]!.toUpperCase() + label.slice(1)}</h3>{names.length ? <ul className="settings-reference-list">{names.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}</ul> : <p className="muted">No {label} yet.</p>}</article>;
}

/** #47: the synced max must-dos setting: how many items Today's Top 3 shows. */
function MaxMustDosCard({ setting, disabled, onSave }: { setting?: { maxMustDos: number; contentHash?: string }; disabled: boolean; onSave: (maxMustDos: number) => Promise<string | undefined> }) {
  const [value, setValue] = useState(setting?.maxMustDos ?? 3);
  const [status, setStatus] = useState<SaveState>();
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (setting) setValue(setting.maxMustDos); }, [setting?.maxMustDos]);
  const dirty = Boolean(setting) && value !== setting!.maxMustDos;
  const save = async (): Promise<boolean> => {
    setSaving(true);
    const error = await onSave(value);
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. Today's Top 3 now shows at most this many must-dos." });
    return !error;
  };
  useSettingsCardGuard("settings-max-must-dos", { dirty, save, discard: () => { if (setting) setValue(setting.maxMustDos); setStatus(undefined); } });
  return <article className="internal-domains-setting"><span>TODAY</span><h3>Max must-dos</h3>
    <p className="muted">How many items Today's Top 3 shows, whether from the morning brief or the priority rule. Pinned tasks count towards it.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><select aria-label="Max must-dos" value={value} disabled={disabled} onChange={(event) => { setValue(Number(event.target.value)); setStatus(undefined); }}>{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}</select><button type="button" disabled={disabled || saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button></div>}
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
  const dirty = Boolean(setting) && (threshold !== String(setting!.meetingHoursThreshold) || time !== setting!.briefTime || zone !== setting!.briefTimeZone || days.join("|") !== setting!.briefDays.join("|"));
  const save = async (): Promise<boolean> => {
    if (!days.length || !threshold.trim() || !time) { setStatus({ kind: "error", text: "Complete the required Today settings before saving." }); return false; }
    setSaving(true);
    const error = await onSave({ meetingHoursThreshold: Number(threshold), briefTime: time, briefTimeZone: zone, briefDays: days });
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved." });
    return !error;
  };
  useSettingsCardGuard("settings-today", { dirty, save, discard: () => { if (setting) { setThreshold(String(setting.meetingHoursThreshold)); setTime(setting.briefTime); setZone(setting.briefTimeZone); setDays(setting.briefDays); } setStatus(undefined); } });
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setStatus(undefined); };
  return <article className="today-setting"><span>TODAY</span><h3>Meetings and morning brief</h3>
    {!setting ? <p className="muted">Loading…</p> : <>
      <label>Meeting-heavy day from (hours) <input type="number" min={0} max={24} step={0.5} value={threshold} disabled={disabled} onChange={(event) => edit(setThreshold)(event.target.value)} /></label>
      <p className="muted">Information only: Today notes a meeting-heavy day; nothing is blocked.</p>
      <label>Brief time <input type="time" value={time} disabled={disabled} onChange={(event) => edit(setTime)(event.target.value)} /></label>
      <label>Brief time zone <select value={zone} disabled={disabled} onChange={(event) => edit(setZone)(event.target.value)}>{[...new Set([zone, ...timeZones])].map((option) => <option key={option}>{option}</option>)}</select></label>
      <fieldset disabled={disabled}><legend>Brief days</legend>{weekdayNames.map(([day, name]) => <label key={day}><input type="checkbox" checked={days.includes(day)} onChange={(event) => edit(setDays)(event.target.checked ? [...days, day] : days.filter((value) => value !== day))} /> {name}</label>)}</fieldset>
      <button type="button" disabled={disabled || saving || !dirty || !days.length || !threshold.trim() || !time} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
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
  const save = async (): Promise<boolean> => {
    if (setting && setting.domains.length > 0 && !domains.length) { setStatus({ kind: "error", text: "Enter at least one domain." }); return false; }
    setSaving(true);
    const error = await onSave(domains);
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: "Saved. People labels now use these domains." });
    return !error;
  };
  useSettingsCardGuard(internalDomainsCardId, { dirty, save, discard: () => { setText(saved); setStatus(undefined); } });
  return <article className="internal-domains-setting"><span>PEOPLE</span><h3>Internal domains</h3>
    <p className="muted">Email domains of your own organisations, separated by commas. Anyone with addresses only on other domains is shown as "Name<span className="ext-suffix"> - ext</span>". You can override this on each person.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><input aria-label="Internal domains" value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setStatus(undefined); }} placeholder="example.com, example.org" /><button type="button" disabled={disabled || saving || !dirty || !domains.length} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button></div>}
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
  const save = async (): Promise<boolean> => {
    setSaving(true);
    const error = await onSave(emails);
    setSaving(false);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: emails.length ? "Saved. Attendees with these addresses are now you." : "Saved. No address is matched to you." });
    return !error;
  };
  useSettingsCardGuard(selfEmailsCardId, { dirty, save, discard: () => { setText(saved); setStatus(undefined); } });
  return <article className="internal-domains-setting"><span>PEOPLE</span><h3>My email addresses</h3>
    <p className="muted">Every address you use, separated by commas. Calendar attendees with one of these addresses are linked to you instead of creating a new person.</p>
    {!setting ? <p className="muted">Loading…</p> : <div className="capture-row"><input aria-label="My email addresses" value={text} disabled={disabled} onChange={(event) => { setText(event.target.value); setStatus(undefined); }} placeholder="me@example.com, me@example.org" /><button type="button" disabled={disabled || saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button></div>}
    {setting && !setting.emails.length && !status && <p className="muted" role="status">Not set yet: no attendee is recognised as you by email.</p>}
    <SaveStatus status={status} />
  </article>;
}

const ignoredAddressesCardId = "settings-ignored-addresses";
/** Ignored addresses: one entry per "Not a person" Person. Undo makes the Person live again, so invites use it again. */
function IgnoredAddressesCard({ entries, disabled, onUndo }: { entries?: IgnoredAddress[]; disabled: boolean; onUndo: (entry: IgnoredAddress) => Promise<string | undefined> }) {
  const [status, setStatus] = useState<SaveState>();
  const [working, setWorking] = useState<string>();
  const undo = async (entry: IgnoredAddress) => {
    setWorking(entry.personId);
    const error = await onUndo(entry);
    setWorking(undefined);
    setStatus(error ? { kind: "error", text: error } : { kind: "saved", text: `${entry.emails.join(", ")} is no longer ignored.` });
  };
  return <article className="internal-domains-setting"><span>PEOPLE</span><h3>Ignored addresses</h3>
    <p className="muted">Mailing lists and shared mailboxes you marked "Not a person". Calendar invites never turn these into people.</p>
    {!entries ? <p className="muted">Loading…</p> : !entries.length ? <p className="muted" role="status">None yet. Use "Not a person" on a person to add one.</p>
      : <ul className="ignored-addresses">{entries.map((entry) => <li key={entry.personId}><span>{entry.emails.join(", ")}</span>
        <button type="button" disabled={disabled || Boolean(working)} onClick={() => void undo(entry)}>{working === entry.personId ? "Undoing…" : "Undo"}</button></li>)}</ul>}
    <SaveStatus status={status} />
  </article>;
}

export function GoogleSecretCard({ provider, title, status, busy, onSave }: { provider: "calendar" | "drive"; title: string; status?: { configured: boolean; connected: boolean }; busy: boolean; onSave: (provider: "calendar" | "drive", clientId: string, clientSecret: string) => Promise<boolean> }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const save = async (): Promise<boolean> => {
    setSaved(false); setError("");
    if (!clientId.trim() || !clientSecret.trim()) { setError("Enter both the OAuth client ID and client secret before saving."); return false; }
    try {
      if (await onSave(provider, clientId, clientSecret)) {
        setClientId(""); setClientSecret(""); setSaved(true);
        return true;
      }
    } catch {
      // The card owns the draft, so connector failures must leave both credential fields intact.
    }
    setError("Could not save the credentials. Your input is still here.");
    return false;
  };
  useSettingsCardGuard(`settings-google-${provider}`, { dirty: Boolean(clientId || clientSecret), save, discard: () => { setClientId(""); setClientSecret(""); setSaved(false); setError(""); } });
  return <article className="secret-card"><span>{title.toUpperCase()}</span><h3>{status?.configured ? "Credentials configured" : "Credentials required"}</h3><p className="muted">{status?.connected ? "Connected" : provider === "calendar" ? "Configure here, then authorize from Calendar." : "Stored for the upcoming Drive source connector."}</p>{saved && <div className="inline-success">Saved securely in macOS Keychain.</div>}{error && <p className="calendar-error" role="alert">{error}</p>}<div className="knowledge-form"><input aria-label={`${title} OAuth client ID`} value={clientId} onChange={(event) => { setSaved(false); setError(""); setClientId(event.target.value); }} placeholder="OAuth client ID" autoComplete="off" /><input aria-label={`${title} OAuth client secret`} type="password" value={clientSecret} onChange={(event) => { setSaved(false); setError(""); setClientSecret(event.target.value); }} placeholder={status?.configured ? "Enter a new secret to replace it" : "OAuth client secret"} autoComplete="new-password" /><button className="primary" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => void save()}>{busy ? "Saving…" : status?.configured ? "Replace credentials" : "Save to Keychain"}</button></div></article>;
}
