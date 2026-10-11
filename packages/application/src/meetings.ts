import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DEFAULT_NOTE_BODY, markdownFileName, type AppContext } from "./context.js";
import { PeopleModule } from "./people.js";
import { operationKinds, type CalendarEvent, type Operation } from "./ports.js";
import { isLive, isMeetingRestricted, isRestricted, liveMeetingNote, OneAtATime, resolveObjectRedirect } from "./support.js";

type EventContext = { client?: LifeOSObject; product?: LifeOSObject; project?: LifeOSObject; people: LifeOSObject[] };

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
  async createMeetingFromEvent(externalId: string, from?: Date, to?: Date, calendarId?: string, initialBody?: string) {
    const event = await this.findEvent(externalId, from, to, calendarId);
    // Recurring occurrences share a note, so serialize the whole provider series as one write scope.
    return this.meetingCreations.run(this.seriesKey(event) ?? externalId, () => this.createMeetingFromEventSerialized(event, initialBody));
  }

  /** ADR 0013 recovery uses the captured provider event, not a new date-window query. */
  async recoverCreateMeeting(operation: Operation) {
    const event = operation.payload.event as CalendarEvent | undefined;
    if (event?.externalId) return this.meetingCreations.run(this.seriesKey(event) ?? event.externalId, () => this.createMeetingFromEventSerialized(event));
    if (typeof operation.payload.externalId === "string") return this.createMeetingFromEvent(operation.payload.externalId);
  }

  async recoverSeriesLinks(operation: Operation) {
    if (typeof operation.payload.seriesId !== "string" || typeof operation.payload.noteId !== "string") return;
    await this.repairSuccessorSeriesLinks(operation.payload.seriesId, operation.payload.noteId, typeof operation.payload.now === "string" ? operation.payload.now : new Date().toISOString(), operation);
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
          ...(event.seriesUid ? { recurrence_series_uid: event.seriesUid } : {}),
          recurrence_occurrence_id: this.occurrenceId(event),
          original_occurrence_starts_at: event.originalOccurrenceStartsAt
        } : {}),
        external_refs: [{ provider: ctx.calendar?.provider ?? "calendar", external_id: event.externalId, calendar_id: event.calendarId, ...(event.seriesId ? { series_id: event.seriesId } : {}), ...(event.originalOccurrenceStartsAt ? { original_occurrence_starts_at: event.originalOccurrenceStartsAt } : {}) }]
      },
      body: `# ${event.title}\n\nCanonical meeting created from ${ctx.calendar?.provider ?? "calendar"}.\n`
    });
  }

  private async createMeetingFromEventSerialized(event: CalendarEvent, initialBody?: string) {
    const { ctx } = this;
    const externalId = event.externalId;
    const now = new Date().toISOString();
    const context = await this.ensureEventContext(event, now);
    const pendingOperation = (await ctx.objects.incompleteOperations?.() ?? []).find((operation) => operation.kind === operationKinds.createMeeting && operation.payload.externalId === externalId && (!event.calendarId || !operation.payload.calendarId || operation.payload.calendarId === event.calendarId));
    const existing = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    if (existing) {
      let existingNote = this.noteFor(existing.frontmatter.id);
      if (!existingNote) {
        // Either finishing an interrupted create-meeting operation, or a meeting that has no note
        // yet (the PB-020 flow, or a meeting created before it): create the note now.
        const recoveredNoteId = pendingOperation && typeof pendingOperation.payload.noteId === "string" ? pendingOperation.payload.noteId : uuidV7();
        const recoveredBody = initialBody ?? (typeof pendingOperation?.payload.body === "string" ? pendingOperation.payload.body : DEFAULT_NOTE_BODY);
        existingNote = await this.attachOrCreateNote(event, existing, recoveredNoteId, recoveredBody, context, now);
      } else {
        existingNote = await this.followCalendarTitle(existingNote, event, now);
      }
      await this.enrichMeetingContext(existing, context, now);
      if (existingNote?.frontmatter.recurrence_series_id) await this.repairSuccessorSeriesLinks(String(existingNote.frontmatter.recurrence_series_id), existingNote.frontmatter.id, now, undefined, existingNote);
      if (pendingOperation) await ctx.writeAuditOnce("meeting.created", existing.frontmatter.id, now, { operation_id: pendingOperation.id, external_id: externalId }, { matchOn: ["operation_id"] });
      if (pendingOperation) await ctx.objects.completeOperation?.(pendingOperation.id);
      await ctx.rebuildIndex();
      await this.syncOccurrenceStatus(existing.frontmatter.id, event, now);
      return this.meetingWorkspace(existing.frontmatter.id);
    }

    const operationId = pendingOperation?.id ?? uuidV7();
    const operation = pendingOperation ?? await ctx.objects.prepareOperation?.(operationKinds.createMeeting, { externalId, calendarId: event.calendarId, event, meetingId: uuidV7(), noteId: uuidV7(), body: initialBody ?? DEFAULT_NOTE_BODY }, operationId);
    const meetingId = typeof operation?.payload.meetingId === "string" ? operation.payload.meetingId : uuidV7();
    const noteId = typeof operation?.payload.noteId === "string" ? operation.payload.noteId : uuidV7();
    const noteBody = initialBody ?? (typeof operation?.payload.body === "string" ? operation.payload.body : DEFAULT_NOTE_BODY);
    const meeting = await this.writeMeeting(event, meetingId, context, now);
    const note = await this.attachOrCreateNote(event, meeting, noteId, noteBody, context, now);
    if (note.frontmatter.recurrence_series_id) await this.repairSuccessorSeriesLinks(String(note.frontmatter.recurrence_series_id), note.frontmatter.id, now, undefined, note);
    await ctx.writeAuditOnce("meeting.created", meetingId, now, { operation_id: operationId, external_id: externalId }, { matchOn: ["operation_id"] });
    await ctx.objects.completeOperation?.(operationId);
    await ctx.rebuildIndex();
    return this.meetingWorkspace(meetingId);
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
    const meeting: LifeOSObject = {
      frontmatter: { ...this.ctx.envelope(`preview:${externalId}`, "meeting", event.title, now, "calendar"), status: "scheduled", starts_at: event.startsAt, ends_at: event.endsAt, timezone: event.timezone, is_all_day: event.isAllDay ?? false, attendee_snapshot: [...event.attendees], ...(event.location ? { location: event.location } : {}), ...(event.joinUrl ? { join_url: event.joinUrl } : {}) },
      body: "", relativePath: "", contentHash: ""
    };
    return {
      persisted: false as const,
      meeting,
      note: undefined,
      reviews: [] as LifeOSObject[],
      tasks: [] as LifeOSObject[],
      context: {
        project: event.projectName ? synthetic("project", event.projectName) : undefined,
        client: event.clientName ? synthetic("client", event.clientName) : undefined,
        product: event.productName ? synthetic("product", event.productName) : undefined,
        people: this.people.previewAttendees(event, (title) => synthetic("person", title))
      }
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
    const sections = note && Array.isArray(note.frontmatter.occurrence_sections) ? note.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
    const occurrenceItems = sections.flatMap((section) => {
      const sectionMeeting = typeof section.meeting_id === "string" ? index.get(section.meeting_id) : undefined;
      if (!sectionMeeting || sectionMeeting.frontmatter.type !== "meeting" || !isLive(sectionMeeting)) return [];
      const sectionMeetingId = sectionMeeting.frontmatter.id;
      const sectionAttendeeIds = Array.isArray(sectionMeeting.frontmatter.attendee_ids) ? sectionMeeting.frontmatter.attendee_ids : [];
      const sourceIds = new Set(Array.isArray(sectionMeeting.frontmatter.source_ids) ? sectionMeeting.frontmatter.source_ids.filter((id): id is string => typeof id === "string") : []);
      const sources = index.all().filter((object) => object.frontmatter.type === "source" && isLive(object) && (object.frontmatter.meeting_id === sectionMeetingId || sourceIds.has(object.frontmatter.id)));
      return [{
        sectionId: String(section.section_id), occurrenceId: String(section.occurrence_id),
        originalStartsAt: String(section.original_starts_at), meeting: sectionMeeting,
        reviews: index.all().filter((object) => object.frontmatter.type === "review-item" && isLive(object) && object.frontmatter.source_meeting_id === sectionMeetingId),
        sources,
        context: { people: sectionAttendeeIds.map(resolve).filter((person): person is LifeOSObject => Boolean(person)) }
      }];
    });
    return {
      persisted: true as const,
      meeting,
      note,
      reviews,
      tasks,
      ...(redirect.sectionId ? { noteSectionId: redirect.sectionId } : {}),
      ...(occurrenceItems.length ? { occurrences: occurrenceItems } : {}),
      context: {
        project: resolve(meeting.frontmatter.primary_project_id),
        client: resolve(meeting.frontmatter.primary_client_id),
        product: resolve(meeting.frontmatter.primary_product_id),
        people: attendeeIds.map(resolve).filter((person): person is LifeOSObject => Boolean(person))
      }
    };
  }

  /** Explicit continuity for a restarted lookalike series. Titles and attendees never imply this link. */
  async linkPreviousSeriesNote(noteId: string, previousNoteId: string, expectedHash: string) {
    const requested = this.ctx.required(noteId);
    const seriesId = requested.frontmatter.recurrence_series_id;
    if (requested.frontmatter.type !== "meeting-note" || typeof seriesId !== "string" || !isLive(requested)) throw new Error("Only a live Recurring Meeting Note can be linked");
    return this.meetingCreations.run(`link-previous:${seriesId}`, async () => {
      const current = this.ctx.required(noteId);
      const previous = this.ctx.required(previousNoteId);
      if (current.frontmatter.previous_series_note_id === previousNoteId) return current;
      if (previous.frontmatter.type !== "meeting-note" || typeof previous.frontmatter.recurrence_series_id !== "string" || !isLive(previous)) throw new Error("Previous Note must be a live Recurring Meeting Note");
      if (noteId === previousNoteId) throw new Error("A Recurring Meeting Note cannot link to itself");
      const seen = new Set([noteId]);
      let ancestor: LifeOSObject | undefined = previous;
      while (ancestor) {
        if (seen.has(ancestor.frontmatter.id)) throw new Error("Previous-series links cannot form a cycle");
        seen.add(ancestor.frontmatter.id);
        const next: unknown = ancestor.frontmatter.previous_series_note_id;
        ancestor = typeof next === "string" ? this.ctx.index.get(next) : undefined;
      }
      const now = new Date().toISOString();
      const linked = await this.ctx.update(current, {
        previous_series_note_id: previous.frontmatter.id,
        previous_recurrence_series_id: previous.frontmatter.recurrence_series_id,
        previous_recurrence_series_source: "user"
      }, { expectedHash, now });
      await this.ctx.rebuildIndex();
      return linked;
    });
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
    const realText = (note: LifeOSObject) => note.body.trim() !== "" && note.body !== DEFAULT_NOTE_BODY && note.body.trim() !== DEFAULT_NOTE_BODY.trim() ? note.body.trim().length : 0;
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
    if (!seriesId) return undefined;
    return `${this.ctx.calendar?.provider ?? "calendar"}:${event.calendarId ?? "default"}:${seriesId}`;
  }

  /** One shared sensitivity covers stored and not-yet-materialized occurrences in the provider series. */
  isEventRestricted(event: CalendarEvent) {
    const meeting = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    const notes = this.ctx.index.all().filter((object) => object.frontmatter.type === "meeting-note" && !object.frontmatter.deleted_at);
    if (isMeetingRestricted(meeting, notes)) return true;
    const seriesId = this.seriesKey(event);
    return Boolean(seriesId && notes.some((note) => note.frontmatter.recurrence_series_id === seriesId && isRestricted(note)));
  }

  private occurrenceId(event: CalendarEvent) {
    const series = this.seriesKey(event);
    return series && event.originalOccurrenceStartsAt ? `${series}:${event.originalOccurrenceStartsAt}` : undefined;
  }

  private occurrenceSection(event: CalendarEvent, meetingId: string) {
    const occurrenceId = this.occurrenceId(event)!;
    return {
      occurrence_id: occurrenceId,
      section_id: `occurrence-${event.originalOccurrenceStartsAt!.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}`,
      meeting_id: meetingId,
      original_starts_at: event.originalOccurrenceStartsAt!,
      starts_at: event.startsAt
    };
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

  private findSeriesNote(seriesId: string | undefined) {
    return seriesId ? this.ctx.index.all().find((object) => object.frontmatter.type === "meeting-note" && isLive(object) && object.frontmatter.recurrence_series_id === seriesId) : undefined;
  }

  /** A day-scoped provider query may contain only the new half of a split. Use the provider's
   * stable series UID to reconcile it with an already materialized series in the same calendar. */
  private findPreviousSeriesNote(event: CalendarEvent, seriesId: string) {
    if (event.previousSeriesId) return this.findSeriesNote(this.seriesKey(event, event.previousSeriesId));
    if (!event.seriesUid) return undefined;
    const calendarScope = `${this.ctx.calendar?.provider ?? "calendar"}:${event.calendarId}:`;
    const occurrence = Date.parse(event.originalOccurrenceStartsAt ?? event.startsAt);
    return this.ctx.index.all()
      .filter((object) => object.frontmatter.type === "meeting-note" && isLive(object)
        && object.frontmatter.recurrence_series_uid === event.seriesUid
        && typeof object.frontmatter.recurrence_series_id === "string"
        && object.frontmatter.recurrence_series_id.startsWith(calendarScope)
        && object.frontmatter.recurrence_series_id !== seriesId
        && this.seriesStart(object) < occurrence)
      .sort((left, right) => this.seriesStart(right) - this.seriesStart(left))[0];
  }

  private seriesStart(note: LifeOSObject) {
    const sections = Array.isArray(note.frontmatter.occurrence_sections) ? note.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
    const starts = sections.map((section) => Date.parse(String(section.original_starts_at))).filter(Number.isFinite);
    return starts.length ? Math.min(...starts) : Number.NaN;
  }

  private insertRecurringSection(existingBody: string, existingSections: Array<Record<string, unknown>>, sectionBody: string, section: Record<string, unknown>) {
    const actualStart = (candidate: Record<string, unknown>) => Date.parse(String(candidate.starts_at ?? candidate.original_starts_at));
    const ordered = [...existingSections, section].sort((left, right) => actualStart(right) - actualStart(left));
    const index = ordered.findIndex((candidate) => candidate.section_id === section.section_id);
    if (index === 0) return { body: `${sectionBody}\n\n${existingBody}`, sections: ordered };
    if (index === ordered.length - 1) return { body: `${existingBody}\n\n${sectionBody}`, sections: ordered };
    const nextAnchor = `<a id="${String(ordered[index + 1]!.section_id)}"></a>`;
    const anchorOffset = existingBody.indexOf(nextAnchor);
    const headingOffset = anchorOffset < 0 ? -1 : existingBody.lastIndexOf("\n## ", anchorOffset);
    const insertAt = headingOffset < 0 ? existingBody.length : headingOffset + 1;
    return { body: `${existingBody.slice(0, insertAt)}${sectionBody}\n\n${existingBody.slice(insertAt)}`, sections: ordered };
  }

  private recurringSectionBody(event: CalendarEvent, sectionId: string, body: string) {
    return `## ${event.title} — ${event.startsAt}\n<a id="${sectionId}"></a>\n\n${body}`;
  }

  private generatedNoteTitle(event: CalendarEvent) { return `${event.title} notes`; }

  /** A generated recurring-note title tracks Calendar until a user or external editor changes it. */
  private async followCalendarTitle(note: LifeOSObject, event: CalendarEvent, now: string) {
    if (!note.frontmatter.recurrence_series_id || note.frontmatter.title_manually_renamed === true) return note;
    const generated = note.frontmatter.generated_title;
    // Legacy Markdown has no provenance marker, so preserve its title rather than guessing whether it was manual.
    if (typeof generated !== "string") return note;
    // A direct Markdown edit is manual too. Preserve it even though it could not set the marker itself.
    if (note.frontmatter.title !== generated) return note;
    const next = this.generatedNoteTitle(event);
    if (next === generated) return note;
    return this.ctx.update(note, { title: next, generated_title: next }, { expectedHash: note.contentHash, now });
  }

  /** Creates a one-off note unchanged, or idempotently attaches an occurrence to its shared series note. */
  private async attachOrCreateNote(event: CalendarEvent, meeting: LifeOSObject, noteId: string, body: string, context: EventContext, now: string) {
    const seriesId = this.seriesKey(event);
    const base = {
      people_ids: context.people.map((person) => person.frontmatter.id),
      primary_client_id: context.client?.frontmatter.id,
      primary_product_id: context.product?.frontmatter.id,
      primary_project_id: context.project?.frontmatter.id
    };
    if (!seriesId || !event.originalOccurrenceStartsAt) {
      return this.ctx.objects.write({ relativePath: `meetings/${markdownFileName(`${event.title} notes`, noteId, event.startsAt, event.timezone)}`, frontmatter: { ...this.ctx.envelope(noteId, "meeting-note", `${event.title} notes`, now), meeting_id: meeting.frontmatter.id, ...base }, body });
    }

    const section = this.occurrenceSection(event, meeting.frontmatter.id);
    const found = this.findSeriesNote(seriesId);
    const existing = found ? await this.followCalendarTitle(found, event, now) : undefined;
    if (existing) {
      const sections = Array.isArray(existing.frontmatter.occurrence_sections) ? existing.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
      if (sections.some((candidate) => candidate.occurrence_id === section.occurrence_id)) return existing;
      const meetingIds = Array.isArray(existing.frontmatter.meeting_ids) ? existing.frontmatter.meeting_ids.filter((id): id is string => typeof id === "string") : [String(existing.frontmatter.meeting_id)];
      const inserted = this.insertRecurringSection(existing.body, sections, this.recurringSectionBody(event, section.section_id, body), section);
      return this.ctx.update(existing, {
        meeting_ids: [meeting.frontmatter.id, ...meetingIds.filter((id) => id !== meeting.frontmatter.id)],
        occurrence_sections: inserted.sections
      }, { expectedHash: existing.contentHash, now, body: inserted.body });
    }

    const previousSeries = this.findPreviousSeriesNote(event, seriesId);
    const previousSeriesId = event.previousSeriesId
      ? this.seriesKey(event, event.previousSeriesId)
      : previousSeries?.frontmatter.recurrence_series_id;
    return this.ctx.objects.write({
      relativePath: `meetings/${markdownFileName(this.generatedNoteTitle(event), noteId, event.startsAt, event.timezone)}`,
      frontmatter: {
        ...this.ctx.envelope(noteId, "meeting-note", this.generatedNoteTitle(event), now),
        meeting_id: meeting.frontmatter.id,
        meeting_ids: [meeting.frontmatter.id],
        recurrence_series_id: seriesId,
        generated_title: this.generatedNoteTitle(event),
        ...(event.seriesUid ? { recurrence_series_uid: event.seriesUid } : {}),
        ...(previousSeriesId ? { previous_recurrence_series_id: previousSeriesId } : {}),
        ...(previousSeriesId ? { previous_recurrence_series_source: event.previousSeriesId ? "provider" : "series-uid" } : {}),
        occurrence_sections: [section],
        ...(previousSeries ? { previous_series_note_id: previousSeries.frontmatter.id } : {}),
        ...base
      },
      body: this.recurringSectionBody(event, section.section_id, body)
    });
  }

  /** Repairs an out-of-order split after the predecessor series Note is materialized. */
  private async repairSuccessorSeriesLinks(seriesId: string, noteId: string, now: string, replay?: Operation, sourceNote?: LifeOSObject) {
    const pending = replay ?? (await this.ctx.objects.incompleteOperations?.() ?? []).find((operation) => operation.kind === operationKinds.linkRecurringSeries && operation.payload.seriesId === seriesId && operation.payload.noteId === noteId);
    const operation = pending ?? await this.ctx.objects.prepareOperation?.(operationKinds.linkRecurringSeries, { seriesId, noteId, now }, uuidV7());
    const predecessor = sourceNote ?? this.ctx.index.get(noteId);
    for (const successor of this.ctx.index.all().filter((object) => object.frontmatter.type === "meeting-note" && isLive(object))) {
      const explicit = successor.frontmatter.previous_recurrence_series_id === seriesId && !successor.frontmatter.previous_series_note_id;
      const inferred = predecessor?.frontmatter.recurrence_series_uid
        && successor.frontmatter.recurrence_series_uid === predecessor.frontmatter.recurrence_series_uid
        && successor.frontmatter.previous_recurrence_series_source !== "provider"
        && this.seriesStart(predecessor) < this.seriesStart(successor)
        && (() => {
          const current = this.findSeriesNote(typeof successor.frontmatter.previous_recurrence_series_id === "string" ? successor.frontmatter.previous_recurrence_series_id : undefined);
          return !current || this.seriesStart(current) < this.seriesStart(predecessor);
        })();
      if (!explicit && !inferred) continue;
      await this.ctx.update(successor, inferred ? { previous_recurrence_series_id: seriesId, previous_series_note_id: noteId, previous_recurrence_series_source: "series-uid" } : { previous_series_note_id: noteId }, { expectedHash: successor.contentHash, now });
    }
    if (operation) await this.ctx.objects.completeOperation?.(operation.id);
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
    if (note && !note.frontmatter.primary_project_id) await this.ctx.update(note, { ...fields, people_ids: fields.attendee_ids }, { expectedHash: note.contentHash, now: timestamp });
  }
}
