import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";
import type { AdoptionModule, InboxStatus } from "./adoption.js";
import type { CalendarModule, CalendarOffline } from "./calendar.js";
import type { AppContext } from "./context.js";
import type { EnrichmentModule, EnrichmentStatus } from "./enrichment.js";
import type { EntitiesModule } from "./entities.js";
import type { MeetingsModule } from "./meetings.js";
import { openPointPeopleIds } from "./open-points.js";
import type { PeopleModule, PeopleSetupWarning } from "./people.js";
import { dueDate, isLive, isMeetingRestricted, liveMeetingNote } from "./support.js";
import { SyncedSetting } from "./synced-settings.js";

/**
 * Today's live panels (#48, PRD "Daily Focus and Today"). Every panel is computed on request from the
 * index, the calendar and `_inbox/`; nothing comes from the Daily Focus brief, so the panels never go
 * stale. Lists are returned whole: the interface shows the first rows and offers "show more".
 * Restricted objects stay listed with their lock badge, as everywhere else in the interface (ADR 0010).
 */

export const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = typeof weekdays[number];
export interface TodaySettings {
  /** A day with at least this many hours of meetings is flagged as meeting-heavy (information only). */
  meetingHoursThreshold: number;
  /** When the morning routine writes the brief: local `HH:MM` in `briefTimeZone`, on `briefDays`. */
  briefTime: string;
  briefTimeZone: string;
  briefDays: Weekday[];
  /** Hash of the stored file; absent until first saved. Send it back as the expected hash. */
  contentHash?: string;
}
export const defaultTodaySettings: TodaySettings = { meetingHoursThreshold: 5, briefTime: "06:00", briefTimeZone: "Europe/Paris", briefDays: ["mon", "tue", "wed", "thu", "fri"] };

export interface NextMeeting {
  title: string;
  startsAt: string;
  endsAt: string;
  /** Started and not yet ended at `now`. */
  inProgress: boolean;
  meetingId?: string;
  noteId?: string;
  calendarEventId?: string;
  calendarName?: string;
  restricted: boolean;
}
export type OpenPointLink = "raised-in" | "project" | "client" | "people";
export interface MeetingOpenPoint { openPoint: LifeOSObject; meetingId: string; meetingTitle: string; link: OpenPointLink }
/** `name` + `suffix` are the standard person label parts (#39), so the web styles the external marker (#64). */
export interface WaitingGroup { personId?: string; name: string; suffix?: string; label: string; isExternal: boolean; tasks: LifeOSObject[] }
export interface TodayPanels {
  date: string;
  timeZone: string;
  overdue: LifeOSObject[];
  dueToday: LifeOSObject[];
  upcomingHighPriority: LifeOSObject[];
  waitingByPerson: WaitingGroup[];
  nextMeetings: NextMeeting[];
  /** Hours of timed, accepted meetings within the local day, to one decimal. */
  meetingHours: number;
  meetingHeavy: boolean;
  /** #88: set when the calendar could not be read (meetings then come from the index only): why, the error message and when it last synced, for the offline banner. */
  calendarOffline?: CalendarOffline;
  openPointsForMeetings: MeetingOpenPoint[];
  reviewCount: number;
  inbox: Pick<InboxStatus, "awaiting" | "drafts" | "patches">;
  failedDrafts: InboxStatus["failed"];
  staleWorkOrders: EnrichmentStatus["staleWorkOrders"];
  settings: TodaySettings;
  /** #76: present while the user's own email addresses or the internal domains are unset. */
  setupWarning?: PeopleSetupWarning;
}

const timeOfDay = /^([01]\d|2[0-3]):[0-5]\d$/;
const importanceRank = (value: unknown) => value === "High" ? 0 : value === "Medium" ? 1 : value === "Low" ? 2 : 3;
const linkRank: Record<OpenPointLink, number> = { "raised-in": 0, project: 1, client: 2, people: 3 };

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

/** The UTC instant at which local midnight of `date` happens in `timeZone`, daylight saving included. */
export function zonedMidnight(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!);
  let guess = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value);
    guess += target - Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  }
  return guess;
}

