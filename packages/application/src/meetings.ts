import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { acceptedSummaryText } from "@lifeos/shared";
import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DEFAULT_NOTE_BODY, markdownFileName, type AppContext } from "./context.js";
import { PeopleModule } from "./people.js";
import { operationKinds, type CalendarEvent, type CalendarEventReference, type Operation } from "./ports.js";
import { isLive, isMeetingRestricted, isRestricted, liveMeetingNote, OneAtATime, resolveObjectRedirect } from "./support.js";

type EventContext = { client?: LifeOSObject; product?: LifeOSObject; project?: LifeOSObject; people: LifeOSObject[] };

export function recurrenceSeriesKey(provider: string, event: Pick<CalendarEvent, "calendarId" | "seriesId">) {
  return event.seriesId ? `${provider}:${event.calendarId ?? "default"}:${event.seriesId}` : undefined;
}

export function recurrenceOccurrenceId(provider: string, event: Pick<CalendarEvent, "calendarId" | "seriesId" | "originalOccurrenceStartsAt">) {
  const series = recurrenceSeriesKey(provider, event);
  return series && event.originalOccurrenceStartsAt ? `${series}:${event.originalOccurrenceStartsAt}` : undefined;
}

/** A Legacy shared Note (ADR 0019): one Note linked to several Meetings or carrying occurrence sections. */
export function isLegacySharedNote(note: LifeOSObject) {
  const linked = Array.isArray(note.frontmatter.meeting_ids) ? note.frontmatter.meeting_ids.length : 0;
  return linked > 1 || Array.isArray(note.frontmatter.occurrence_sections);
}

/** #176: a recurring occurrence is named by its immutable provider identity; enrichment has no section to target. */
export interface EnrichmentOccurrenceTarget {
  occurrenceId: string;
}

function userNoteText(body: string) {
  const trimmed = body.trim();
  return trimmed && trimmed !== DEFAULT_NOTE_BODY.trim() ? trimmed : "";
}

/** ADR 0021: how many earlier occurrences with a live Note the Series view shows. */
export const SERIES_VIEW_EARLIER_LIMIT = 4;

/** Raised for a Series view cursor that is malformed, tampered with or not issued by this server; mapped to HTTP 400. */
export class SeriesViewCursorError extends Error { override name = "SeriesViewCursorError"; constructor() { super("Invalid Series view cursor"); } }

/** Where a Series view page continues: the opened occurrence, plus the last entry already shown. */
type SeriesViewPosition = { seriesId: string; previousSeriesId?: string; openedAnchor: number; openedMeetingId: string; openedNoteId?: string; afterAnchor?: number; afterNoteId?: string };
/** The shape the API contract (`SeriesView` in @lifeos/contracts) declares; the server's typed routes check they stay compatible. */
export type SeriesViewNewer = { meetingId: string; startsAt: string; endsAt: string; timezone: string };
/** #176: what enrichment attached to one occurrence's own Meeting: its Sources and accepted summary. Absent for a Legacy shared Note or a restricted occurrence. */
export type SeriesViewMaterials = { summary?: string; sources: Array<{ id: string; title: string; sourceType: string; url?: string }> };
export type SeriesViewPage = { earlier: Array<{ kind: "occurrence" | "legacy-shared"; note: LifeOSObject; range: { startsAt: string; endsAt: string }; cancelled: boolean; materials?: SeriesViewMaterials }>; nextCursor?: string };
export type SeriesViewResult = SeriesViewPage & { newer?: SeriesViewNewer };

/** Canonical meetings for calendar events: creation, preview, workspace and duplicate reconciliation. */
export class MeetingsModule {
  /** Meeting creation runs one call at a time per calendar event id (PB-004, ADR 0013). */
  private readonly meetingCreations = new OneAtATime();

  private readonly people: PeopleModule;

  /** `people` is shared with the facade, so attendee resolution and label reads use one module (one queue). */
  constructor(private readonly ctx: AppContext, people?: PeopleModule) { this.people = people ?? new PeopleModule(ctx); }

  /**
   * Materializes the canonical meeting + note for a calendar event. The web UI calls this only on
   * the first real edit (PB-020), passing that edit as `initialBody`; merely opening an event goes
   * through `previewMeetingFromEvent` and writes nothing. Idempotent: a retry finds the meeting and
   * note by external id (or finishes a pending create-meeting operation) and never overwrites an
   * existing note body. `initialBody` is recorded in the operation payload so crash recovery
   * recreates the note with the user's text rather than a placeholder.
   */
  async createMeetingFromEvent(externalId: string, from?: Date, to?: Date, calendarId?: string, initialBody?: string, preferredNoteId?: string) {
    const event = await this.findEvent(externalId, from, to, calendarId);
    const existing = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    const hasUserContent = typeof initialBody === "string" && Boolean(userNoteText(initialBody));
    if (event.status === "cancelled" && !existing && !hasUserContent) return this.previewMeetingFromEvent(externalId, from, to, calendarId);
    // Recurring occurrences share a note, so serialize the whole provider series as one write scope.
    return this.meetingCreations.run(this.seriesKey(event) ?? externalId, () => this.createMeetingFromEventSerialized(event, initialBody, preferredNoteId));
  }

  /** ADR 0013 recovery uses the captured provider event, not a new date-window query. */
  async recoverCreateMeeting(operation: Operation) {
    const event = operation.payload.event as CalendarEvent | undefined;
    if (event?.externalId) return this.meetingCreations.run(this.seriesKey(event) ?? event.externalId, () => this.createMeetingFromEventSerialized(event));
    if (typeof operation.payload.externalId === "string") return this.createMeetingFromEvent(operation.payload.externalId);
  }

