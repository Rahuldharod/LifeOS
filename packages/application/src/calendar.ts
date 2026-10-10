import { uuidV7, type ObjectEnvelope } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import type { MeetingsModule } from "./meetings.js";
import type { CalendarEvent, CalendarPreferences } from "./ports.js";
import { isLive, liveMeetingNote } from "./support.js";
import { SyncedSetting } from "./synced-settings.js";

/** An identical failed sync within this window does not write another Sync Run file (PB-022a). */
const FAILED_SYNC_RUN_THROTTLE_MS = 60 * 60 * 1000;


/**
 * #88 (PB-022b): why the calendar could not be read. Matched by error name, so the application needs no adapter
 * classes: `GoogleAuthError` (expired or revoked token), `KeychainAccessDeniedError` (#77), anything else = network.
 */
export type CalendarOfflineReason = "network" | "auth" | "keychain-denied";
export interface CalendarOffline { reason: CalendarOfflineReason; error: string; lastSuccessfulSyncAt?: string }
/** A calendar range: live events, or the meetings already stored in LifeOS while `offline` is set. */
export interface CalendarDay { events: Array<CalendarEvent & { stored?: true }>; offline?: CalendarOffline }

export function calendarOfflineReason(error: unknown): CalendarOfflineReason {
  const name = error instanceof Error ? error.name : "";
  return name === "GoogleAuthError" ? "auth" : name === "KeychainAccessDeniedError" ? "keychain-denied" : "network";
}

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
  private readonly preferences: SyncedSetting;

  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule) {
    this.preferences = new SyncedSetting(ctx, {
      key: "calendar-preferences", title: "Calendar preferences",
      body: "# Calendar preferences\n\nWhich calendars the Calendar view offers, and which one opens by default.\n",
      changedMessage: "Calendar preferences changed on another device; reload and try again",
      removedMessage: "Calendar preferences were removed; reload and try again"
    });
  }

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
    const current = await this.preferences.read();
    return current ? { ...preferencesFrom(current.frontmatter), contentHash: current.contentHash } : { disabledCalendarIds: [] };
  }

  async saveCalendarPreferences(input: { disabledCalendarIds: string[]; defaultCalendarId?: string }, expectedHash?: string): Promise<CalendarPreferences> {
    const disabled = [...new Set(input.disabledCalendarIds.filter((id) => typeof id === "string" && id))];
    const defaultId = input.defaultCalendarId || undefined;
    const written = await this.preferences.save(() => ({ disabled_calendar_ids: disabled, default_calendar_id: defaultId }), expectedHash);
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

  /**
   * #88: the range from the calendar (`sync` records a Sync Run, as `syncCalendar`), or, when the calendar cannot be
   * read, the meetings already stored in LifeOS for the range with the reason and the last successful sync time.
   * The fallback only reads: no stored meeting is changed or deleted while offline.
   */
  async calendarDay(from = new Date(), to = new Date(Date.now() + 7 * 86_400_000), options: { sync?: boolean } = {}): Promise<CalendarDay> {
    try {
      return { events: options.sync ? await this.syncCalendar(from, to) : await this.listCalendarEvents(from, to) };
    } catch (error) {
      return { events: this.storedMeetings(from, to), offline: this.offline(error) };
    }
  }

  /** The offline state for a failed calendar read: reason, message and last successful sync. */
  offline(error: unknown): CalendarOffline {
    return { reason: calendarOfflineReason(error), error: error instanceof Error ? error.message : String(error), lastSuccessfulSyncAt: this.calendarSyncStatus().lastSuccessfulSyncAt };
  }

  /** Live meetings in the index overlapping the range, shaped as calendar events, sorted by start. Read-only. */
  storedMeetings(from: Date, to: Date): Array<CalendarEvent & { stored: true }> {
    const { index } = this.ctx;
    const objects = index.all();
    return objects
      .filter((meeting) => meeting.frontmatter.type === "meeting" && isLive(meeting) &&
        Date.parse(String(meeting.frontmatter.ends_at)) > from.getTime() && Date.parse(String(meeting.frontmatter.starts_at)) < to.getTime())
      .map((meeting) => {
        const refs = Array.isArray(meeting.frontmatter.external_refs) ? meeting.frontmatter.external_refs as Array<{ external_id?: unknown; calendar_id?: unknown }> : [];
        const ref = refs.find((candidate) => typeof candidate === "object" && candidate !== null && typeof candidate.external_id === "string");
        const note = liveMeetingNote(meeting.frontmatter.id, objects);
        const attendees = Array.isArray(meeting.frontmatter.attendee_ids) ? meeting.frontmatter.attendee_ids.map((id) => index.get(String(id))?.frontmatter.title).filter((title): title is string => Boolean(title)) : [];
        return {
          externalId: ref ? String(ref.external_id) : meeting.frontmatter.id,
          ...(ref && typeof ref.calendar_id === "string" ? { calendarId: ref.calendar_id } : {}),
          title: meeting.frontmatter.title,
          startsAt: String(meeting.frontmatter.starts_at),
          endsAt: String(meeting.frontmatter.ends_at),
          timezone: typeof meeting.frontmatter.timezone === "string" ? meeting.frontmatter.timezone : "UTC",
          isAllDay: meeting.frontmatter.is_all_day === true,
          attendees,
          hasNote: Boolean(note),
          meetingId: meeting.frontmatter.id,
          ...(note ? { noteId: note.frontmatter.id } : {}),
          stored: true as const
        };
      })
      .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
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
