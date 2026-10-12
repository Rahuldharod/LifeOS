import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DEFAULT_NOTE_BODY, markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { PeopleModule } from "./people.js";
import { operationKinds, type CalendarEvent, type CalendarEventReference, type Operation } from "./ports.js";
import { isLive, isMeetingRestricted, isRestricted, liveMeetingNote, OneAtATime, resolveObjectRedirect } from "./support.js";

type EventContext = { client?: LifeOSObject; product?: LifeOSObject; project?: LifeOSObject; people: LifeOSObject[] };

type MigrationCandidate = {
  noteId: string;
  meetingId: string;
  title: string;
  body: string;
  contentHash: string;
  occurrenceId: string;
  sectionId: string;
  originalStartsAt: string;
  startsAt: string;
};

type MigrationOperationCandidate = MigrationCandidate;

export type RecurringMigrationPreview = {
  seriesId?: string;
  requiresConfirmation: boolean;
  candidates: MigrationCandidate[];
};

export function recurrenceSeriesKey(provider: string, event: Pick<CalendarEvent, "calendarId" | "seriesId">) {
  return event.seriesId ? `${provider}:${event.calendarId ?? "default"}:${event.seriesId}` : undefined;
}

export function occurrenceSectionId(originalOccurrenceStartsAt: string) {
  return `occurrence-${originalOccurrenceStartsAt.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

export function recurrenceOccurrenceId(provider: string, event: Pick<CalendarEvent, "calendarId" | "seriesId" | "originalOccurrenceStartsAt">) {
  const series = recurrenceSeriesKey(provider, event);
  return series && event.originalOccurrenceStartsAt ? `${series}:${event.originalOccurrenceStartsAt}` : undefined;
}

export interface EnrichmentOccurrenceTarget {
  occurrenceId: string;
  sectionId: string;
}

function userNoteText(body: string) {
  const trimmed = body.trim();
  return trimmed && trimmed !== DEFAULT_NOTE_BODY.trim() ? trimmed : "";
}

/** ADR 0021: how many earlier occurrences with a live Note the Series view shows. */
export const SERIES_VIEW_EARLIER_LIMIT = 4;

/** What a Series view page needs to continue: the opened occurrence, plus the last entry already shown. */
type SeriesCursorBase = { s: string; p?: string; o: number; m: string; n?: string; a?: number; i?: string };
type SeriesViewPayload = { earlier: Array<{ kind: "occurrence" | "legacy-shared"; note: LifeOSObject; range: { startsAt: string; endsAt: string }; cancelled: boolean }>; nextCursor?: string; newer?: { meetingId: string; startsAt: string; endsAt: string; timezone: string } };
const encodeSeriesCursor = (cursor: SeriesCursorBase) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decodeSeriesCursor(value: string): SeriesCursorBase {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const text = (key: string) => typeof parsed[key] === "string" && parsed[key] !== "";
    const number = (key: string) => typeof parsed[key] === "number" && Number.isFinite(parsed[key]);
    if (!text("s") || !text("m") || !number("o") || (parsed.p !== undefined && !text("p")) || (parsed.n !== undefined && !text("n")) || (parsed.a !== undefined && !number("a")) || (parsed.i !== undefined && !text("i"))) throw new Error("shape");
    return parsed as SeriesCursorBase;
  } catch { throw new Error("Invalid Series view cursor"); }
}

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

  async recoverSeriesLinks(operation: Operation) {
    if (typeof operation.payload.seriesId !== "string" || typeof operation.payload.noteId !== "string") return;
    await this.repairSuccessorSeriesLinks(operation.payload.seriesId, operation.payload.noteId, typeof operation.payload.now === "string" ? operation.payload.now : new Date().toISOString(), operation);
  }

  /** ADR 0013 recovery of #153 resumes the recorded migration; it never rediscovers candidates. */
  async recoverRecurringMigration(operation: Operation) {
    await this.runRecurringMigration(operation);
  }

  /**
   * A migration candidate is credible only when its Meeting carries the provider series and immutable
   * occurrence identities. Similar titles, attendees and times are deliberately ignored (ADR 0019).
   * This is a pure read: rendering a preview or cancelling it changes nothing.
   */
  recurringMigrationPreview(meetingId: string): RecurringMigrationPreview {
    const meeting = this.ctx.required(meetingId, "meeting");
    const seriesId = typeof meeting.frontmatter.recurrence_series_id === "string" ? meeting.frontmatter.recurrence_series_id : undefined;
    if (!seriesId) return { seriesId, requiresConfirmation: false, candidates: [] };
    const shared = this.findSeriesNote(seriesId);
    const sharedSections = Array.isArray(shared?.frontmatter.occurrence_sections) ? shared.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
    const candidates = this.ctx.index.all()
      .filter((candidate): candidate is LifeOSObject => candidate.frontmatter.type === "meeting" && isLive(candidate)
        && candidate.frontmatter.recurrence_series_id === seriesId
        && typeof candidate.frontmatter.recurrence_occurrence_id === "string"
        && typeof candidate.frontmatter.original_occurrence_starts_at === "string")
      .flatMap((candidate) => {
        const notes = this.ctx.index.all().filter((object) => object.frontmatter.type === "meeting-note" && isLive(object)
          && object.frontmatter.meeting_id === candidate.frontmatter.id && !object.frontmatter.recurrence_series_id);
        // More than one legacy Note for a meeting is a real ambiguity, not an invitation to guess.
        if (notes.length !== 1) return [];
        const note = notes[0]!;
        const originalStartsAt = String(candidate.frontmatter.original_occurrence_starts_at);
        const occurrenceId = String(candidate.frontmatter.recurrence_occurrence_id);
        const sectionId = occurrenceSectionId(originalStartsAt);
        if (sharedSections.some((section) => section.occurrence_id === occurrenceId || section.section_id === sectionId)) return [];
        return [{
          noteId: note.frontmatter.id,
          meetingId: candidate.frontmatter.id,
          title: candidate.frontmatter.title,
          body: note.body,
          contentHash: note.contentHash,
          occurrenceId,
          sectionId,
          originalStartsAt,
          startsAt: typeof candidate.frontmatter.starts_at === "string" ? candidate.frontmatter.starts_at : originalStartsAt
        }];
      })
      .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt) || left.noteId.localeCompare(right.noteId));
    return { seriesId, requiresConfirmation: candidates.length > 0, candidates };
  }

  /** Explicit confirmation starts the only write path for migration. Every source hash is guarded. */
  async confirmRecurringMigration(meetingId: string, expectedHashes: Record<string, string>) {
    const requested = this.recurringMigrationPreview(meetingId);
    if (!requested.seriesId) throw new Error("There are no credible existing Notes to migrate");
    const seriesId = requested.seriesId;
    return this.meetingCreations.run(`migration:${seriesId}`, async () => {
      // Re-read after entering the one-at-a-time scope: a simultaneous confirmation may have won.
      const pending = (await this.ctx.objects.incompleteOperations?.() ?? []).find((operation) => operation.kind === operationKinds.migrateRecurringNotes && operation.payload.seriesId === seriesId);
      // A durable journal always wins over a fresh preview: it may already have created the target
      // but still need redirects or archives after an interruption.
      if (pending) return this.runRecurringMigration(pending);
      const preview = this.recurringMigrationPreview(meetingId);
      const existing = this.findSeriesNote(seriesId);
      if (!preview.candidates.length && existing) {
        await this.writeRecurringMigrationAudit(existing, seriesId, String(existing.frontmatter.updated_at));
        return existing;
      }
      if (!preview.candidates.length) throw new Error("There are no credible existing Notes to migrate");
      for (const candidate of preview.candidates) {
        if (expectedHashes[candidate.noteId] !== candidate.contentHash) throw new ObjectConflictError(`Migration preview is stale for Note ${candidate.noteId}`);
      }
      const now = new Date().toISOString();
      const operation = await this.ctx.objects.prepareOperation?.(operationKinds.migrateRecurringNotes, {
        seriesId,
        noteId: existing?.frontmatter.id ?? uuidV7(),
        title: `${this.ctx.required(meetingId, "meeting").frontmatter.title} notes`,
        now,
        candidates: preview.candidates
      }, uuidV7());
      if (!operation) throw new Error("The ObjectStore does not support crash-safe recurring Note migration");
      return this.runRecurringMigration(operation);
    });
  }

  private migrationCandidates(operation: Operation): MigrationOperationCandidate[] {
    const raw = Array.isArray(operation.payload.candidates) ? operation.payload.candidates : [];
    return raw.flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const candidate = value as Record<string, unknown>;
      const strings = ["noteId", "meetingId", "title", "body", "contentHash", "occurrenceId", "sectionId", "originalStartsAt", "startsAt"] as const;
      if (!strings.every((key) => typeof candidate[key] === "string")) return [];
      return [{
        noteId: candidate.noteId as string, meetingId: candidate.meetingId as string, title: candidate.title as string, body: candidate.body as string, contentHash: candidate.contentHash as string,
        occurrenceId: candidate.occurrenceId as string, sectionId: candidate.sectionId as string,
        originalStartsAt: candidate.originalStartsAt as string, startsAt: candidate.startsAt as string
      }];
    });
  }

  /**
   * The journal payload is the migration's immutable plan. Recovery uses it rather than current
   * titles, attendees or calendar data, so an interrupted operation cannot change its meaning.
   */
  private async runRecurringMigration(operation: Operation) {
    const seriesId = typeof operation.payload.seriesId === "string" ? operation.payload.seriesId : undefined;
    const noteId = typeof operation.payload.noteId === "string" ? operation.payload.noteId : undefined;
    const title = typeof operation.payload.title === "string" ? operation.payload.title : undefined;
    const now = typeof operation.payload.now === "string" ? operation.payload.now : new Date().toISOString();
    const candidates = this.migrationCandidates(operation);
    if (!seriesId || !noteId || !title || !candidates.length) throw new Error("Invalid recurring Note migration operation");

    const ordered = [...candidates].sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt) || left.noteId.localeCompare(right.noteId));
    for (const candidate of ordered) this.assertMigrationSource(candidate, noteId);
    const restricted = ordered.some((candidate) => isRestricted(this.ctx.index.get(candidate.noteId)) || isRestricted(this.ctx.index.get(candidate.meetingId)));
    let target = this.ctx.index.get(noteId);
    const creatingTarget = !target;
    if (!target) {
      const occurrenceSections = ordered.map((candidate) => ({
        occurrence_id: candidate.occurrenceId,
        section_id: candidate.sectionId,
        meeting_id: candidate.meetingId,
        original_starts_at: candidate.originalStartsAt,
        starts_at: candidate.startsAt
      }));
      const body = ordered.map((candidate) => this.recurringSectionBody({ title: candidate.title, startsAt: candidate.startsAt } as CalendarEvent, candidate.sectionId, candidate.body)).join("\n\n");
      const first = ordered[0]!;
      target = await this.ctx.replaying([noteId], () => this.ctx.objects.write({
        relativePath: `meetings/${markdownFileName(title, noteId, first.startsAt)}`,
        frontmatter: {
          ...this.ctx.envelope(noteId, "meeting-note", title, now),
          meeting_id: first.meetingId,
          meeting_ids: ordered.map((candidate) => candidate.meetingId),
          recurrence_series_id: seriesId,
          occurrence_sections: occurrenceSections,
          ...(restricted ? { sensitivity: "restricted" } : {})
        },
        body
      }));
      await this.ctx.rebuildIndex();
      target = this.ctx.required(noteId, "meeting-note");
    }
    if (target.frontmatter.type !== "meeting-note" || target.frontmatter.recurrence_series_id !== seriesId) throw new Error(`Migration Note ${noteId} does not match its recorded series`);

    // A pre-existing shared Note is a valid target. Add only sections that are not already
    // represented by a prior replay; an occupied occurrence is otherwise ambiguous and stays unresolved.
    const existingSections = Array.isArray(target.frontmatter.occurrence_sections) ? target.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
    let updatedBody = target.body;
    let updatedSections = existingSections;
    const existingMeetingIds = [...new Set([
      ...(Array.isArray(target.frontmatter.meeting_ids) ? target.frontmatter.meeting_ids.filter((id): id is string => typeof id === "string") : []),
      ...(typeof target.frontmatter.meeting_id === "string" ? [target.frontmatter.meeting_id] : [])
    ])];
    const meetingIds = [...new Set([...existingMeetingIds, ...ordered.map((candidate) => candidate.meetingId)])];
    for (const candidate of creatingTarget ? [] : ordered) {
      const alreadyPresent = updatedSections.find((section) => section.occurrence_id === candidate.occurrenceId || section.section_id === candidate.sectionId);
      const section = { occurrence_id: candidate.occurrenceId, section_id: candidate.sectionId, meeting_id: candidate.meetingId, original_starts_at: candidate.originalStartsAt, starts_at: candidate.startsAt };
      const sectionBody = this.recurringSectionBody({ title: candidate.title, startsAt: candidate.startsAt } as CalendarEvent, candidate.sectionId, candidate.body);
      if (alreadyPresent) {
        // A crash may have saved the target section before saving its source redirect. Its exact
        // recorded body proves this journal already performed that durable step; a different body
        // is an ambiguous external collision and must never be merged or archived.
        if (!this.isRecordedMigrationSection(alreadyPresent, section, updatedBody, sectionBody)) throw new ObjectConflictError(`Recurring occurrence ${candidate.occurrenceId} is already present in Note ${noteId}`);
        continue;
      }
      const inserted = this.insertRecurringSection(updatedBody, updatedSections, sectionBody, section);
      updatedBody = inserted.body;
      updatedSections = inserted.sections;
    }
    const targetNeedsUpdate = updatedBody !== target.body || updatedSections.length !== existingSections.length || meetingIds.length !== existingMeetingIds.length || (restricted && target.frontmatter.sensitivity !== "restricted");
    if (targetNeedsUpdate) {
      target = await this.ctx.update(target, { meeting_ids: meetingIds, occurrence_sections: updatedSections, ...(restricted ? { sensitivity: "restricted" } : {}) }, { expectedHash: target.contentHash, now, body: updatedBody });
      await this.ctx.rebuildIndex();
      target = this.ctx.required(noteId, "meeting-note");
    }

    // Redirects land before archives. Each source file remains intact; only its envelope gains a link.
    for (const candidate of ordered) {
      this.assertMigrationSource(candidate, noteId);
      const source = this.ctx.index.get(candidate.noteId);
      if (!source || source.frontmatter.type !== "meeting-note") throw new Error(`Migration source Note is missing: ${candidate.noteId}`);
      if (source.frontmatter.redirect_to_note_id !== noteId || source.frontmatter.redirect_to_section_id !== candidate.sectionId) {
        await this.ctx.update(source, { redirect_to_note_id: noteId, redirect_to_section_id: candidate.sectionId }, { expectedHash: source.contentHash, now });
      }
    }
    await this.ctx.rebuildIndex();
    for (const candidate of ordered) {
      const sourceMeeting = this.ctx.index.get(candidate.meetingId);
      if (!sourceMeeting || sourceMeeting.frontmatter.type !== "meeting") throw new Error(`Migration source Meeting is missing: ${candidate.meetingId}`);
      if (sourceMeeting.frontmatter.redirect_to_section_id !== candidate.sectionId) {
        await this.ctx.update(sourceMeeting, { redirect_to_section_id: candidate.sectionId }, { expectedHash: sourceMeeting.contentHash, now });
      }
    }
    await this.ctx.rebuildIndex();
    // Archiving happens only after target and all redirect records are durable.
    for (const candidate of ordered) {
      this.assertMigrationSource(candidate, noteId);
      const source = this.ctx.index.get(candidate.noteId);
      if (!source || source.frontmatter.type !== "meeting-note") throw new Error(`Migration source Note is missing: ${candidate.noteId}`);
      if (!source.frontmatter.archived_at) await this.ctx.update(source, { archived_at: now, archived_reason: `Migrated to Recurring Meeting Note ${noteId}` }, { expectedHash: source.contentHash, now });
    }
    await this.ctx.rebuildIndex();
    await this.ctx.objects.completeOperation?.(operation.id);
    await this.writeRecurringMigrationAudit(target, seriesId, now, operation.id);
    return this.ctx.required(noteId, "meeting-note");
  }

  private async writeRecurringMigrationAudit(target: LifeOSObject, seriesId: string, now: string, operationId?: string) {
    const sourceNoteIds = this.ctx.index.all()
      .filter((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.redirect_to_note_id === target.frontmatter.id && object.frontmatter.archived_at)
      .map((object) => object.frontmatter.id)
      .sort();
    await this.ctx.writeAuditOnce("meeting-note.migrated", target.frontmatter.id, now, {
      ...(operationId ? { operation_id: operationId } : {}),
      series_id: seriesId,
      source_note_ids: sourceNoteIds
    }, { matchOn: ["source_note_ids"] });
  }

  /** A replay must never archive text which was not copied into its recorded target section. */
  private assertMigrationSource(candidate: MigrationOperationCandidate, targetNoteId: string) {
    const source = this.ctx.index.get(candidate.noteId);
    if (!source || source.frontmatter.type !== "meeting-note") throw new Error(`Migration source Note is missing: ${candidate.noteId}`);
    if (source.body !== candidate.body) throw new ObjectConflictError(`Migration source Note ${candidate.noteId} changed after confirmation`);
    const redirectedHere = source.frontmatter.redirect_to_note_id === targetNoteId && source.frontmatter.redirect_to_section_id === candidate.sectionId;
    if (redirectedHere) return;
    if (source.frontmatter.redirect_to_note_id || source.frontmatter.redirect_to_section_id) throw new ObjectConflictError(`Migration source Note ${candidate.noteId} has a conflicting redirect`);
    if (source.contentHash !== candidate.contentHash) throw new ObjectConflictError(`Migration source Note ${candidate.noteId} changed after confirmation`);
  }

  /** Confirms that an occupied target section is exactly the durable write from this journal. */
  private isRecordedMigrationSection(actual: Record<string, unknown>, expected: Record<string, string>, body: string, expectedBody: string) {
    if (!Object.entries(expected).every(([key, value]) => actual[key] === value)) return false;
    const anchor = `<a id="${expected.section_id}"></a>`;
    const anchorAt = body.indexOf(anchor);
    if (anchorAt < 0) return false;
    const headingAt = body.lastIndexOf("## ", anchorAt);
    if (headingAt < 0) return false;
    // Section boundaries are generated occurrence anchors, not Markdown headings inside a user's body.
    const followingAnchor = body.indexOf('<a id="occurrence-', anchorAt + anchor.length);
    const end = followingAnchor < 0 ? body.length : body.lastIndexOf("## ", followingAnchor);
    if (end < headingAt) return false;
    return body.slice(headingAt, end).trimEnd() === expectedBody.trimEnd();
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
    return occurrenceId && event.originalOccurrenceStartsAt ? { occurrenceId, sectionId: occurrenceSectionId(event.originalOccurrenceStartsAt) } : undefined;
  }

  /** Recurrence target already stored on an occurrence Meeting. */
  enrichmentOccurrenceForMeeting(meeting: LifeOSObject): EnrichmentOccurrenceTarget | undefined {
    const occurrenceId = typeof meeting.frontmatter.recurrence_occurrence_id === "string" ? meeting.frontmatter.recurrence_occurrence_id : undefined;
    const original = typeof meeting.frontmatter.original_occurrence_starts_at === "string" ? meeting.frontmatter.original_occurrence_starts_at : undefined;
    return occurrenceId && original ? { occurrenceId, sectionId: occurrenceSectionId(original) } : undefined;
  }

  /** Explicit enrichment may materialize an otherwise empty occurrence section when material was found. */
  async ensureOccurrenceSectionForEnrichment(meeting: LifeOSObject, from: Date, to: Date, calendarId: string | undefined, noteId: string) {
    const target = this.enrichmentOccurrenceForMeeting(meeting);
    if (!target) return undefined;
    const refs = Array.isArray(meeting.frontmatter.external_refs) ? meeting.frontmatter.external_refs as Array<Record<string, unknown>> : [];
    const externalId = refs.find((ref) => typeof ref.external_id === "string")?.external_id;
    if (typeof externalId !== "string") throw new Error(`Recurring meeting ${meeting.frontmatter.id} has no Calendar occurrence reference`);
    const workspace = await this.createMeetingFromEvent(externalId, from, to, calendarId, "", noteId);
    return { note: workspace.note, target };
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
      let existingNote = this.noteFor(existing.frontmatter.id);
      if (!existingNote) {
        // Either finishing an interrupted create-meeting operation, or a meeting that has no note
        // yet (the PB-020 flow, or a meeting created before it): create the note now.
        const recoveredNoteId = pendingOperation && typeof pendingOperation.payload.noteId === "string" ? pendingOperation.payload.noteId : preferredNoteId ?? uuidV7();
        const recoveredBody = initialBody ?? (typeof pendingOperation?.payload.body === "string" ? pendingOperation.payload.body : DEFAULT_NOTE_BODY);
        existingNote = await this.attachOrCreateNote(event, existing, recoveredNoteId, recoveredBody, context, now);
      } else {
        existingNote = await this.followCalendarTitle(existingNote, event, now);
      }
      await this.enrichMeetingContext(existing, context, now);
      if (existingNote?.frontmatter.recurrence_series_id) await this.repairSuccessorSeriesLinks(String(existingNote.frontmatter.recurrence_series_id), existingNote.frontmatter.id, now, undefined, existingNote);
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
    const note = await this.attachOrCreateNote(event, meeting, noteId, noteBody, context, now);
    if (note.frontmatter.recurrence_series_id) await this.repairSuccessorSeriesLinks(String(note.frontmatter.recurrence_series_id), note.frontmatter.id, now, undefined, note);
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
    const occurrenceItems = note ? this.occurrenceItems(note) : [];
    const seriesView = this.seriesView(meeting);
    return {
      persisted: true as const,
      meeting,
      note,
      reviews,
      tasks,
      ...(redirect.sectionId ? { noteSectionId: redirect.sectionId } : {}),
      ...(note ? { recurringMigration: this.recurringMigrationPreview(resolvedMeetingId) } : {}),
      ...(occurrenceItems.length ? { occurrences: occurrenceItems } : {}),
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
  private seriesView(opened: LifeOSObject): SeriesViewPayload | undefined {
    const seriesId = opened.frontmatter.recurrence_series_id;
    if (typeof seriesId !== "string") return undefined;
    const base: SeriesCursorBase = {
      s: seriesId,
      ...(typeof opened.frontmatter.previous_recurrence_series_id === "string" ? { p: opened.frontmatter.previous_recurrence_series_id } : {}),
      o: this.seriesAnchor(opened),
      m: opened.frontmatter.id,
      ...(this.noteFor(opened.frontmatter.id) ? { n: this.noteFor(opened.frontmatter.id)!.frontmatter.id } : {})
    };
    const newer = this.newerSeriesOccurrence(base);
    return { ...this.seriesViewPageFor(base), ...(newer ? { newer } : {}) };
  }

  /** "Load older": the page after `cursor`. The cursor is self-contained, so it also serves a not-yet-stored occurrence. */
  async seriesViewPage(cursor: string) {
    return this.seriesViewPageFor(decodeSeriesCursor(cursor));
  }

  private seriesAnchor(meeting: LifeOSObject) {
    return Date.parse(String(meeting.frontmatter.original_occurrence_starts_at ?? meeting.frontmatter.starts_at));
  }

  private seriesChain(base: SeriesCursorBase) {
    const { index } = this.ctx;
    const chain = [base.s];
    let next = base.p;
    while (next && !chain.includes(next)) {
      chain.push(next);
      const current: string = next;
      const carrier = index.all().find((meeting) => meeting.frontmatter.type === "meeting" && isLive(meeting) && meeting.frontmatter.recurrence_series_id === current && typeof meeting.frontmatter.previous_recurrence_series_id === "string");
      next = carrier ? String(carrier.frontmatter.previous_recurrence_series_id) : undefined;
    }
    return chain;
  }

  private newerSeriesOccurrence(base: SeriesCursorBase) {
    let latest: LifeOSObject | undefined;
    for (const meeting of this.ctx.index.all()) {
      if (meeting.frontmatter.type !== "meeting" || !isLive(meeting) || meeting.frontmatter.recurrence_series_id !== base.s || meeting.frontmatter.id === base.m) continue;
      if (this.seriesAnchor(meeting) <= base.o || !this.noteFor(meeting.frontmatter.id)) continue;
      if (!latest || this.seriesAnchor(meeting) > this.seriesAnchor(latest)) latest = meeting;
    }
    return latest ? { meetingId: latest.frontmatter.id, startsAt: String(latest.frontmatter.starts_at), endsAt: String(latest.frontmatter.ends_at), timezone: String(latest.frontmatter.timezone) } : undefined;
  }

  private seriesViewPageFor(base: SeriesCursorBase) {
    const { index } = this.ctx;
    const chain = new Set(this.seriesChain(base));
    const liveSeriesMeeting = (candidate: LifeOSObject | undefined): candidate is LifeOSObject =>
      candidate?.frontmatter.type === "meeting" && isLive(candidate) && typeof candidate.frontmatter.recurrence_series_id === "string" && chain.has(candidate.frontmatter.recurrence_series_id);
    const notes = new Map<string, LifeOSObject>();
    for (const meeting of index.all()) {
      if (!liveSeriesMeeting(meeting) || meeting.frontmatter.id === base.m) continue;
      const note = this.noteFor(meeting.frontmatter.id);
      if (note && note.frontmatter.id !== base.n) notes.set(note.frontmatter.id, note);
    }
    const entries = [...notes.values()].flatMap((note) => {
      const linkedIds = Array.isArray(note.frontmatter.meeting_ids) ? note.frontmatter.meeting_ids.filter((id): id is string => typeof id === "string") : [];
      const legacyShared = linkedIds.length > 1 || Array.isArray(note.frontmatter.occurrence_sections);
      const linkedMeetings = (legacyShared ? linkedIds : [String(note.frontmatter.meeting_id)]).map((id) => index.get(id)).filter(liveSeriesMeeting);
      const earlierMeetings = linkedMeetings.filter((meeting) => meeting.frontmatter.id !== base.m && this.seriesAnchor(meeting) < base.o);
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
          cancelled: !legacyShared && first.frontmatter.status === "cancelled"
        }
      }];
    });
    entries.sort((left, right) => right.newestEarlierAnchor - left.newestEarlierAnchor || left.entry.note.frontmatter.id.localeCompare(right.entry.note.frontmatter.id));
    const remaining = base.a === undefined || base.i === undefined ? entries : entries.filter(({ newestEarlierAnchor, entry }) => newestEarlierAnchor < base.a! || (newestEarlierAnchor === base.a && entry.note.frontmatter.id > base.i!));
    const page = remaining.slice(0, SERIES_VIEW_EARLIER_LIMIT);
    const lastShown = page[page.length - 1];
    const more = remaining.length > page.length && lastShown;
    return {
      earlier: page.map(({ entry }) => entry),
      ...(more ? { nextCursor: encodeSeriesCursor({ ...base, a: lastShown.newestEarlierAnchor, i: lastShown.entry.note.frontmatter.id }) } : {})
    };
  }

  private occurrenceItems(note: LifeOSObject) {
    const { index } = this.ctx;
    const sections = Array.isArray(note.frontmatter.occurrence_sections) ? note.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
    const resolve = (value: unknown) => typeof value === "string" ? index.get(value) : undefined;
    return sections.flatMap((section) => {
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

  /** One shared sensitivity covers stored and not-yet-materialized occurrences in the provider series. */
  isEventRestricted(event: CalendarEvent) {
    const meeting = this.findMeetingForEvent(event.externalId, event.calendarId, event);
    const notes = this.ctx.index.all().filter((object) => object.frontmatter.type === "meeting-note" && !object.frontmatter.deleted_at);
    if (isMeetingRestricted(meeting, notes)) return true;
    const seriesId = this.seriesKey(event);
    return Boolean(seriesId && notes.some((note) => note.frontmatter.recurrence_series_id === seriesId && isRestricted(note)));
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

  private occurrenceSection(event: CalendarEvent, meetingId: string) {
    const occurrenceId = this.occurrenceId(event)!;
    return {
      occurrence_id: occurrenceId,
      section_id: occurrenceSectionId(event.originalOccurrenceStartsAt!),
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
