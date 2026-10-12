import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import type { CalendarModule } from "./calendar.js";
import { markdownFileName, type AppContext } from "./context.js";
import { isLegacySharedNote, recurrenceOccurrenceId, type MeetingsModule } from "./meetings.js";
import type { CalendarEvent, InboxStore } from "./ports.js";
import { personEmails } from "./people.js";
import { isLive, isRestricted, liveMeetingNote } from "./support.js";

/**
 * Enrichment Work Orders (PRD "Enrichment Work Orders", ADR 0008): "Enrich last 48h" lists every ended
 * meeting worth enriching in one file in `_inbox/requests/` for Claude to act on, and tracks each
 * meeting's `enrichment_state`: `none → requested → enriched | partial | gave_up`.
 * Restricted objects (ADR 0010) never appear in a Work Order.
 */

export const workOrderContractVersion = 1;
export const enrichmentStates = ["none", "requested", "enriched", "partial", "gave_up"] as const;
export type EnrichmentState = typeof enrichmentStates[number];
/** Material the Agent looks for after each meeting; whatever no Source covers yet is listed as missing. */
export const expectedMaterial = ["meet-transcript", "meet-recording", "gong-call", "gong-summary-email"] as const;

export const enrichmentWindowMs = 48 * 3_600_000;
/** A requested meeting with no material this long after the request is proposed as "gave up". */
export const gaveUpProposalMs = 48 * 3_600_000;
/** A Work Order still in `_inbox/requests/` this long after it was written is flagged stale. */
export const staleWorkOrderMs = 7 * 86_400_000;

export interface EnrichmentEntry {
  meetingId?: string;
  calendarEventId: string;
  title: string;
  startsAt: string;
  missingMaterial: string[];
}
export interface EnrichmentRequest {
  /** Data-root relative path of the Work Order; absent when no meeting qualified and nothing was written. */
  workOrder?: string;
  meetings: EnrichmentEntry[];
  /** Restricted meetings left out (counted only, never named). */
  restrictedExcluded: number;
  message: string;
}
export interface EnrichmentStatus {
  proposedGaveUp: Array<{ meetingId: string; title: string; requestedAt: string }>;
  staleWorkOrders: Array<{ path: string; requestedAt: string; ageDays: number }>;
}

export function enrichmentStateOf(meeting: LifeOSObject): EnrichmentState {
  const state = meeting.frontmatter.enrichment_state;
  return enrichmentStates.includes(state as EnrichmentState) ? state as EnrichmentState : "none";
}

/**
 * Attendee emails from whatever the calendar event provides. Today's connector gives display names,
 * or the email when Google has no name, so only email-looking strings are kept. Objects with an
 * `email` field (the richer attendee shape #38 introduces) are read too.
 */
/** Expected material recorded on a meeting as checked and not existing. */
export function unavailableOf(meeting: LifeOSObject) {
  const value = meeting.frontmatter.enrichment_unavailable_material;
  return Array.isArray(value) ? value.filter((kind): kind is string => (expectedMaterial as readonly string[]).includes(String(kind))) : [];
}

export function attendeeEmails(attendees: unknown): string[] {
  const emails = (Array.isArray(attendees) ? attendees : []).map((attendee) => typeof attendee === "string" ? attendee : typeof attendee === "object" && attendee !== null ? (attendee as { email?: unknown }).email : undefined)
    .filter((value): value is string => typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value.trim()))
    .map((value) => value.trim());
  const seen = new Set<string>();
  return emails.filter((email) => !seen.has(email.toLowerCase()) && Boolean(seen.add(email.toLowerCase())));
}


