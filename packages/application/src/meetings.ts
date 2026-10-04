import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DEFAULT_NOTE_BODY, markdownFileName, type AppContext } from "./context.js";
import { PeopleModule } from "./people.js";
import type { CalendarEvent } from "./ports.js";

type EventContext = { client?: LifeOSObject; product?: LifeOSObject; project?: LifeOSObject; people: LifeOSObject[] };

/** Canonical meetings for calendar events: creation, preview, workspace and duplicate reconciliation. */
export class MeetingsModule {
  /** In-flight `createMeetingFromEvent` calls, keyed by calendar event id (PB-004). */
  private readonly meetingCreations = new Map<string, Promise<unknown>>();

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
    // PB-004: two near-simultaneous first edits both saw "no meeting yet" and each created one.
    // Calls for the same event now run one after the other, so the second finds the first's meeting.
    const previous = this.meetingCreations.get(externalId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.createMeetingFromEventSerialized(externalId, from, to, calendarId, initialBody));
    const settled = run.catch(() => undefined);
    this.meetingCreations.set(externalId, settled);
    void settled.then(() => { if (this.meetingCreations.get(externalId) === settled) this.meetingCreations.delete(externalId); });
    return run;
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
    const previous = this.meetingCreations.get(externalId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const existing = this.findMeetingForEvent(externalId, options.calendarId);
      if (existing) return { meeting: existing, created: false };
      if (!this.ctx.calendar) throw new Error("Calendar connector is not configured");
      const event = (await this.ctx.calendar.listEvents(options.from, options.to)).find((candidate) => candidate.externalId === externalId && (!options.calendarId || candidate.calendarId === options.calendarId));
      if (!event) return undefined;
      const now = new Date().toISOString();
      const meeting = await this.writeMeeting(event, options.meetingId, await this.ensureEventContext(event, now), now);
      const metadata = { external_id: externalId, reason: "enrichment" };
      if (options.draftKey) await this.ctx.writeAuditOnce("meeting.created", options.meetingId, now, { ...metadata, draft_key: options.draftKey });
      else await this.ctx.writeAudit("meeting.created", options.meetingId, now, metadata);
      await this.ctx.rebuildIndex();
      return { meeting: this.ctx.index.get(options.meetingId) ?? meeting, created: true };
    });
    const settled = run.catch(() => undefined);
    this.meetingCreations.set(externalId, settled);
    void settled.then(() => { if (this.meetingCreations.get(externalId) === settled) this.meetingCreations.delete(externalId); });
    return run;
  }

  /** The `meeting.created` audit of a meeting an adopted draft created, if a crash stopped it being written (#59). */
  async auditCreatedForDraft(meeting: LifeOSObject, draftKey: string) {
    const ref = (meeting.frontmatter.external_refs as Array<{ external_id?: string }> | undefined)?.[0];
    await this.ctx.writeAuditOnce("meeting.created", meeting.frontmatter.id, meeting.frontmatter.created_at, { external_id: ref?.external_id, reason: "enrichment", draft_key: draftKey });
  }

  private writeMeeting(event: CalendarEvent, meetingId: string, context: EventContext, now: string) {
    const { ctx } = this;
    return ctx.objects.write({
      relativePath: `meetings/${markdownFileName(event.title, meetingId, event.startsAt, event.timezone)}`,
      frontmatter: {
        ...ctx.envelope(meetingId, "meeting", event.title, now, "calendar"),
        status: "scheduled",
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        timezone: event.timezone,
        attendee_ids: context.people.map((person) => person.frontmatter.id),
        primary_client_id: context.client?.frontmatter.id,
        primary_product_id: context.product?.frontmatter.id,
        primary_project_id: context.project?.frontmatter.id,
        is_all_day: event.isAllDay ?? false,
        external_refs: [{ provider: ctx.calendar?.provider ?? "calendar", external_id: event.externalId, calendar_id: event.calendarId }]
      },
      body: `# ${event.title}\n\nCanonical meeting created from ${ctx.calendar?.provider ?? "calendar"}.\n`
    });
  }

  private async createMeetingFromEventSerialized(externalId: string, from?: Date, to?: Date, calendarId?: string, initialBody?: string) {
    const { ctx } = this;
    const event = await this.findEvent(externalId, from, to, calendarId);
    const now = new Date().toISOString();
    const context = await this.ensureEventContext(event, now);
    const pendingOperation = (await ctx.objects.incompleteOperations?.() ?? []).find((operation) => operation.kind === "create-meeting" && operation.payload.externalId === externalId);
    const existing = this.findMeetingForEvent(event.externalId, event.calendarId);
    if (existing) {
      const existingNote = this.noteFor(existing.frontmatter.id);
      if (!existingNote) {
        // Either finishing an interrupted create-meeting operation, or a meeting that has no note
        // yet (the PB-020 flow, or a meeting created before it): create the note now.
        const recoveredNoteId = pendingOperation && typeof pendingOperation.payload.noteId === "string" ? pendingOperation.payload.noteId : uuidV7();
        const recoveredBody = initialBody ?? (typeof pendingOperation?.payload.body === "string" ? pendingOperation.payload.body : DEFAULT_NOTE_BODY);
        await ctx.objects.write({ relativePath: `meetings/${markdownFileName(`${event.title} notes`, recoveredNoteId, event.startsAt, event.timezone)}`, frontmatter: { ...ctx.envelope(recoveredNoteId, "meeting-note", `${event.title} notes`, now), meeting_id: existing.frontmatter.id, people_ids: context.people.map((person) => person.frontmatter.id), primary_client_id: context.client?.frontmatter.id, primary_product_id: context.product?.frontmatter.id, primary_project_id: context.project?.frontmatter.id }, body: recoveredBody });
      }
      await this.enrichMeetingContext(existing, context, now);
      if (pendingOperation) await ctx.objects.completeOperation?.(pendingOperation.id);
      await ctx.rebuildIndex();
      return this.meetingWorkspace(existing.frontmatter.id);
    }

    const operationId = pendingOperation?.id ?? uuidV7();
    const operation = pendingOperation ?? await ctx.objects.prepareOperation?.("create-meeting", { externalId, meetingId: uuidV7(), noteId: uuidV7(), body: initialBody ?? DEFAULT_NOTE_BODY }, operationId);
    const meetingId = typeof operation?.payload.meetingId === "string" ? operation.payload.meetingId : uuidV7();
    const noteId = typeof operation?.payload.noteId === "string" ? operation.payload.noteId : uuidV7();
    const noteBody = initialBody ?? (typeof operation?.payload.body === "string" ? operation.payload.body : DEFAULT_NOTE_BODY);
    await this.writeMeeting(event, meetingId, context, now);
    await ctx.objects.write({
      relativePath: `meetings/${markdownFileName(`${event.title} notes`, noteId, event.startsAt, event.timezone)}`,
      frontmatter: {
        ...ctx.envelope(noteId, "meeting-note", `${event.title} notes`, now),
        meeting_id: meetingId,
        people_ids: context.people.map((person) => person.frontmatter.id),
        primary_client_id: context.client?.frontmatter.id,
        primary_product_id: context.product?.frontmatter.id,
        primary_project_id: context.project?.frontmatter.id
      },
      body: noteBody
    });
    await ctx.writeAudit("meeting.created", meetingId, now, { external_id: externalId });
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
    const existing = this.findMeetingForEvent(event.externalId, event.calendarId);
    if (existing) return this.meetingWorkspace(existing.frontmatter.id);
    const now = new Date().toISOString();
    const synthetic = (type: ObjectEnvelope["type"], title: string): LifeOSObject => ({ frontmatter: { ...this.ctx.envelope(`preview:${type}:${externalId}:${title}`, type, title, now, "calendar") }, body: "", relativePath: "", contentHash: "" });
    const meeting: LifeOSObject = {
      frontmatter: { ...this.ctx.envelope(`preview:${externalId}`, "meeting", event.title, now, "calendar"), status: "scheduled", starts_at: event.startsAt, ends_at: event.endsAt, timezone: event.timezone, is_all_day: event.isAllDay ?? false },
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
    const meeting = this.ctx.required(meetingId, "meeting");
    const note = this.noteFor(meetingId);
    const reviews = index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.source_meeting_id === meetingId);
    const tasks = index.all().filter((object) => object.frontmatter.type === "task" && object.frontmatter.source_meeting_id === meetingId);
    const resolve = (value: unknown) => typeof value === "string" ? index.get(value) : undefined;
    const attendeeIds = Array.isArray(meeting.frontmatter.attendee_ids) ? meeting.frontmatter.attendee_ids : [];
    return {
      persisted: true as const,
      meeting,
      note,
      reviews,
      tasks,
      context: {
        project: resolve(meeting.frontmatter.primary_project_id),
        client: resolve(meeting.frontmatter.primary_client_id),
        product: resolve(meeting.frontmatter.primary_product_id),
        people: attendeeIds.map(resolve).filter((person): person is LifeOSObject => Boolean(person))
      }
    };
  }

  /**
   * Finds live meetings that share one calendar event (PB-004) and, with `apply`, archives every
   * copy but one together with its notes (`archived_at`, file kept, audited). The kept copy is the
   * one whose note has the most text, then the highest revision. A group where a second copy's note
   * also holds real text is reported for a manual merge and never archived automatically.
   */
  async reconcileDuplicateMeetings(options: { apply: boolean }) {
    const live = (object: LifeOSObject) => !object.frontmatter.deleted_at && !object.frontmatter.archived_at;
    const all = this.ctx.index.all();
    const notesOf = (meeting: LifeOSObject) => all.filter((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meeting.frontmatter.id && !object.frontmatter.archived_at);
    const realText = (note: LifeOSObject) => note.body.trim() !== "" && note.body !== DEFAULT_NOTE_BODY && note.body.trim() !== DEFAULT_NOTE_BODY.trim() ? note.body.trim().length : 0;
    const groups = new Map<string, LifeOSObject[]>();
    for (const meeting of all.filter((object) => object.frontmatter.type === "meeting" && live(object))) {
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
      const meeting = this.findMeetingForEvent(event.externalId, event.calendarId);
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
  private findMeetingForEvent(externalId: string, calendarId?: string) {
    const provider = this.ctx.calendar?.provider;
    return this.ctx.index.all().find((object) => object.frontmatter.type === "meeting" && !object.frontmatter.deleted_at && !object.frontmatter.archived_at &&
      Array.isArray(object.frontmatter.external_refs) &&
      object.frontmatter.external_refs.some((reference: unknown) => {
        if (typeof reference !== "object" || reference === null) return false;
        const ref = reference as { provider?: string; external_id?: string; calendar_id?: string };
        return ref.external_id === externalId &&
          (!provider || !ref.provider || ref.provider === provider) &&
          (!calendarId || !ref.calendar_id || ref.calendar_id === calendarId);
      }));
  }

  private noteFor(meetingId: string) {
    return this.ctx.index.all().find((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meetingId && !object.frontmatter.deleted_at);
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
    const existing = this.ctx.index.all().find((object) => object.frontmatter.type === type && object.frontmatter.title === title);
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
