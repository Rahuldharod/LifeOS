import { uuidV7, type ObjectEnvelope } from "@lifeos/domain";
import { markdownFileName, ObjectConflictError as SettingsConflictError, type AppContext } from "./context.js";
import type { MeetingsModule } from "./meetings.js";
import type { CalendarPreferences } from "./ports.js";

/** An identical failed sync within this window does not write another Sync Run file (PB-022a). */
const FAILED_SYNC_RUN_THROTTLE_MS = 60 * 60 * 1000;


const calendarPreferencesPath = "settings/calendar-preferences.md";

function preferencesFrom(frontmatter: ObjectEnvelope): Omit<CalendarPreferences, "contentHash"> {
  const disabled = frontmatter.disabled_calendar_ids;
  const defaultId = frontmatter.default_calendar_id;
  return {
    disabledCalendarIds: Array.isArray(disabled) ? disabled.filter((id): id is string => typeof id === "string") : [],
    ...(typeof defaultId === "string" && defaultId ? { defaultCalendarId: defaultId } : {})
  };
}

/** Calendar connector access, synced calendar preferences, sync runs and the Google connection record. */
export class CalendarModule {
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule) {}

  async listCalendarEvents(from = new Date(), to = new Date(Date.now() + 7 * 86_400_000)) {
    if (!this.ctx.calendar) throw new Error("Calendar connector is not configured");
    return this.meetings.withNoteLinks(await this.ctx.calendar.listEvents(from, to));
  }

  async listCalendars() {
    if (!this.ctx.calendar) throw new Error("Calendar connector is not configured");
    return this.ctx.calendar.listCalendars ? this.ctx.calendar.listCalendars() : [];
  }

  /** Synced calendar preferences (ADR 0005). One fixed file, read from disk so another device's edit is seen at once. */
  async getCalendarPreferences(): Promise<CalendarPreferences> {
    const current = await this.readSetting(calendarPreferencesPath);
    return current ? { ...preferencesFrom(current.frontmatter), contentHash: current.contentHash } : { disabledCalendarIds: [] };
  }

  async saveCalendarPreferences(input: { disabledCalendarIds: string[]; defaultCalendarId?: string }, expectedHash?: string): Promise<CalendarPreferences> {
    const { ctx } = this;
    const disabled = [...new Set(input.disabledCalendarIds.filter((id) => typeof id === "string" && id))];
    const defaultId = input.defaultCalendarId || undefined;
    const current = await this.readSetting(calendarPreferencesPath);
    const now = new Date().toISOString();
    if (current && current.contentHash !== expectedHash) throw new SettingsConflictError("Calendar preferences changed on another device; reload and try again");
    if (!current && expectedHash) throw new SettingsConflictError("Calendar preferences were removed; reload and try again");
    const kept: Record<string, unknown> = { ...current?.frontmatter };
    delete kept.default_calendar_id;
    const id = current?.frontmatter.id ?? uuidV7();
    const written = await ctx.objects.write({
      relativePath: calendarPreferencesPath,
      expectedHash: current?.contentHash,
      frontmatter: {
        ...kept,
        ...(current ? { revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: ctx.deviceId } : ctx.envelope(id, "app-setting", "Calendar preferences", now)),
        setting_key: "calendar-preferences",
        disabled_calendar_ids: disabled,
        ...(defaultId ? { default_calendar_id: defaultId } : {})
      } as ObjectEnvelope,
      body: "# Calendar preferences\n\nWhich calendars the Calendar view offers, and which one opens by default.\n"
    });
    await ctx.rebuildIndex();
    return { ...preferencesFrom(written.frontmatter), contentHash: written.contentHash };
  }

  async syncCalendar(from = new Date(), to = new Date(Date.now() + 7 * 86_400_000)) {
    const calendar = this.ctx.calendar;
    if (!calendar) throw new Error("Calendar connector is not configured");
    const started = new Date().toISOString();
    try {
      const events = await calendar.listEvents(from, to);
      if (calendar.provider === "google") await this.writeSyncRun("succeeded", started, events.length);
      return this.meetings.withNoteLinks(events);
    } catch (error) {
      // Recording the failure must never mask the connector error the user needs to see.
      if (calendar.provider === "google") await this.writeSyncRun("failed", started, 0, error instanceof Error ? error.message : "Unknown error").catch(() => undefined);
      throw error;
    }
  }

  /** Last Google Calendar sync outcomes, derived from Sync Run files, for the reconnect banner (PB-022a). */
  calendarSyncStatus() {
    const runs = this.googleSyncRuns();
    const lastSuccess = runs.find((run) => run.frontmatter.status === "succeeded");
    const last = runs[0];
    return {
      lastSuccessfulSyncAt: lastSuccess ? String(lastSuccess.frontmatter.completed_at) : undefined,
      lastError: last?.frontmatter.status === "failed" ? String(last.frontmatter.error ?? "Unknown error") : undefined
    };
  }

  async recordGoogleConnection() {
    const { ctx } = this;
    const existing = ctx.index.all().find((object) => object.frontmatter.type === "connector-account" && object.frontmatter.provider === "google");
    if (existing) return existing;
    const now = new Date().toISOString();
    const id = uuidV7();
    const account = await ctx.objects.write({ relativePath: `connectors/${markdownFileName("Google Calendar", id, now)}`, frontmatter: { ...ctx.envelope(id, "connector-account", "Google Calendar", now), provider: "google", account_label: "Primary calendar", external_account_id: "primary", status: "active", secret_ref: "google:default:tokens", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }, body: "# Google Calendar\n\nRead-only calendar connection. Credentials are stored in macOS Keychain.\n" });
    await ctx.rebuildIndex();
    return account;
  }

  private async readSetting(relativePath: string) {
    try { return await this.ctx.objects.read(relativePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private async writeSyncRun(status: "succeeded" | "failed", startedAt: string, recordCount: number, error?: string) {
    const { ctx } = this;
    const account = ctx.index.all().find((object) => object.frontmatter.type === "connector-account" && object.frontmatter.provider === "google");
    if (!account) return;
    const completedAt = new Date().toISOString();
    // Throttle: repeating the same failure within the window adds no information, only another file.
    const previous = this.googleSyncRuns()[0];
    if (status === "failed" && previous?.frontmatter.status === "failed" && previous.frontmatter.error === error &&
      Date.parse(completedAt) - Date.parse(String(previous.frontmatter.completed_at)) < FAILED_SYNC_RUN_THROTTLE_MS) return;
    const id = uuidV7();
    await ctx.objects.write({ relativePath: `sync-runs/${markdownFileName("Google Calendar sync", id, completedAt)}`, frontmatter: { ...ctx.envelope(id, "sync-run", "Google Calendar sync", completedAt), connector_account_id: account.frontmatter.id, resource_type: "calendar-events", status, started_at: startedAt, completed_at: completedAt, record_count: recordCount, error }, body: `# Google Calendar sync\n\n${status}: ${recordCount} events.\n` });
    await ctx.rebuildIndex();
  }

  /** Google Calendar Sync Runs, newest first. */
  private googleSyncRuns() {
    return this.ctx.index.all()
      .filter((object) => object.frontmatter.type === "sync-run" && object.frontmatter.resource_type === "calendar-events")
      .sort((left, right) => Date.parse(String(right.frontmatter.completed_at)) - Date.parse(String(left.frontmatter.completed_at)));
  }
}