  /**
   * Pre-#172 builds journalled `link-recurring-series` while repairing links between shared series Notes. Those are all Legacy
   * shared Notes now, which the app never rewrites (ADR 0021), so replaying an old journal only closes it.
   */
  async recoverSeriesLinks(operation: Operation) {
    await this.ctx.objects.completeOperation?.(operation.id);
  }

  /**
   * Pre-#178 builds journalled `migrate-recurring-notes` for the reviewed recurring-Note migration (ADR 0019). That
   * feature is gone (ADR 0021), so recovery only closes the journal: it writes nothing, and every Note it had touched stays
   * as the earlier run left it (a Legacy shared Note, or an archived Note whose redirect still resolves).
   */
  async recoverRecurringMigration(operation: Operation) {
    await this.ctx.objects.completeOperation?.(operation.id);
  }

  /**
   * #45: the meeting for a calendar event, created if missing, WITHOUT its note: enrichment can attach
   * material to a meeting the user never opened, and the note still appears only on the first edit
   * (`createMeetingFromEvent` then finds this meeting and adds the note). Shares the per-event queue, so
   * it never races a first edit into a duplicate meeting. Returns undefined when the calendar has no such
   * event. No operation is recorded: a crash before the write leaves nothing, and a retry finds the meeting.
   */
  /** `draftKey`: the adopted draft asking for the meeting (#59); its `meeting.created` audit is written once per draft. */
  async ensureMeetingForEvent(externalId: string, options: { from: Date; to: Date; calendarId?: string; meetingId: string; draftKey?: string }) {
    const existing = this.findMeetingForEvent(externalId, options.calendarId);
    if (existing) return { meeting: existing, created: false };
    if (!this.ctx.calendar) throw new Error("Calendar connector is not configured");
    const event = (await this.ctx.calendar.listEvents(options.from, options.to)).find((candidate) => candidate.externalId === externalId && (!options.calendarId || candidate.calendarId === options.calendarId));
    if (!event) return undefined;
    return this.meetingCreations.run(this.seriesKey(event) ?? externalId, async () => {
      const sameOccurrence = this.findMeetingForEvent(event.externalId, event.calendarId, event);
      if (sameOccurrence) return { meeting: sameOccurrence, created: false };
      const now = new Date().toISOString();
      const meeting = await this.writeMeeting(event, options.meetingId, await this.ensureEventContext(event, now), now);
      const metadata = { external_id: externalId, reason: "enrichment" };
      if (options.draftKey) await this.ctx.writeAuditOnce("meeting.created", options.meetingId, now, { ...metadata, draft_key: options.draftKey }, { matchOn: ["draft_key"] });
      else await this.ctx.writeAudit("meeting.created", options.meetingId, now, metadata);
      await this.ctx.rebuildIndex();
      return { meeting: this.ctx.index.get(options.meetingId) ?? meeting, created: true };
    });
  }

  /** Read-only recurrence target used to validate an Agent draft before Adoption writes anything. */
  async enrichmentOccurrenceForEvent(externalId: string, from: Date, to: Date, calendarId?: string): Promise<EnrichmentOccurrenceTarget | undefined> {
    const event = await this.findEvent(externalId, from, to, calendarId);
    const occurrenceId = recurrenceOccurrenceId(this.ctx.calendar?.provider ?? "calendar", event);
    return occurrenceId && event.originalOccurrenceStartsAt ? { occurrenceId } : undefined;
  }

  /** Recurrence target already stored on an occurrence Meeting. */
  enrichmentOccurrenceForMeeting(meeting: LifeOSObject): EnrichmentOccurrenceTarget | undefined {
    const occurrenceId = typeof meeting.frontmatter.recurrence_occurrence_id === "string" ? meeting.frontmatter.recurrence_occurrence_id : undefined;
    const original = typeof meeting.frontmatter.original_occurrence_starts_at === "string" ? meeting.frontmatter.original_occurrence_starts_at : undefined;
    return occurrenceId && original ? { occurrenceId } : undefined;
  }

  /** The `meeting.created` audit of a meeting an adopted draft created, if a crash stopped it being written (#59). */
  async auditCreatedForDraft(meeting: LifeOSObject, draftKey: string) {
    const ref = (meeting.frontmatter.external_refs as Array<{ external_id?: string }> | undefined)?.[0];
    await this.ctx.writeAuditOnce("meeting.created", meeting.frontmatter.id, meeting.frontmatter.created_at, { external_id: ref?.external_id, reason: "enrichment", draft_key: draftKey }, { matchOn: ["draft_key"] });
  }

  private writeMeeting(event: CalendarEvent, meetingId: string, context: EventContext, now: string) {
    const { ctx } = this;
    return ctx.objects.write({
      relativePath: `meetings/${markdownFileName(event.title, meetingId, event.startsAt, event.timezone)}`,
      frontmatter: {
        ...ctx.envelope(meetingId, "meeting", event.title, now, "calendar"),
        status: event.status === "cancelled" ? "cancelled" : "scheduled",
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        timezone: event.timezone,
        attendee_ids: context.people.map((person) => person.frontmatter.id),
        // Immutable display snapshot: Person records may be renamed or deleted later.
        attendee_snapshot: [...event.attendees],
        primary_client_id: context.client?.frontmatter.id,
        primary_product_id: context.product?.frontmatter.id,
        primary_project_id: context.project?.frontmatter.id,
        is_all_day: event.isAllDay ?? false,
        ...(event.location ? { location: event.location } : {}),
        ...(event.joinUrl ? { join_url: event.joinUrl } : {}),
        ...(event.seriesId && event.originalOccurrenceStartsAt ? {
          recurrence_series_id: this.seriesKey(event),
          ...(event.previousSeriesId ? { previous_recurrence_series_id: this.seriesKey(event, event.previousSeriesId) } : {}),
          ...(event.seriesUid ? { recurrence_series_uid: event.seriesUid } : {}),
          recurrence_occurrence_id: this.occurrenceId(event),
          original_occurrence_starts_at: event.originalOccurrenceStartsAt
        } : {}),
        external_refs: [{ provider: ctx.calendar?.provider ?? "calendar", external_id: event.externalId, calendar_id: event.calendarId, ...(event.seriesId ? { series_id: event.seriesId } : {}), ...(event.originalOccurrenceStartsAt ? { original_occurrence_starts_at: event.originalOccurrenceStartsAt } : {}) }]
      },
      body: `# ${event.title}\n\nCanonical meeting created from ${ctx.calendar?.provider ?? "calendar"}.\n`
    });
  }