function nextDate(date: string) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function settingsFrom(frontmatter?: ObjectEnvelope): TodaySettings {
  const threshold = Number(frontmatter?.meeting_hours_threshold);
  const days = Array.isArray(frontmatter?.brief_days) ? weekdays.filter((day) => (frontmatter!.brief_days as unknown[]).includes(day)) : [];
  return {
    meetingHoursThreshold: frontmatter?.meeting_hours_threshold !== undefined && Number.isFinite(threshold) && threshold >= 0 && threshold <= 24 ? threshold : defaultTodaySettings.meetingHoursThreshold,
    briefTime: typeof frontmatter?.brief_time === "string" && timeOfDay.test(frontmatter.brief_time) ? frontmatter.brief_time : defaultTodaySettings.briefTime,
    briefTimeZone: isTimeZone(frontmatter?.brief_time_zone) ? frontmatter!.brief_time_zone as string : defaultTodaySettings.briefTimeZone,
    briefDays: days.length ? days : [...defaultTodaySettings.briefDays]
  };
}

export class TodayModule {
  constructor(
    private readonly ctx: AppContext,
    private readonly entities: EntitiesModule,
    private readonly adoption: AdoptionModule,
    private readonly enrichment: EnrichmentModule,
    private readonly meetings: MeetingsModule,
    private readonly calendarModule: CalendarModule,
    private readonly people: PeopleModule
  ) {
    this.setting = new SyncedSetting(ctx, {
      key: "today", title: "Today",
      body: "# Today\n\nMeeting-hours threshold for flagging a meeting-heavy day (information only), and when the morning routine writes the Daily Focus brief.\n",
      name: "Today settings"
    });
  }

  private readonly setting: SyncedSetting;

  /** `date` is the user's local date; `timeZone` sets that day's boundaries for meetings (default: the brief's zone). */
  async panels(options: { date?: string; now?: Date; timeZone?: string } = {}): Promise<TodayPanels> {
    const now = options.now ?? new Date();
    const settings = await this.settings();
    const timeZone = isTimeZone(options.timeZone) ? options.timeZone : settings.briefTimeZone;
    const date = options.date ?? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const dayStart = zonedMidnight(date, timeZone);
    const dayEnd = zonedMidnight(nextDate(date), timeZone);
    const tasks = this.entities.today(date);

    const upcomingHighPriority = tasks.tasks
      .filter((task) => task.frontmatter.priority === "High" && !(dueDate(task) && dueDate(task)! <= date))
      .sort((a, b) => String(dueDate(a) ?? "9999").localeCompare(String(dueDate(b) ?? "9999")));

    const labels = new Map(this.people.labels().map((label) => [label.id, label]));
    const groups = new Map<string, WaitingGroup>();
    for (const task of tasks.waiting) {
      const personId = typeof task.frontmatter.waiting_for_person_id === "string" ? task.frontmatter.waiting_for_person_id : undefined;
      const label = personId ? labels.get(personId) : undefined;
      const key = label ? label.id : "";
      const group = groups.get(key) ?? { ...(label ? { personId: label.id } : {}), name: label?.name ?? "No person recorded", ...(label?.suffix ? { suffix: label.suffix } : {}), label: label?.label ?? "No person recorded", isExternal: label?.isExternal ?? false, tasks: [] };
      group.tasks.push(task);
      groups.set(key, group);
    }
    // Most-waited-on people first; the unknown-person group always last.
    const waitingByPerson = [...groups.values()].sort((a, b) => Number(!a.personId) - Number(!b.personId) || b.tasks.length - a.tasks.length || a.label.localeCompare(b.label));

    const { meetings, calendarOffline } = await this.dayMeetings(dayStart, dayEnd);
    const meetingHours = Math.round(meetings.reduce((sum, meeting) => sum + Math.max(0, Math.min(Date.parse(meeting.endsAt), dayEnd) - Math.max(Date.parse(meeting.startsAt), dayStart)), 0) / 360_000) / 10;
    const nextMeetings = meetings.filter((meeting) => Date.parse(meeting.endsAt) > now.getTime()).map((meeting) => ({ ...meeting, inProgress: Date.parse(meeting.startsAt) <= now.getTime() }));

    const [inbox, enrichment] = await Promise.all([this.adoption.inboxStatus(), this.enrichment.status({ now })]);
    const setupWarning = this.people.setupWarning();
    return {
      date, timeZone,
      overdue: tasks.overdue, dueToday: tasks.dueToday, upcomingHighPriority, waitingByPerson,
      nextMeetings, meetingHours, meetingHeavy: meetingHours >= settings.meetingHoursThreshold, ...(calendarOffline ? { calendarOffline } : {}),
      openPointsForMeetings: this.openPointsFor(meetings),
      reviewCount: tasks.reviewCount,
      inbox: { awaiting: inbox.awaiting, drafts: inbox.drafts, patches: inbox.patches },
      failedDrafts: inbox.failed,
      staleWorkOrders: enrichment.staleWorkOrders,
      settings,
      ...(setupWarning ? { setupWarning } : {})
    };
  }