export class EnrichmentModule {
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule, private readonly calendarModule: CalendarModule, private readonly inbox?: InboxStore) {}

  /**
   * "Enrich last 48h". Reads the calendar first, so an unreachable calendar fails before anything is
   * written. Then writes the Work Order, and only after that marks meetings `requested`: a failure
   * part-way leaves at worst an extra request, never a meeting waiting on a Work Order that does not exist.
   * Events with no meeting object yet are listed too; their meeting is created when material is adopted.
   */
  async requestEnrichment(options: { now?: Date } = {}): Promise<EnrichmentRequest> {
    const { ctx } = this;
    if (!ctx.calendar) throw new Error("Calendar connector is not configured");
    if (!this.inbox) throw new Error("The inbox folder is not configured, so no Work Order can be written");
    const now = options.now ?? new Date();
    const windowStart = new Date(now.getTime() - enrichmentWindowMs);
    let events: CalendarEvent[];
    try { events = await ctx.calendar.listEvents(windowStart, now); }
    catch (error) {
      // An expired Google login keeps its name so the server answers 401 and the UI offers Reconnect.
      if (error instanceof Error && error.name === "GoogleAuthError") throw error;
      throw new Error(`Could not read the calendar (${error instanceof Error ? error.message : String(error)}); no Work Order was written`);
    }
    await ctx.rebuildIndex();
    const { disabledCalendarIds } = await this.calendarModule.getCalendarPreferences();

    const ended = events.filter((event) => {
      const startsAt = Date.parse(event.startsAt);
      return startsAt >= windowStart.getTime() && Date.parse(event.endsAt) <= now.getTime() && !event.isAllDay &&
        !event.declined && !(event.calendarId && disabledCalendarIds.includes(event.calendarId));
    }).sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));

    // Emails of restricted People never appear in a Work Order (ADR 0010, #63).
    const objects = ctx.index.all();
    const hiddenEmails = new Set(objects.filter((object) => object.frontmatter.type === "person" && isRestricted(object)).flatMap((person) => personEmails(person)));
    let restrictedExcluded = 0;
    const selected: Array<{ event: CalendarEvent; meeting?: LifeOSObject; entry: Record<string, unknown>; summary: EnrichmentEntry }> = [];
    for (const event of this.meetings.withNoteLinks(ended)) {
      const meeting = event.meetingId ? ctx.index.get(event.meetingId) : undefined;
      if (this.meetings.isEventRestricted(event)) { restrictedExcluded += 1; continue; }
      if (meeting && ["enriched", "gave_up"].includes(enrichmentStateOf(meeting))) continue;
      const note = event.noteId ? ctx.index.get(event.noteId) : undefined;
      // ADR 0021 (#176): a Legacy shared Note receives no further enrichment, so its Meetings get no new Work Order entry.
      if (note && isLegacySharedNote(note)) continue;
      // A restricted Source still covers its material (so it is not fetched again); it is just never named.
      const allSources = meeting ? this.sourcesFor(meeting, note) : [];
      const sources = allSources.filter((source) => !isRestricted(source));
      const have = new Set(allSources.map((source) => String(source.frontmatter.source_type)));
      const absent = meeting ? unavailableOf(meeting) : [];
      const missingMaterial = expectedMaterial.filter((kind) => !have.has(kind) && !absent.includes(kind));
      const entry: Record<string, unknown> = {
        ...(meeting ? { meeting_id: meeting.frontmatter.id } : {}),
        calendar_event_id: event.externalId,
        ...(event.calendarId ? { calendar_id: event.calendarId } : {}),
        title: event.title, starts_at: event.startsAt, ends_at: event.endsAt, timezone: event.timezone,
        attendee_emails: attendeeEmails([...(event.attendeeDetails ?? []), ...event.attendees]).filter((email) => !hiddenEmails.has(email.toLowerCase())),
        ...(event.seriesId && event.originalOccurrenceStartsAt ? {
          recurrence_occurrence_id: recurrenceOccurrenceId(ctx.calendar.provider ?? "calendar", event),
          optional_material: ["drive-doc"]
        } : {}),
        ...(note ? { note_path: note.relativePath } : {}),
        existing_sources: sources.map((source) => ({
          id: source.frontmatter.id, source_type: String(source.frontmatter.source_type), path: source.relativePath,
          ...(typeof source.frontmatter.url === "string" ? { url: source.frontmatter.url } : {}),
          ...(typeof source.frontmatter.external_id === "string" ? { external_id: source.frontmatter.external_id } : {})
        })),
        missing_material: missingMaterial
      };
      selected.push({ event, meeting, entry, summary: { ...(meeting ? { meetingId: meeting.frontmatter.id } : {}), calendarEventId: event.externalId, title: event.title, startsAt: event.startsAt, missingMaterial } });
    }
    if (!selected.length) return { meetings: [], restrictedExcluded, message: "No ended meetings from the last 48 hours need enrichment; no Work Order was written" };

    const id = uuidV7();
    const timestamp = now.toISOString();
    const file = await this.inbox.writeDocument("requests", markdownFileName("Enrich last 48h", id, timestamp), {
      lifeos_work_order: workOrderContractVersion, kind: "enrichment", work_order_id: id, requested_at: timestamp,
      window_start: windowStart.toISOString(), window_end: timestamp, meetings: selected.map(({ entry }) => entry)
    }, workOrderBody(selected.length));

    for (const { meeting } of selected) {
      if (!meeting) continue;
      const current = ctx.required(meeting.frontmatter.id, "meeting");
      await ctx.update(current, { enrichment_state: "requested", enrichment_requested_at: timestamp, enrichment_work_order: file.relativePath }, { expectedHash: current.contentHash, now: timestamp });
      await ctx.writeAudit("meeting.enrichment-requested", current.frontmatter.id, timestamp, { from: enrichmentStateOf(current), work_order: file.relativePath });
    }
    await ctx.rebuildIndex();
    return { workOrder: file.relativePath, meetings: selected.map(({ summary }) => summary), restrictedExcluded, message: `Work Order written for ${selected.length} ${selected.length === 1 ? "meeting" : "meetings"}: ask Claude to "run LifeOS enrichment"` };
  }

  /** The user stops waiting for material. Repeating it writes nothing; an enriched meeting cannot give up. */
  async markGaveUp(meetingId: string, expectedHash: string) {
    const meeting = this.ctx.required(meetingId, "meeting");
    const state = enrichmentStateOf(meeting);
    if (state === "gave_up") return meeting;
    if (state === "enriched") throw new Error("This meeting is already enriched");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(meeting, { enrichment_state: "gave_up", enrichment_gave_up_at: now }, { expectedHash, now });
    await this.ctx.writeAudit("meeting.enrichment-gave-up", meetingId, now, { from: state });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /** What Today and System flag: meetings to propose "gave up" for, and Work Orders nobody processed. */
  async status(options: { now?: Date } = {}): Promise<EnrichmentStatus> {
    const now = (options.now ?? new Date()).getTime();
    const proposedGaveUp = this.ctx.index.all()
      .filter((object) => object.frontmatter.type === "meeting" && isLive(object) && enrichmentStateOf(object) === "requested")
      .filter((meeting) => {
        const requestedAt = Date.parse(String(meeting.frontmatter.enrichment_requested_at));
        return !Number.isNaN(requestedAt) && now - requestedAt >= gaveUpProposalMs && !this.sourcesFor(meeting, this.noteFor(meeting)).length;
      })
      .map((meeting) => ({ meetingId: meeting.frontmatter.id, title: meeting.frontmatter.title, requestedAt: String(meeting.frontmatter.enrichment_requested_at) }));
    const staleWorkOrders: EnrichmentStatus["staleWorkOrders"] = [];
    // Any file still in `_inbox/requests/` is unprocessed: the Agent files it in `_inbox/processed/` when done.
    for (const file of this.inbox ? await this.inbox.list("requests") : []) {
      const document = await this.inbox!.read("requests", file.name).catch(() => undefined);
      const written = Date.parse(String(document?.frontmatter?.requested_at));
      const requestedAt = Number.isNaN(written) ? file.modifiedAt : written;
      if (now - requestedAt >= staleWorkOrderMs) staleWorkOrders.push({ path: file.relativePath, requestedAt: new Date(requestedAt).toISOString(), ageDays: Math.floor((now - requestedAt) / 86_400_000) });
    }
    return { proposedGaveUp, staleWorkOrders };
  }

  /** System Health lines for stale Work Orders. */
  async diagnostics() {
    return (await this.status()).staleWorkOrders.map((order) => `${order.path}: Work Order not processed for ${order.ageDays} days`);
  }

  /** Live Sources for a meeting: those pointing at it by `meeting_id`, or listed in the meeting's or note's `source_ids`. */
  private sourcesFor(meeting: LifeOSObject, note?: LifeOSObject) {
    const listed = new Set([meeting, note].flatMap((object) => Array.isArray(object?.frontmatter.source_ids) ? object.frontmatter.source_ids : []));
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "source" && isLive(object) &&
      (object.frontmatter.meeting_id === meeting.frontmatter.id || listed.has(object.frontmatter.id)));
  }

  private noteFor(meeting: LifeOSObject) {
    return liveMeetingNote(meeting.frontmatter.id, this.ctx.index.all());
  }
}

function workOrderBody(count: number) {
  return `# Enrich last 48h\n\n${count} ${count === 1 ? "meeting" : "meetings"} to enrich. For each entry in \`meetings\`:\n\n` +
    "- Fetch only what `missing_material` lists: Meet transcripts and recordings from the calendar event and Drive, Gong calls from the Gong connector, Gong summary emails from Gmail.\n" +
    "- For recurring meetings, read only that occurrence's own Note at `note_path`, never another occurrence's Note.\n" +
    "- Write one occurrence-specific `meeting-material` Inbox Draft per meeting to `_inbox/drafts/`, copying its occurrence identifiers exactly.\n" +
    "- Never read files marked `sensitivity: restricted`.\n" +
    "- When done, move this file to `_inbox/processed/`.\n";
}