  private async createMeetingFromEventSerialized(event: CalendarEvent, initialBody?: string, preferredNoteId?: string) {
    const { ctx } = this;
    const externalId = event.externalId;
    const now = new Date().toISOString();
    const context = await this.ensureEventContext(event, now);
    const pendingOperation = (await ctx.objects.incompleteOperations?.() ?? []).find((operation) => operation.kind === operationKinds.createMeeting && operation.payload.externalId === externalId && (!event.calendarId || !operation.payload.calendarId || operation.payload.calendarId === event.calendarId));
    let existing = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    if (existing) {
      existing = await this.recordRecurrenceIdentity(existing, event, now);
      if (!this.noteFor(existing.frontmatter.id)) {
        // Either finishing an interrupted create-meeting operation, or a meeting that has no note
        // yet (the PB-020 flow, or a meeting created before it): create the note now.
        const recoveredNoteId = pendingOperation && typeof pendingOperation.payload.noteId === "string" ? pendingOperation.payload.noteId : preferredNoteId ?? uuidV7();
        const recoveredBody = initialBody ?? (typeof pendingOperation?.payload.body === "string" ? pendingOperation.payload.body : DEFAULT_NOTE_BODY);
        await this.createOccurrenceNote(event, existing, recoveredNoteId, recoveredBody, context, now);
      }
      await this.enrichMeetingContext(existing, context, now);
      if (pendingOperation) await ctx.objects.completeOperation?.(pendingOperation.id);
      // #160: after the journal closes, a retry can still reconstruct a missing audit from the
      // meeting. Action + object ID is the durable identity; operation_id is useful metadata only.
      await this.writeCalendarMeetingCreatedAudit(existing, event, pendingOperation?.id);
      await ctx.rebuildIndex();
      await this.syncOccurrenceStatus(existing.frontmatter.id, event, now);
      return this.meetingWorkspace(existing.frontmatter.id);
    }

    const operationId = pendingOperation?.id ?? uuidV7();
    const operation = pendingOperation ?? await ctx.objects.prepareOperation?.(operationKinds.createMeeting, { externalId, calendarId: event.calendarId, event, meetingId: uuidV7(), noteId: preferredNoteId ?? uuidV7(), body: initialBody ?? DEFAULT_NOTE_BODY }, operationId);
    const meetingId = typeof operation?.payload.meetingId === "string" ? operation.payload.meetingId : uuidV7();
    const noteId = typeof operation?.payload.noteId === "string" ? operation.payload.noteId : preferredNoteId ?? uuidV7();
    const noteBody = initialBody ?? (typeof operation?.payload.body === "string" ? operation.payload.body : DEFAULT_NOTE_BODY);
    const meeting = await this.writeMeeting(event, meetingId, context, now);
    await this.createOccurrenceNote(event, meeting, noteId, noteBody, context, now);
    await ctx.objects.completeOperation?.(operationId);
    await this.writeCalendarMeetingCreatedAudit(meeting, event, operationId);
    await ctx.rebuildIndex();
    return this.meetingWorkspace(meetingId);
  }

  private async writeCalendarMeetingCreatedAudit(meeting: LifeOSObject, event: CalendarEvent, operationId?: string) {
    await this.ctx.writeAuditOnce("meeting.created", meeting.frontmatter.id, String(meeting.frontmatter.created_at), {
      ...(operationId ? { operation_id: operationId } : {}),
      external_id: event.externalId,
      ...(event.calendarId ? { calendar_id: event.calendarId } : {})
    }, { matchOn: [] });
  }

  /**
   * Read-only view of what opening a calendar event shows. If LifeOS already has the meeting it
   * returns the real workspace; otherwise a synthetic, non-persisted one (`persisted: false`, no
   * note, ids prefixed `preview:`). Writes nothing — not the meeting, the note, or the
   * client/project/person objects `createMeetingFromEvent` would add. The UI shows an editable
   * draft over it and calls `createMeetingFromEvent` on the first real edit.
   */
  async previewMeetingFromEvent(externalId: string, from?: Date, to?: Date, calendarId?: string) {
    const event = await this.findEvent(externalId, from, to, calendarId);
    const existing = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    if (existing) return this.meetingWorkspace(existing.frontmatter.id);
    const now = new Date().toISOString();
    const synthetic = (type: ObjectEnvelope["type"], title: string): LifeOSObject => ({ frontmatter: { ...this.ctx.envelope(`preview:${type}:${externalId}:${title}`, type, title, now, "calendar") }, body: "", relativePath: "", contentHash: "" });
    const context = {
      project: event.projectName ? synthetic("project", event.projectName) : undefined,
      client: event.clientName ? synthetic("client", event.clientName) : undefined,
      product: event.productName ? synthetic("product", event.productName) : undefined,
      people: this.people.previewAttendees(event, (title) => synthetic("person", title))
    };
    const seriesId = this.seriesKey(event);
    const meeting: LifeOSObject = {
      frontmatter: {
        ...this.ctx.envelope(`preview:${externalId}`, "meeting", event.title, now, "calendar"),
        status: event.status === "cancelled" ? "cancelled" : "scheduled",
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        timezone: event.timezone,
        is_all_day: event.isAllDay ?? false,
        attendee_snapshot: [...event.attendees],
        ...(event.location ? { location: event.location } : {}),
        ...(event.joinUrl ? { join_url: event.joinUrl } : {}),
        ...(seriesId ? { recurrence_series_id: seriesId } : {}),
        ...(seriesId && event.previousSeriesId ? { previous_recurrence_series_id: this.seriesKey(event, event.previousSeriesId) } : {}),
        ...(seriesId && event.originalOccurrenceStartsAt ? {
          ...(event.seriesUid ? { recurrence_series_uid: event.seriesUid } : {}),
          recurrence_occurrence_id: this.occurrenceId(event),
          original_occurrence_starts_at: event.originalOccurrenceStartsAt
        } : {})
      },
      body: "", relativePath: "", contentHash: ""
    };
    const seriesView = this.seriesView(meeting);
    return {
      persisted: false as const,
      meeting,
      note: undefined,
      reviews: [] as LifeOSObject[],
      tasks: [] as LifeOSObject[],
      ...(seriesView ? { seriesView } : {}),
      context
    };
  }