  /** Read from disk so another device's edit is seen at once (as for the other synced settings, ADR 0005). */
  async settings(): Promise<TodaySettings> {
    const current = await this.setting.read();
    return { ...settingsFrom(current?.frontmatter), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  async saveSettings(input: Partial<Omit<TodaySettings, "contentHash">>, expectedHash?: string): Promise<TodaySettings> {
    const written = await this.setting.save((current) => this.settingFields(current, input), expectedHash);
    return { ...settingsFrom(written.frontmatter), contentHash: written.contentHash };
  }

  /** Validates the merged settings (all problems at once) and maps them to front matter. */
  private settingFields(current: ObjectEnvelope | undefined, input: Partial<Omit<TodaySettings, "contentHash">>) {
    const merged = { ...settingsFrom(current), ...input };
    const problems: string[] = [];
    if (typeof merged.meetingHoursThreshold !== "number" || !Number.isFinite(merged.meetingHoursThreshold) || merged.meetingHoursThreshold < 0 || merged.meetingHoursThreshold > 24) problems.push("Meeting-hours threshold must be a number of hours from 0 to 24");
    if (typeof merged.briefTime !== "string" || !timeOfDay.test(merged.briefTime)) problems.push("Brief time must be HH:MM (24-hour)");
    if (!isTimeZone(merged.briefTimeZone)) problems.push("Brief time zone must be an IANA time zone such as Europe/Paris");
    const days = Array.isArray(merged.briefDays) ? merged.briefDays : [];
    if (!days.length || days.some((day) => !weekdays.includes(day))) problems.push(`Brief days must be one or more of ${weekdays.join(", ")}`);
    if (problems.length) throw new Error(problems.join("; "));
    return {
      meeting_hours_threshold: merged.meetingHoursThreshold,
      brief_time: merged.briefTime,
      brief_time_zone: merged.briefTimeZone,
      brief_days: weekdays.filter((day) => days.includes(day))
    };
  }

  /**
   * The local day's timed meetings, sorted by start. Calendar events come first (declined, all-day and
   * hidden-calendar events left out); meeting objects add those with no calendar link. Without a
   * calendar, or when it cannot be read, the index's meetings stand in.
   */
  private async dayMeetings(dayStart: number, dayEnd: number) {
    const { ctx } = this;
    const result: Array<Omit<NextMeeting, "inProgress">> = [];
    let calendarOffline: CalendarOffline | undefined;
    let fromCalendar = false;
    if (ctx.calendar) {
      try {
        const { disabledCalendarIds } = await this.calendarModule.getCalendarPreferences();
        const events = this.meetings.withNoteLinks(await ctx.calendar.listEvents(new Date(dayStart), new Date(dayEnd)));
        fromCalendar = true;
        for (const event of events) {
          if (event.isAllDay || event.declined || (event.calendarId && disabledCalendarIds.includes(event.calendarId))) continue;
          if (Date.parse(event.endsAt) <= dayStart || Date.parse(event.startsAt) >= dayEnd) continue;
          const meeting = event.meetingId ? ctx.index.get(event.meetingId) : undefined;
          result.push({ title: event.title, startsAt: event.startsAt, endsAt: event.endsAt, calendarEventId: event.externalId, ...(event.calendarName ? { calendarName: event.calendarName } : {}), ...(event.meetingId ? { meetingId: event.meetingId } : {}), ...(event.noteId ? { noteId: event.noteId } : {}), restricted: isMeetingRestricted(meeting, ctx.index.all()) });
        }
      } catch (error) {
        calendarOffline = this.calendarModule.offline(error);
      }
    }
    const listed = new Set(result.map((meeting) => meeting.meetingId).filter(Boolean));
    for (const meeting of ctx.index.all()) {
      if (meeting.frontmatter.type !== "meeting" || !isLive(meeting) || listed.has(meeting.frontmatter.id)) continue;
      if (fromCalendar && Array.isArray(meeting.frontmatter.external_refs) && meeting.frontmatter.external_refs.length) continue;
      const startsAt = String(meeting.frontmatter.starts_at), endsAt = String(meeting.frontmatter.ends_at);
      if (!(Date.parse(endsAt) > dayStart && Date.parse(startsAt) < dayEnd)) continue;
      const note = liveMeetingNote(meeting.frontmatter.id, ctx.index.all());
      result.push({ title: meeting.frontmatter.title, startsAt, endsAt, meetingId: meeting.frontmatter.id, ...(note ? { noteId: note.frontmatter.id } : {}), restricted: isMeetingRestricted(meeting, ctx.index.all()) });
    }
    return { meetings: result.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)), calendarOffline };
  }