  async meetingFromEvent(externalId: string) {
    const meeting = this.findMeetingForEvent(externalId);
    if (!meeting) throw new Error(`No LifeOS meeting exists for calendar event: ${externalId}`);
    return this.meetingWorkspace(meeting.frontmatter.id);
  }

  async meetingWorkspace(meetingId: string) {
    const { index } = this.ctx;
    const redirect = resolveObjectRedirect(meetingId, index.all());
    const meeting = redirect.object;
    if (meeting.frontmatter.type !== "meeting") throw new Error(`Object is not a meeting: ${meeting.frontmatter.id}`);
    const resolvedMeetingId = meeting.frontmatter.id;
    const note = this.noteFor(resolvedMeetingId);
    const reviews = index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.source_meeting_id === resolvedMeetingId);
    const tasks = index.all().filter((object) => object.frontmatter.type === "task" && isLive(object) && object.frontmatter.source_meeting_id === resolvedMeetingId);
    const resolve = (value: unknown) => typeof value === "string" ? index.get(value) : undefined;
    const attendeeIds = Array.isArray(meeting.frontmatter.attendee_ids) ? meeting.frontmatter.attendee_ids : [];
    const seriesView = this.seriesView(meeting);
    return {
      persisted: true as const,
      meeting,
      note,
      reviews,
      tasks,
      ...(seriesView ? { seriesView } : {}),
      context: {
        project: resolve(meeting.frontmatter.primary_project_id),
        client: resolve(meeting.frontmatter.primary_client_id),
        product: resolve(meeting.frontmatter.primary_product_id),
        people: attendeeIds.map(resolve).filter((person): person is LifeOSObject => Boolean(person))
      }
    };
  }

  /**
   * ADR 0021 Series view: the live Notes of the earlier occurrences in the opened occurrence's provider
   * series, newest first, 4 per page; `undefined` for a Meeting with no provider series. Pure read.
   * Membership is the Meeting's `recurrence_series_id`, continued into the provider's previous series
   * (`previous_recurrence_series_id`, a "this and following" split) and nothing else; titles, attendees
   * and times are never compared. "Earlier" is relative to the opened occurrence's original start (its
   * start when the provider gave no original). A Legacy shared Note is listed once, at its newest earlier
   * Meeting. `newer` points at the latest occurrence with a Note when the opened one is not it (#180).
   */
  private seriesView(opened: LifeOSObject): SeriesViewResult | undefined {
    const position = this.seriesPositionOf(opened);
    if (!position) return undefined;
    const newer = this.newerSeriesOccurrence(position);
    return { ...this.seriesViewPageFor(position), ...(newer ? { newer } : {}) };
  }

  private seriesPositionOf(opened: LifeOSObject): SeriesViewPosition | undefined {
    const seriesId = opened.frontmatter.recurrence_series_id;
    if (typeof seriesId !== "string") return undefined;
    const noteId = this.noteFor(opened.frontmatter.id)?.frontmatter.id;
    return {
      seriesId,
      ...(typeof opened.frontmatter.previous_recurrence_series_id === "string" ? { previousSeriesId: opened.frontmatter.previous_recurrence_series_id } : {}),
      openedAnchor: this.seriesAnchor(opened),
      openedMeetingId: opened.frontmatter.id,
      ...(noteId ? { openedNoteId: noteId } : {})
    };
  }

  /**
   * "Load older": the page after `cursor`. The cursor is signed by this server, so it cannot be forged to page
   * another series; when the opened occurrence is stored, its series is re-derived from the index anyway.
   * A not-yet-stored occurrence relies on the signed position (its provider event is not in the index).
   */
  async seriesViewPage(cursor: string) {
    const issued = this.decodeSeriesCursor(cursor);
    const stored = this.ctx.index.get(issued.openedMeetingId);
    const derived = stored?.frontmatter.type === "meeting" && isLive(stored) ? this.seriesPositionOf(stored) : undefined;
    return this.seriesViewPageFor({ ...(derived ?? issued), ...(issued.afterAnchor !== undefined ? { afterAnchor: issued.afterAnchor } : {}), ...(issued.afterNoteId !== undefined ? { afterNoteId: issued.afterNoteId } : {}) });
  }

  private readonly cursorKey = randomBytes(32);
  private signSeriesCursor(payload: string) { return createHmac("sha256", this.cursorKey).update(payload).digest("base64url"); }
  private encodeSeriesCursor(position: SeriesViewPosition) {
    const payload = Buffer.from(JSON.stringify(position)).toString("base64url");
    return `${payload}.${this.signSeriesCursor(payload)}`;
  }
  private decodeSeriesCursor(value: string): SeriesViewPosition {
    try {
      const [payload, signature, ...extra] = value.split(".");
      if (!payload || !signature || extra.length) throw new Error("shape");
      const expected = Buffer.from(this.signSeriesCursor(payload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("signature");
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      const text = (key: string) => typeof parsed[key] === "string" && parsed[key] !== "";
      const number = (key: string) => typeof parsed[key] === "number" && Number.isFinite(parsed[key]);
      if (!text("seriesId") || !text("openedMeetingId") || !number("openedAnchor") || (parsed.previousSeriesId !== undefined && !text("previousSeriesId")) || (parsed.openedNoteId !== undefined && !text("openedNoteId")) || (parsed.afterAnchor !== undefined && !number("afterAnchor")) || (parsed.afterNoteId !== undefined && !text("afterNoteId"))) throw new Error("fields");
      return parsed as SeriesViewPosition;
    } catch { throw new SeriesViewCursorError(); }
  }

  private seriesAnchor(meeting: LifeOSObject) {
    return Date.parse(String(meeting.frontmatter.original_occurrence_starts_at ?? meeting.frontmatter.starts_at));
  }

  private liveMeetings(seriesId: string) {
    return this.ctx.index.all().filter((meeting) => meeting.frontmatter.type === "meeting" && isLive(meeting) && meeting.frontmatter.recurrence_series_id === seriesId);
  }

  /** The opened series, then its provider-linked predecessors (older). */
  private seriesChain(position: SeriesViewPosition) {
    const previousOf = (seriesId: string) => this.liveMeetings(seriesId).map((meeting) => meeting.frontmatter.previous_recurrence_series_id).find((id): id is string => typeof id === "string");
    const chain = [position.seriesId];
    let next = position.previousSeriesId ?? previousOf(position.seriesId);
    while (next && !chain.includes(next)) {
      chain.push(next);
      next = previousOf(next);
    }
    return chain;
  }

  /** The opened series and every provider-linked successor (a series whose Meetings name it as their previous series). */
  private seriesAndSuccessors(seriesId: string) {
    const family = new Set([seriesId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const meeting of this.ctx.index.all()) {
        const previous = meeting.frontmatter.previous_recurrence_series_id;
        const own = meeting.frontmatter.recurrence_series_id;
        if (meeting.frontmatter.type === "meeting" && isLive(meeting) && typeof previous === "string" && typeof own === "string" && family.has(previous) && !family.has(own)) { family.add(own); grew = true; }
      }
    }
    return family;
  }

  private newerSeriesOccurrence(position: SeriesViewPosition): SeriesViewNewer | undefined {
    const family = this.seriesAndSuccessors(position.seriesId);
    let latest: LifeOSObject | undefined;
    for (const meeting of this.ctx.index.all()) {
      const own = meeting.frontmatter.recurrence_series_id;
      if (meeting.frontmatter.type !== "meeting" || !isLive(meeting) || typeof own !== "string" || !family.has(own) || meeting.frontmatter.id === position.openedMeetingId) continue;
      if (this.seriesAnchor(meeting) <= position.openedAnchor || !this.noteFor(meeting.frontmatter.id)) continue;
      if (!latest || this.seriesAnchor(meeting) > this.seriesAnchor(latest)) latest = meeting;
    }
    return latest ? { meetingId: latest.frontmatter.id, startsAt: String(latest.frontmatter.starts_at), endsAt: String(latest.frontmatter.ends_at), timezone: String(latest.frontmatter.timezone) } : undefined;
  }

  private seriesViewPageFor(position: SeriesViewPosition) {
    const { index } = this.ctx;
    const chain = new Set(this.seriesChain(position));
    const liveSeriesMeeting = (candidate: LifeOSObject | undefined): candidate is LifeOSObject =>
      candidate?.frontmatter.type === "meeting" && isLive(candidate) && typeof candidate.frontmatter.recurrence_series_id === "string" && chain.has(candidate.frontmatter.recurrence_series_id);
    const notes = new Map<string, LifeOSObject>();
    for (const meeting of index.all()) {
      if (!liveSeriesMeeting(meeting) || meeting.frontmatter.id === position.openedMeetingId) continue;
      const note = this.noteFor(meeting.frontmatter.id);
      if (note && note.frontmatter.id !== position.openedNoteId) notes.set(note.frontmatter.id, note);
    }
    const entries = [...notes.values()].flatMap((note) => {
      const linkedIds = Array.isArray(note.frontmatter.meeting_ids) ? note.frontmatter.meeting_ids.filter((id): id is string => typeof id === "string") : [];
      const legacyShared = isLegacySharedNote(note);
      const linkedMeetings = (legacyShared ? linkedIds : [String(note.frontmatter.meeting_id)]).map((id) => index.get(id)).filter(liveSeriesMeeting);
      const earlierMeetings = linkedMeetings.filter((meeting) => meeting.frontmatter.id !== position.openedMeetingId && this.seriesAnchor(meeting) < position.openedAnchor);
      if (!earlierMeetings.length) return [];
      const newestEarlierAnchor = Math.max(...earlierMeetings.map((meeting) => this.seriesAnchor(meeting)));
      const byAnchor = [...linkedMeetings].sort((left, right) => this.seriesAnchor(left) - this.seriesAnchor(right));
      const first = byAnchor[0]!;
      const last = byAnchor[byAnchor.length - 1]!;
      return [{
        newestEarlierAnchor,
        entry: {
          kind: legacyShared ? "legacy-shared" as const : "occurrence" as const,
          note,
          range: { startsAt: String(first.frontmatter.starts_at), endsAt: String(last.frontmatter.ends_at) },
          cancelled: !legacyShared && first.frontmatter.status === "cancelled",
          ...(legacyShared ? {} : this.seriesMaterials(first, note))
        }
      }];
    });
    entries.sort((left, right) => right.newestEarlierAnchor - left.newestEarlierAnchor || left.entry.note.frontmatter.id.localeCompare(right.entry.note.frontmatter.id));
    const remaining = position.afterAnchor === undefined || position.afterNoteId === undefined ? entries : entries.filter(({ newestEarlierAnchor, entry }) => newestEarlierAnchor < position.afterAnchor! || (newestEarlierAnchor === position.afterAnchor && entry.note.frontmatter.id > position.afterNoteId!));
    const page = remaining.slice(0, SERIES_VIEW_EARLIER_LIMIT);
    const lastShown = page[page.length - 1];
    const more = remaining.length > page.length && lastShown;
    return {
      earlier: page.map(({ entry }) => entry),
      ...(more ? { nextCursor: this.encodeSeriesCursor({ ...position, afterAnchor: lastShown.newestEarlierAnchor, afterNoteId: lastShown.entry.note.frontmatter.id }) } : {})
    };
  }

  /** Sources linked to this occurrence's Meeting and its accepted summary, unless the Meeting or Note is restricted (ADR 0018). */
  private seriesMaterials(meeting: LifeOSObject, note: LifeOSObject) {
    if (isMeetingRestricted(meeting, this.ctx.index.all()) || isRestricted(note)) return {};
    const listed = new Set(Array.isArray(meeting.frontmatter.source_ids) ? meeting.frontmatter.source_ids : []);
    const sources = this.ctx.index.all()
      .filter((object) => object.frontmatter.type === "source" && isLive(object) && !isRestricted(object) && (object.frontmatter.meeting_id === meeting.frontmatter.id || listed.has(object.frontmatter.id)))
      .map((source) => ({ id: source.frontmatter.id, title: source.frontmatter.title, sourceType: String(source.frontmatter.source_type ?? "source"), ...(typeof source.frontmatter.url === "string" ? { url: source.frontmatter.url } : {}) }));
    const summary = acceptedSummaryText(meeting.body);
    return sources.length || summary ? { materials: { ...(summary ? { summary } : {}), sources } } : {};
  }

  /**
   * Finds live meetings that share one calendar event (PB-004) and, with `apply`, archives every
   * copy but one together with its notes (`archived_at`, file kept, audited). The kept copy is the
   * one whose note has the most text, then the highest revision. A group where a second copy's note
   * also holds real text is reported for a manual merge and never archived automatically.
   */
  async reconcileDuplicateMeetings(options: { apply: boolean }) {
    const all = this.ctx.index.all();
    // Not isLive on purpose: a duplicate's deleted note is archived with it, and its text still counts, so a copy with written notes is never archived silently.
    const notesOf = (meeting: LifeOSObject) => all.filter((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meeting.frontmatter.id && !object.frontmatter.archived_at);
    const realText = (note: LifeOSObject) => userNoteText(note.body).length;
    const groups = new Map<string, LifeOSObject[]>();
    for (const meeting of all.filter((object) => object.frontmatter.type === "meeting" && isLive(object))) {
      const refs = Array.isArray(meeting.frontmatter.external_refs) ? meeting.frontmatter.external_refs as Array<Record<string, unknown>> : [];
      for (const ref of refs) {
        if (typeof ref?.external_id !== "string") continue;
        const key = `${typeof ref.provider === "string" ? ref.provider : "calendar"}:${ref.external_id}`;
        const group = groups.get(key) ?? [];
        if (!group.includes(meeting)) group.push(meeting);
        groups.set(key, group);
      }
    }
    const report: Array<{ eventKey: string; title: string; keep: { meetingId: string; relativePath: string; noteIds: string[] }; archive: Array<{ id: string; relativePath: string; type: string }>; needsManualMerge: boolean }> = [];
    for (const [eventKey, meetings] of groups) {
      if (meetings.length < 2) continue;
      // Different calendars that both recorded their id are genuinely different meetings.
      const calendars = new Set(meetings.map((meeting) => (meeting.frontmatter.external_refs as Array<Record<string, unknown>>).find((ref) => `${ref.provider ?? "calendar"}:${ref.external_id}` === eventKey)?.calendar_id).filter(Boolean));
      if (calendars.size > 1) continue;
      const ranked = meetings.map((meeting) => ({ meeting, notes: notesOf(meeting), text: Math.max(0, ...notesOf(meeting).map(realText)) }))
        .sort((left, right) => right.text - left.text || right.meeting.frontmatter.revision - left.meeting.frontmatter.revision || Date.parse(left.meeting.frontmatter.created_at) - Date.parse(right.meeting.frontmatter.created_at));
      const [keep, ...rest] = ranked;
      const needsManualMerge = rest.some((candidate) => candidate.text > 0);
      report.push({
        eventKey, title: keep!.meeting.frontmatter.title, needsManualMerge,
        keep: { meetingId: keep!.meeting.frontmatter.id, relativePath: keep!.meeting.relativePath, noteIds: keep!.notes.map((note) => note.frontmatter.id) },
        archive: rest.flatMap(({ meeting, notes }) => [meeting, ...notes]).map((object) => ({ id: object.frontmatter.id, relativePath: object.relativePath, type: object.frontmatter.type }))
      });
    }
    if (!options.apply) return { applied: false, groups: report };
    const now = new Date().toISOString();
    for (const group of report.filter((entry) => !entry.needsManualMerge)) {
      for (const target of group.archive) {
        const current = this.ctx.required(target.id);
        if (current.frontmatter.archived_at) continue;
        await this.ctx.update(current, { archived_at: now, archived_reason: `Duplicate of meeting ${group.keep.meetingId} (PB-004)` }, { expectedHash: current.contentHash, now });
        await this.ctx.writeAudit("object.archived", target.id, now, { reason: "duplicate-meeting", kept_meeting_id: group.keep.meetingId, event: group.eventKey });
      }
    }
    await this.ctx.rebuildIndex();
    return { applied: true, groups: report };
  }

  /** Calendar events annotated with the LifeOS meeting and note they already have, if any. */
  withNoteLinks(events: CalendarEvent[]) {
    return events.map((event) => {
      const meeting = this.findMeetingForEvent(event.externalId, event.calendarId, event);
      const note = meeting ? this.noteFor(meeting.frontmatter.id) : undefined;
      return {
        ...event,
        hasNote: Boolean(note),
        meetingId: meeting?.frontmatter.id,
        noteId: note?.frontmatter.id
      };
    });
  }

  /**
   * An explicit Calendar sync may safely add provider recurrence identity to Meetings created
   * before recurring Notes existed. Matching stays on the immutable provider event reference;
   * titles, attendees and times are never used to infer a series.
   */
  async backfillRecurringMeetingIdentity(event: CalendarEvent) {
    if (!event.seriesId || !event.originalOccurrenceStartsAt) return false;
    const now = new Date().toISOString();
    const meeting = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    if (!meeting) return false;
    const updated = await this.recordRecurrenceIdentity(meeting, event, now);
    const changed = updated.contentHash !== meeting.contentHash;
    if (changed) await this.ctx.rebuildIndex();
    return changed;
  }

  /** Provider references for legacy per-occurrence Notes that still need an exact recurrence check. */
  recurringIdentityBackfillReferences(): CalendarEventReference[] {
    const candidateMeetingIds = new Set(this.ctx.index.all()
      .filter((object) => object.frontmatter.type === "meeting-note" && isLive(object)
        && typeof object.frontmatter.meeting_id === "string" && !object.frontmatter.recurrence_series_id)
      .map((object) => String(object.frontmatter.meeting_id)));
    return this.ctx.index.all().flatMap((meeting) => {
      if (meeting.frontmatter.type !== "meeting" || !isLive(meeting)
        || meeting.frontmatter.recurrence_series_id || !candidateMeetingIds.has(meeting.frontmatter.id)) return [];
      const references = Array.isArray(meeting.frontmatter.external_refs) ? meeting.frontmatter.external_refs : [];
      return references.flatMap((reference) => {
        if (typeof reference !== "object" || reference === null) return [];
        const { external_id: externalId, calendar_id: calendarId } = reference as { external_id?: unknown; calendar_id?: unknown };
        return typeof externalId === "string" ? [{ externalId, ...(typeof calendarId === "string" ? { calendarId } : {}) }] : [];
      });
    });
  }

  /** The live meeting for a calendar event. Identity is provider + calendar + event id (PB-004);
   * refs written before calendar_id or provider were recorded match on the fields they have. */
  private findMeetingForEvent(externalId: string, calendarId?: string, event?: CalendarEvent) {
    const provider = this.ctx.calendar?.provider;
    return this.ctx.index.all().find((object) => object.frontmatter.type === "meeting" && isLive(object) &&
      Array.isArray(object.frontmatter.external_refs) &&
      object.frontmatter.external_refs.some((reference: unknown) => {
        if (typeof reference !== "object" || reference === null) return false;
        const ref = reference as { provider?: string; external_id?: string; calendar_id?: string; series_id?: string; original_occurrence_starts_at?: string };
        const sameExternalEvent = ref.external_id === externalId;
        const sameOccurrence = Boolean(event?.seriesId && event.originalOccurrenceStartsAt && ref.series_id === event.seriesId && ref.original_occurrence_starts_at === event.originalOccurrenceStartsAt);
        return (sameExternalEvent || sameOccurrence) &&
          (!provider || !ref.provider || ref.provider === provider) &&
          (!calendarId || !ref.calendar_id || ref.calendar_id === calendarId);
      }));
  }

  private noteFor(meetingId: string) {
    return liveMeetingNote(meetingId, this.ctx.index.all());
  }

  private seriesKey(event: CalendarEvent, seriesId = event.seriesId) {
    return recurrenceSeriesKey(this.ctx.calendar?.provider ?? "calendar", { ...event, seriesId });
  }

  /** Per Note, never series-wide: ADR 0021. */
  isEventRestricted(event: CalendarEvent) {
    const meeting = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    const notes = this.ctx.index.all().filter((object) => object.frontmatter.type === "meeting-note" && !object.frontmatter.deleted_at);
    return isMeetingRestricted(meeting, notes);
  }

  private occurrenceId(event: CalendarEvent) {
    return recurrenceOccurrenceId(this.ctx.calendar?.provider ?? "calendar", event);
  }

  /** An existing per-occurrence Note becomes a migration candidate only after its exact Calendar event supplies recurrence identity. */
  private async recordRecurrenceIdentity(meeting: LifeOSObject, event: CalendarEvent, now: string) {
    const seriesId = this.seriesKey(event);
    const occurrenceId = this.occurrenceId(event);
    if (!seriesId || !occurrenceId || !event.originalOccurrenceStartsAt) return meeting;
    const stored = {
      seriesId: meeting.frontmatter.recurrence_series_id,
      occurrenceId: meeting.frontmatter.recurrence_occurrence_id,
      originalStartsAt: meeting.frontmatter.original_occurrence_starts_at
    };
    // These values identify the provider occurrence, so they are write-once. A calendar event can
    // supplement an old occurrence only when every stored value agrees; a conflict remains unresolved.
    if ((stored.seriesId !== undefined && stored.seriesId !== seriesId)
      || (stored.occurrenceId !== undefined && stored.occurrenceId !== occurrenceId)
      || (stored.originalStartsAt !== undefined && stored.originalStartsAt !== event.originalOccurrenceStartsAt)) return meeting;
    const previousSeriesId = event.previousSeriesId ? this.seriesKey(event, event.previousSeriesId) : undefined;
    const missingPrevious = previousSeriesId !== undefined && meeting.frontmatter.previous_recurrence_series_id === undefined;
    if (stored.seriesId === seriesId && stored.occurrenceId === occurrenceId && stored.originalStartsAt === event.originalOccurrenceStartsAt && !missingPrevious) return meeting;
    return this.ctx.update(meeting, {
      ...(stored.seriesId === undefined ? { recurrence_series_id: seriesId } : {}),
      ...(stored.occurrenceId === undefined ? { recurrence_occurrence_id: occurrenceId } : {}),
      ...(stored.originalStartsAt === undefined ? { original_occurrence_starts_at: event.originalOccurrenceStartsAt } : {}),
      ...(missingPrevious ? { previous_recurrence_series_id: previousSeriesId } : {}),
      ...(meeting.frontmatter.recurrence_series_uid === undefined && event.seriesUid ? { recurrence_series_uid: event.seriesUid } : {})
    }, { expectedHash: meeting.contentHash, now });
  }

  /** Cancellation is lifecycle state, not part of the immutable saved event snapshot. */
  private async syncOccurrenceStatus(meetingId: string, event: CalendarEvent, now: string) {
    const current = this.ctx.index.get(meetingId);
    if (!current || current.frontmatter.type !== "meeting") return;
    const status = event.status === "cancelled" ? "cancelled" : "scheduled";
    if (current.frontmatter.status === status) return;
    await this.ctx.update(current, { status }, { expectedHash: current.contentHash, now });
    await this.ctx.rebuildIndex();
  }

  /** Creates the occurrence's own Note (ADR 0021). */
  private async createOccurrenceNote(event: CalendarEvent, meeting: LifeOSObject, noteId: string, body: string, context: EventContext, now: string) {
    const base = {
      people_ids: context.people.map((person) => person.frontmatter.id),
      primary_client_id: context.client?.frontmatter.id,
      primary_product_id: context.product?.frontmatter.id,
      primary_project_id: context.project?.frontmatter.id
    };
    // ADR 0021: every occurrence gets its own Note, linked only by `meeting_id`. A recurring event never
    // links to or writes a shared (Legacy) Note, so one first edit writes this one file and nothing else.
    return this.ctx.objects.write({ relativePath: `meetings/${markdownFileName(`${event.title} notes`, noteId, event.startsAt, event.timezone)}`, frontmatter: { ...this.ctx.envelope(noteId, "meeting-note", `${event.title} notes`, now), meeting_id: meeting.frontmatter.id, ...base }, body });
  }

  private async findEvent(externalId: string, from?: Date, to?: Date, calendarId?: string) {
    if (!this.ctx.calendar) throw new Error("Calendar connector is not configured");
    const events = await this.ctx.calendar.listEvents(from ?? new Date(), to ?? new Date(Date.now() + 7 * 86_400_000));
    const event = events.find((candidate) => candidate.externalId === externalId && (!calendarId || candidate.calendarId === calendarId));
    if (!event) throw new Error(`Calendar event not found: ${externalId}`);
    return event;
  }

  private async ensureEventContext(event: CalendarEvent, timestamp: string): Promise<EventContext> {
    const client = event.clientName ? await this.ensureNamedObject("client", event.clientName, timestamp, { status: "active" }) : undefined;
    const product = event.productName ? await this.ensureNamedObject("product", event.productName, timestamp, { status: "active" }) : undefined;
    const project = event.projectName ? await this.ensureNamedObject("project", event.projectName, timestamp, {
      status: "active",
      objective: "Validate the local-first LifeOS meeting workflow",
      primary_client_id: client?.frontmatter.id,
      primary_product_id: product?.frontmatter.id
    }) : undefined;
    const people = await this.people.resolveAttendees(event, timestamp, (name) => this.ensureNamedObject("person", name, timestamp, { given_name: name.split(" ")[0] }));
    return { client, product, project, people };
  }

  private async ensureNamedObject(type: "client" | "product" | "project" | "person", title: string, timestamp: string, fields: Record<string, unknown>) {
    const existing = this.ctx.index.all().find((object) => object.frontmatter.type === type && isLive(object) && object.frontmatter.title === title);
    if (existing) return existing;
    const id = uuidV7();
    const folders = { client: "clients", product: "products", project: "projects", person: "people" } as const;
    return this.ctx.objects.write({
      relativePath: `${folders[type]}/${markdownFileName(title, id, timestamp)}`,
      frontmatter: { ...this.ctx.envelope(id, type, title, timestamp, "calendar"), ...fields },
      body: `# ${title}\n`
    });
  }

  private async enrichMeetingContext(meeting: LifeOSObject, context: EventContext, timestamp: string) {
    const fields = {
      attendee_ids: context.people.map((person) => person.frontmatter.id),
      primary_client_id: context.client?.frontmatter.id,
      primary_product_id: context.product?.frontmatter.id,
      primary_project_id: context.project?.frontmatter.id
    };
    const needsMeetingUpdate = !meeting.frontmatter.primary_project_id || !Array.isArray(meeting.frontmatter.attendee_ids);
    if (needsMeetingUpdate) await this.ctx.update(meeting, fields, { expectedHash: meeting.contentHash, now: timestamp });
    const note = this.noteFor(meeting.frontmatter.id);
    if (note && !isLegacySharedNote(note) && !note.frontmatter.primary_project_id) await this.ctx.update(note, { ...fields, people_ids: fields.attendee_ids }, { expectedHash: note.contentHash, now: timestamp });
  }
}