  /**
   * Open points to bring to today's meetings: raised in the meeting itself, or sharing its project,
   * client or (non-self) attendees, which is how a recurring meeting finds last week's open points.
   * Each open point appears once, under its strongest link.
   */
  private openPointsFor(meetings: Array<{ meetingId?: string }>) {
    const { ctx } = this;
    const objects = meetings.map((meeting) => meeting.meetingId ? ctx.index.get(meeting.meetingId) : undefined).filter((meeting): meeting is LifeOSObject => Boolean(meeting));
    if (!objects.length) return [];
    const selfIds = new Set(ctx.index.all().filter((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true).map((person) => person.frontmatter.id));
    const rows: MeetingOpenPoint[] = [];
    for (const point of ctx.index.all()) {
      if (point.frontmatter.type !== "open-point" || point.frontmatter.status !== "open" || !isLive(point)) continue;
      const people = new Set(openPointPeopleIds(ctx, point).filter((id) => !selfIds.has(id)));
      let best: MeetingOpenPoint | undefined;
      for (const meeting of objects) {
        const value = meeting.frontmatter;
        const attendees = Array.isArray(value.attendee_ids) ? value.attendee_ids : [];
        const link: OpenPointLink | undefined = point.frontmatter.source_meeting_id === value.id ? "raised-in"
          : value.primary_project_id && point.frontmatter.primary_project_id === value.primary_project_id ? "project"
          : value.primary_client_id && point.frontmatter.primary_client_id === value.primary_client_id ? "client"
          : attendees.some((id) => typeof id === "string" && people.has(id)) ? "people" : undefined;
        if (link && (!best || linkRank[link] < linkRank[best.link])) best = { openPoint: point, meetingId: value.id, meetingTitle: value.title, link };
      }
      if (best) rows.push(best);
    }
    return rows.sort((a, b) => linkRank[a.link] - linkRank[b.link] || importanceRank(a.openPoint.frontmatter.importance) - importanceRank(b.openPoint.frontmatter.importance) || String(b.openPoint.frontmatter.raised_at ?? b.openPoint.frontmatter.created_at).localeCompare(String(a.openPoint.frontmatter.raised_at ?? a.openPoint.frontmatter.created_at)));
  }
}
