import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";

/** Body for a meeting note created without user text (legacy callers and crash recovery of old operations). */
const DEFAULT_NOTE_BODY = "# Notes\n\n";

/** An identical failed sync within this window does not write another Sync Run file (PB-022a). */
const FAILED_SYNC_RUN_THROTTLE_MS = 60 * 60 * 1000;

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled";
}

/** Lowercase and strip accents so "reunion" finds "Réunion". */
function foldForSearch(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function timestampPrefix(timestamp: string, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}-${part("hour")}${part("minute")}`;
}

function markdownFileName(title: string, id: string, timestamp: string, timeZone = "UTC") {
  return `${timestampPrefix(timestamp, timeZone)}-${slugify(title)}--${id}.md`;
}

export interface ObjectStore {
  list(): Promise<LifeOSObject[]>;
  scan?(): Promise<{ objects: LifeOSObject[]; diagnostics: string[] }>;
  read(relativePath: string): Promise<LifeOSObject>;
  write(input: { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string }): Promise<LifeOSObject>;
  prepareOperation?(kind: string, payload: Record<string, unknown>, operationId: string): Promise<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>;
  completeOperation?(operationId: string): Promise<void>;
  incompleteOperations?(): Promise<Array<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>>;
}

export interface IndexStore {
  rebuild(objects: LifeOSObject[], diagnostics?: string[]): void;
  all(): LifeOSObject[];
  get(id: string): LifeOSObject | undefined;
  diagnostics(): string[];
}

export interface CalendarConnector {
  readonly provider?: string;
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
  /** Every calendar the account can view, whether or not it has events in a given range. */
  listCalendars?(): Promise<CalendarSummary[]>;
}

export interface CalendarPreferences {
  disabledCalendarIds: string[];
  defaultCalendarId?: string;
  /** Hash of the stored file; absent until the preferences are first saved. Send it back as the expected hash. */
  contentHash?: string;
}

/** Same name as the object store's conflict error, which the server maps to HTTP 409 (the application cannot import adapters). */
class SettingsConflictError extends Error { override name = "ObjectConflictError"; }

const calendarPreferencesPath = "settings/calendar-preferences.md";

function preferencesFrom(frontmatter: ObjectEnvelope): Omit<CalendarPreferences, "contentHash"> {
  const disabled = frontmatter.disabled_calendar_ids;
  const defaultId = frontmatter.default_calendar_id;
  return {
    disabledCalendarIds: Array.isArray(disabled) ? disabled.filter((id): id is string => typeof id === "string") : [],
    ...(typeof defaultId === "string" && defaultId ? { defaultCalendarId: defaultId } : {})
  };
}

export interface CalendarSummary {
  id: string;
  name: string;
  color?: string;
}

export interface CalendarEvent {
  externalId: string;
  calendarId?: string;
  calendarName?: string;
  calendarColor?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  isAllDay?: boolean;
  attendees: string[];
  clientName?: string;
  productName?: string;
  projectName?: string;
  hasNote?: boolean;
  meetingId?: string;
  noteId?: string;
}

export interface AiProvider {
  proposeMeetingOutputs(note: string): Promise<Array<{ type: "task" | "decision" | "open-point"; title: string; confidence: "High" | "Medium" | "Low" }>>;
  proposeKnowledgeNote?(source: string): Promise<{ title: string; body: string; confidence: "High" | "Medium" | "Low" }>;
}

export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
  set(reference: string, value: string): Promise<void>;
}

export class LifeOSApplication {
  /** In-flight `createMeetingFromEvent` calls, keyed by calendar event id (PB-004). */
  private readonly meetingCreations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly objects: ObjectStore,
    private readonly index: IndexStore,
    private readonly calendar?: CalendarConnector,
    private readonly ai?: AiProvider,
    private readonly deviceId = "local-development"
  ) {}

  async rebuildIndex() {
    const scan = this.objects.scan ? await this.objects.scan() : { objects: await this.objects.list(), diagnostics: [] };
    const objects = scan.objects;
    this.index.rebuild(objects, scan.diagnostics);
    return { objectCount: objects.length, diagnostics: this.index.diagnostics() };
  }

  async health() {
    return { status: this.index.diagnostics().length ? "attention" : "healthy", objectCount: this.index.all().length, diagnostics: this.index.diagnostics() };
  }

  async recoverOperations() {
    const incomplete = await this.objects.incompleteOperations?.() ?? [];
    const recovered: string[] = [];
    for (const operation of incomplete) {
      if (operation.kind === "accept-review" && typeof operation.payload.reviewId === "string") {
        await this.acceptReviewItem(operation.payload.reviewId);
        recovered.push(operation.id);
      } else if (operation.kind === "create-meeting" && typeof operation.payload.externalId === "string" && this.calendar) {
        await this.createMeetingFromEvent(operation.payload.externalId);
        recovered.push(operation.id);
      }
    }
    return recovered;
  }

  async listObjects() {
    return this.index.all().map(({ frontmatter, relativePath, contentHash }) => ({ frontmatter, relativePath, contentHash }));
  }

  notes() {
    return this.index.all()
      .filter((object) => ["meeting-note", "knowledge-note"].includes(object.frontmatter.type) && !object.frontmatter.deleted_at && !object.frontmatter.archived_at)
      .sort((left, right) => Date.parse(right.frontmatter.updated_at) - Date.parse(left.frontmatter.updated_at));
  }

  /** Tombstoned notes (PB-021), most recently deleted first. */
  deletedNotes() {
    return this.index.all()
      .filter((object) => ["meeting-note", "knowledge-note"].includes(object.frontmatter.type) && object.frontmatter.deleted_at && !object.frontmatter.archived_at)
      .sort((left, right) => Date.parse(String(right.frontmatter.deleted_at)) - Date.parse(String(left.frontmatter.deleted_at)));
  }

  /**
   * Keyword search over the in-memory index (PB-025): a note matches when every word of `query`
   * appears in its title or body, ignoring case and accents. It never touches the filesystem, so
   * cost depends on the notes already loaded, not on the folder. A blank query returns the whole tab.
   */
  searchNotes(query: string, state: "open" | "deleted" = "open") {
    const notes = state === "deleted" ? this.deletedNotes() : this.notes();
    const words = foldForSearch(query).split(/\s+/).filter(Boolean);
    if (!words.length) return notes;
    return notes.filter((note) => {
      const text = foldForSearch(`${note.frontmatter.title}\n${note.body}`);
      return words.every((word) => text.includes(word));
    });
  }

  object(id: string) {
    return this.required(id);
  }

  entities(type: "task" | "project" | "client" | "product" | "person") {
    return this.index.all().filter((object) => object.frontmatter.type === type && !object.frontmatter.deleted_at);
  }

  async createEntity(type: "task" | "project" | "client" | "product" | "person", fields: Record<string, unknown>) {
    const title = typeof fields.title === "string" ? fields.title.trim() : "";
    if (!title) throw new Error("Title is required");
    const now = new Date().toISOString();
    const id = uuidV7();
    const folders = { task: "tasks", project: "projects", client: "clients", product: "products", person: "people" } as const;
    const allowed: Record<typeof type, string[]> = {
      task: ["status", "priority", "owner_person_id", "waiting_for_person_id", "expected_output", "due_on", "due_at", "due_timezone", "dependency_ids", "primary_project_id", "primary_client_id", "primary_product_id"],
      project: ["status", "objective", "success_criteria", "owner_person_id", "primary_client_id", "primary_product_id", "start_on", "target_end_on"],
      client: ["status", "summary", "website_url", "primary_contact_person_id"],
      product: ["status", "description", "owner_person_id"],
      person: ["given_name", "family_name", "organization_name", "job_title", "timezone", "is_self"]
    };
    const selected = Object.fromEntries(Object.entries(fields).filter(([key, value]) => allowed[type].includes(key) && value !== "" && value !== undefined));
    if (type === "task") {
      selected.status ??= "Inbox";
      selected.owner_person_id ??= (await this.ensureSelfPerson(now)).frontmatter.id;
    } else if (type === "person") {
      selected.given_name ??= title.split(/\s+/)[0];
    } else {
      selected.status ??= "active";
    }
    const created = await this.objects.write({ relativePath: `${folders[type]}/${markdownFileName(title, id, now)}`, frontmatter: { ...this.envelope(id, type, title, now), ...selected }, body: `# ${title}\n` });
    await this.writeAudit(`${type}.created`, id, now, {});
    await this.rebuildIndex();
    return created;
  }

  async updateEntity(id: string, fields: Record<string, unknown>, expectedHash: string) {
    const current = this.required(id);
    if (!["task", "project", "client", "product", "person"].includes(current.frontmatter.type)) throw new Error("Object type is not editable through this workspace");
    const type = current.frontmatter.type as "task" | "project" | "client" | "product" | "person";
    const allowed: Record<typeof type, string[]> = {
      task: ["title", "status", "priority", "owner_person_id", "waiting_for_person_id", "expected_output", "due_on", "due_at", "due_timezone", "dependency_ids", "primary_project_id", "primary_client_id", "primary_product_id"],
      project: ["title", "status", "objective", "success_criteria", "owner_person_id", "primary_client_id", "primary_product_id", "start_on", "target_end_on", "completed_at"],
      client: ["title", "status", "summary", "website_url", "primary_contact_person_id"],
      product: ["title", "status", "description", "owner_person_id"],
      person: ["title", "given_name", "family_name", "organization_name", "job_title", "timezone", "is_self"]
    };
    const selected = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed[type].includes(key)));
    if (typeof selected.title === "string" && !selected.title.trim()) throw new Error("Title is required");
    const now = new Date().toISOString();
    if (type === "task") {
      if (selected.status === "Done") selected.completed_at = now; else if (selected.status) selected.completed_at = undefined;
      if (selected.status === "Cancelled") selected.cancelled_at = now; else if (selected.status) selected.cancelled_at = undefined;
      if (selected.status && selected.status !== "Waiting") selected.waiting_for_person_id = undefined;
    }
    const updated = await this.objects.write({ relativePath: current.relativePath, expectedHash, frontmatter: { ...current.frontmatter, ...selected, revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId }, body: current.body });
    await this.writeAudit(`${type}.updated`, id, now, { fields: Object.keys(selected) });
    await this.rebuildIndex();
    return updated;
  }

  async deleteEntity(id: string, expectedHash: string) {
    const current = this.required(id);
    if (!["task", "project", "client", "product", "person"].includes(current.frontmatter.type)) throw new Error("Object type cannot be deleted through this workspace");
    if (current.frontmatter.type === "person" && current.frontmatter.is_self === true) throw new Error("The self person cannot be deleted");
    const now = new Date().toISOString();
    const updated = await this.objects.write({ relativePath: current.relativePath, expectedHash, frontmatter: { ...current.frontmatter, deleted_at: now, revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId }, body: current.body });
    await this.writeAudit(`${current.frontmatter.type}.deleted`, id, now, {});
    await this.rebuildIndex();
    return updated;
  }

  async listCalendarEvents(from = new Date(), to = new Date(Date.now() + 7 * 86_400_000)) {
    if (!this.calendar) throw new Error("Calendar connector is not configured");
    return this.withNoteLinks(await this.calendar.listEvents(from, to));
  }

  async listCalendars() {
    if (!this.calendar) throw new Error("Calendar connector is not configured");
    return this.calendar.listCalendars ? this.calendar.listCalendars() : [];
  }

  /** Synced calendar preferences (ADR 0005). One fixed file, read from disk so another device's edit is seen at once. */
  async getCalendarPreferences(): Promise<CalendarPreferences> {
    const current = await this.readSetting(calendarPreferencesPath);
    return current ? { ...preferencesFrom(current.frontmatter), contentHash: current.contentHash } : { disabledCalendarIds: [] };
  }

  async saveCalendarPreferences(input: { disabledCalendarIds: string[]; defaultCalendarId?: string }, expectedHash?: string): Promise<CalendarPreferences> {
    const disabled = [...new Set(input.disabledCalendarIds.filter((id) => typeof id === "string" && id))];
    const defaultId = input.defaultCalendarId || undefined;
    const current = await this.readSetting(calendarPreferencesPath);
    const now = new Date().toISOString();
    if (current && current.contentHash !== expectedHash) throw new SettingsConflictError("Calendar preferences changed on another device; reload and try again");
    if (!current && expectedHash) throw new SettingsConflictError("Calendar preferences were removed; reload and try again");
    const kept: Record<string, unknown> = { ...current?.frontmatter };
    delete kept.default_calendar_id;
    const id = current?.frontmatter.id ?? uuidV7();
    const written = await this.objects.write({
      relativePath: calendarPreferencesPath,
      expectedHash: current?.contentHash,
      frontmatter: {
        ...kept,
        ...(current ? { revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId } : this.envelope(id, "app-setting", "Calendar preferences", now)),
        setting_key: "calendar-preferences",
        disabled_calendar_ids: disabled,
        ...(defaultId ? { default_calendar_id: defaultId } : {})
      } as ObjectEnvelope,
      body: "# Calendar preferences\n\nWhich calendars the Calendar view offers, and which one opens by default.\n"
    });
    await this.rebuildIndex();
    return { ...preferencesFrom(written.frontmatter), contentHash: written.contentHash };
  }

  private async readSetting(relativePath: string) {
    try { return await this.objects.read(relativePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async syncCalendar(from = new Date(), to = new Date(Date.now() + 7 * 86_400_000)) {
    if (!this.calendar) throw new Error("Calendar connector is not configured");
    const started = new Date().toISOString();
    try {
      const events = await this.calendar.listEvents(from, to);
      if (this.calendar.provider === "google") await this.writeSyncRun("succeeded", started, events.length);
      return this.withNoteLinks(events);
    } catch (error) {
      // Recording the failure must never mask the connector error the user needs to see.
      if (this.calendar.provider === "google") await this.writeSyncRun("failed", started, 0, error instanceof Error ? error.message : "Unknown error").catch(() => undefined);
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

  private async createMeetingFromEventSerialized(externalId: string, from?: Date, to?: Date, calendarId?: string, initialBody?: string) {
    const events = await this.listCalendarEvents(from, to);
    const event = events.find((candidate) => candidate.externalId === externalId && (!calendarId || candidate.calendarId === calendarId));
    if (!event) throw new Error(`Calendar event not found: ${externalId}`);
    const now = new Date().toISOString();
    const context = await this.ensureEventContext(event, now);
    const pendingOperation = (await this.objects.incompleteOperations?.() ?? []).find((operation) => operation.kind === "create-meeting" && operation.payload.externalId === externalId);
    const existing = this.findMeetingForEvent(event.externalId, event.calendarId);
    if (existing) {
      const existingNote = this.index.all().find((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === existing.frontmatter.id && !object.frontmatter.deleted_at);
      if (!existingNote) {
        // Either finishing an interrupted create-meeting operation, or a meeting that has no note
        // yet (the PB-020 flow, or a meeting created before it): create the note now.
        const recoveredNoteId = pendingOperation && typeof pendingOperation.payload.noteId === "string" ? pendingOperation.payload.noteId : uuidV7();
        const recoveredBody = initialBody ?? (typeof pendingOperation?.payload.body === "string" ? pendingOperation.payload.body : DEFAULT_NOTE_BODY);
        await this.objects.write({ relativePath: `meetings/${markdownFileName(`${event.title} notes`, recoveredNoteId, event.startsAt, event.timezone)}`, frontmatter: { ...this.envelope(recoveredNoteId, "meeting-note", `${event.title} notes`, now), meeting_id: existing.frontmatter.id, people_ids: context.people.map((person) => person.frontmatter.id), primary_client_id: context.client?.frontmatter.id, primary_product_id: context.product?.frontmatter.id, primary_project_id: context.project?.frontmatter.id }, body: recoveredBody });
      }
      await this.enrichMeetingContext(existing, context, now);
      if (pendingOperation) await this.objects.completeOperation?.(pendingOperation.id);
      await this.rebuildIndex();
      return this.meetingWorkspace(existing.frontmatter.id);
    }

    const operationId = pendingOperation?.id ?? uuidV7();
    const operation = pendingOperation ?? await this.objects.prepareOperation?.("create-meeting", { externalId, meetingId: uuidV7(), noteId: uuidV7(), body: initialBody ?? DEFAULT_NOTE_BODY }, operationId);
    const meetingId = typeof operation?.payload.meetingId === "string" ? operation.payload.meetingId : uuidV7();
    const noteId = typeof operation?.payload.noteId === "string" ? operation.payload.noteId : uuidV7();
    const noteBody = initialBody ?? (typeof operation?.payload.body === "string" ? operation.payload.body : DEFAULT_NOTE_BODY);
    await this.objects.write({
      relativePath: `meetings/${markdownFileName(event.title, meetingId, event.startsAt, event.timezone)}`,
      frontmatter: {
        ...this.envelope(meetingId, "meeting", event.title, now),
        status: "scheduled",
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        timezone: event.timezone,
        attendee_ids: context.people.map((person) => person.frontmatter.id),
        primary_client_id: context.client?.frontmatter.id,
        primary_product_id: context.product?.frontmatter.id,
        primary_project_id: context.project?.frontmatter.id,
        is_all_day: event.isAllDay ?? false,
        external_refs: [{ provider: this.calendar?.provider ?? "calendar", external_id: event.externalId, calendar_id: event.calendarId }]
      },
      body: `# ${event.title}\n\nCanonical meeting created from ${this.calendar?.provider ?? "calendar"}.\n`
    });
    await this.objects.write({
      relativePath: `meetings/${markdownFileName(`${event.title} notes`, noteId, event.startsAt, event.timezone)}`,
      frontmatter: {
        ...this.envelope(noteId, "meeting-note", `${event.title} notes`, now),
        meeting_id: meetingId,
        people_ids: context.people.map((person) => person.frontmatter.id),
        primary_client_id: context.client?.frontmatter.id,
        primary_product_id: context.product?.frontmatter.id,
        primary_project_id: context.project?.frontmatter.id
      },
      body: noteBody
    });
    await this.writeAudit("meeting.created", meetingId, now, { external_id: externalId });
    await this.objects.completeOperation?.(operationId);
    await this.rebuildIndex();
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
    const events = await this.listCalendarEvents(from, to);
    const event = events.find((candidate) => candidate.externalId === externalId && (!calendarId || candidate.calendarId === calendarId));
    if (!event) throw new Error(`Calendar event not found: ${externalId}`);
    const existing = this.findMeetingForEvent(event.externalId, event.calendarId);
    if (existing) return this.meetingWorkspace(existing.frontmatter.id);
    const now = new Date().toISOString();
    const synthetic = (type: ObjectEnvelope["type"], title: string): LifeOSObject => ({ frontmatter: { ...this.envelope(`preview:${type}:${externalId}:${title}`, type, title, now) }, body: "", relativePath: "", contentHash: "" });
    const meeting: LifeOSObject = {
      frontmatter: { ...this.envelope(`preview:${externalId}`, "meeting", event.title, now), status: "scheduled", starts_at: event.startsAt, ends_at: event.endsAt, timezone: event.timezone, is_all_day: event.isAllDay ?? false },
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
        people: event.attendees.map((name) => synthetic("person", name))
      }
    };
  }

  async meetingFromEvent(externalId: string) {
    const meeting = this.findMeetingForEvent(externalId);
    if (!meeting) throw new Error(`No LifeOS meeting exists for calendar event: ${externalId}`);
    return this.meetingWorkspace(meeting.frontmatter.id);
  }

  async meetingWorkspace(meetingId: string) {
    const meeting = this.required(meetingId, "meeting");
    const note = this.index.all().find((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meetingId && !object.frontmatter.deleted_at);
    const reviews = this.index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.source_meeting_id === meetingId);
    const tasks = this.index.all().filter((object) => object.frontmatter.type === "task" && object.frontmatter.source_meeting_id === meetingId);
    const resolve = (value: unknown) => typeof value === "string" ? this.index.get(value) : undefined;
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

  async updateBody(id: string, body: string, expectedHash: string) {
    const current = this.required(id);
    // A stale tab or the other device must not keep autosaving into a deleted note.
    if (current.frontmatter.deleted_at) throw new Error("This note was deleted; it can no longer be edited");
    const now = new Date().toISOString();
    const updated = await this.objects.write({
      relativePath: current.relativePath,
      expectedHash,
      frontmatter: { ...current.frontmatter, revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId },
      body
    });
    await this.rebuildIndex();
    return updated;
  }

  async processMeeting(meetingId: string) {
    if (!this.ai) throw new Error("AI provider is not configured");
    const workspace = await this.meetingWorkspace(meetingId);
    if (!workspace.note) throw new Error("Meeting has no canonical note");
    const pending = workspace.reviews.filter((review) => review.frontmatter.status === "pending");
    if (pending.length) return pending;
    const proposals = await this.ai.proposeMeetingOutputs(workspace.note.body);
    const now = new Date().toISOString();
    const agentRunId = uuidV7();
    await this.objects.write({
      relativePath: `agent-runs/${markdownFileName("Process meeting", agentRunId, now)}`,
      frontmatter: { ...this.envelope(agentRunId, "agent-run", "Process meeting", now), operation: "meeting-extraction", provider: "mock", model: "deterministic-mock", prompt_version: "1", status: "succeeded", started_at: now, completed_at: now, input_summary: workspace.note.frontmatter.title, output_summary: `${proposals.length} proposals`, related_object_ids: [meetingId, workspace.note.frontmatter.id] },
      body: `# Agent run\n\nProcessed ${workspace.note.frontmatter.title}.\n`
    });
    const created: LifeOSObject[] = [];
    for (const proposal of proposals) {
      const id = uuidV7();
      created.push(await this.objects.write({
        relativePath: `review-items/${markdownFileName(proposal.title, id, now)}`,
        frontmatter: {
          ...this.envelope(id, "review-item", proposal.title, now),
          review_type: "create",
          target_object_type: proposal.type,
          proposed_fields: { title: proposal.title, status: "Inbox" },
          confidence_label: proposal.confidence,
          field_evidence: {},
          status: "pending",
          agent_run_id: agentRunId,
          source_meeting_id: meetingId,
          source_ids: [workspace.note.frontmatter.id],
          primary_client_id: workspace.meeting.frontmatter.primary_client_id,
          primary_product_id: workspace.meeting.frontmatter.primary_product_id,
          primary_project_id: workspace.meeting.frontmatter.primary_project_id,
          operation_id: uuidV7()
        },
        body: `# Proposal\n\n${proposal.title}\n`
      }));
    }
    await this.rebuildIndex();
    return created;
  }

  async acceptReviewItem(reviewId: string) {
    const review = this.required(reviewId, "review-item");
    if (review.frontmatter.status === "accepted" && typeof review.frontmatter.resolved_object_id === "string") {
      if (typeof review.frontmatter.operation_id === "string") await this.objects.completeOperation?.(review.frontmatter.operation_id);
      return this.required(review.frontmatter.resolved_object_id);
    }
    if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");
    const now = new Date().toISOString();
    const owner = await this.ensureSelfPerson(now);
    const requestedOperationId = typeof review.frontmatter.operation_id === "string" ? review.frontmatter.operation_id : uuidV7();
    const operation = await this.objects.prepareOperation?.("accept-review", { reviewId, objectId: uuidV7() }, requestedOperationId);
    const objectId = typeof operation?.payload.objectId === "string" ? operation.payload.objectId : uuidV7();
    const proposed = review.frontmatter.proposed_fields as { title?: string; status?: string; body?: string };
    const title = proposed.title ?? review.frontmatter.title;
    const targetType = String(review.frontmatter.target_object_type);
    const folder = targetType === "task" ? "tasks" : targetType === "decision" ? "decisions" : targetType === "open-point" ? "open-points" : targetType === "knowledge-note" ? "knowledge" : undefined;
    if (!folder) throw new Error(`Unsupported review target: ${targetType}`);
    const common = { source_meeting_id: review.frontmatter.source_meeting_id, source_ids: review.frontmatter.source_ids ?? [], primary_client_id: review.frontmatter.primary_client_id, primary_product_id: review.frontmatter.primary_product_id, primary_project_id: review.frontmatter.primary_project_id };
    const fields = targetType === "task"
      ? { status: proposed.status ?? "Inbox", owner_person_id: owner.frontmatter.id, ...common }
      : targetType === "decision"
        ? { status: "active", decision_text: title, decided_at: now, ...common }
        : targetType === "open-point"
          ? { status: "open", owner_person_id: owner.frontmatter.id, ...common }
          : { source_ids: review.frontmatter.source_ids ?? [], related_object_ids: [] };
    const created = this.index.get(objectId) ?? await this.objects.write({ relativePath: `${folder}/${markdownFileName(title, objectId, now)}`, frontmatter: { ...this.envelope(objectId, targetType as ObjectEnvelope["type"], title, now), ...fields }, body: targetType === "knowledge-note" && typeof proposed.body === "string" ? proposed.body : `# ${title}\n` });
    await this.objects.write({
      relativePath: review.relativePath,
      expectedHash: review.contentHash,
      frontmatter: {
        ...review.frontmatter,
        revision: review.frontmatter.revision + 1,
        updated_at: now,
        updated_by_device: this.deviceId,
        status: "accepted",
        reviewed_at: now,
        resolved_object_id: objectId
      },
      body: review.body
    });
    await this.rebuildIndex();
    await this.writeAudit("review.accepted", objectId, now, { review_id: reviewId });
    await this.objects.completeOperation?.(requestedOperationId);
    await this.rebuildIndex();
    return created;
  }

  today() {
    const active = this.entities("task").filter((object) => !["Done", "Cancelled"].includes(String(object.frontmatter.status)));
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = (task: LifeOSObject) => typeof task.frontmatter.due_on === "string" ? task.frontmatter.due_on : typeof task.frontmatter.due_at === "string" ? task.frontmatter.due_at.slice(0, 10) : undefined;
    const ranked = [...active].sort((a, b) => {
      const priority = (value: unknown) => value === "High" ? 0 : value === "Medium" ? 1 : value === "Low" ? 2 : 3;
      return priority(a.frontmatter.priority) - priority(b.frontmatter.priority) || String(dueDate(a) ?? "9999").localeCompare(String(dueDate(b) ?? "9999"));
    });
    return {
      tasks: active,
      overdue: active.filter((task) => Boolean(dueDate(task) && dueDate(task)! < today)),
      dueToday: active.filter((task) => dueDate(task) === today),
      upcoming: active.filter((task) => Boolean(dueDate(task) && dueDate(task)! > today)).sort((a, b) => String(dueDate(a)).localeCompare(String(dueDate(b)))),
      waiting: active.filter((task) => task.frontmatter.status === "Waiting"),
      topThree: ranked.slice(0, 3).map((task) => ({ task, reason: dueDate(task) && dueDate(task)! <= today ? "Due or overdue" : task.frontmatter.priority ? `${task.frontmatter.priority} priority` : "Active commitment" })),
      reviewCount: this.index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.status === "pending").length
    };
  }

  tasks() {
    return this.entities("task");
  }

  reviews() {
    return this.index.all().filter((object) => object.frontmatter.type === "review-item");
  }

  knowledge(query = "") {
    const notes = this.index.all().filter((object) => object.frontmatter.type === "knowledge-note");
    const needle = query.trim().toLowerCase();
    return needle ? notes.filter((note) => `${note.frontmatter.title}\n${note.body}`.toLowerCase().includes(needle)) : notes;
  }

  rollups(type: "client" | "product" | "person") {
    const field = type === "client" ? "primary_client_id" : type === "product" ? "primary_product_id" : "owner_person_id";
    return this.entities(type).map((entity) => ({
      entity,
      related: this.index.all().filter((object) => !object.frontmatter.deleted_at && (object.frontmatter[field] === entity.frontmatter.id || (Array.isArray(object.frontmatter.attendee_ids) && object.frontmatter.attendee_ids.includes(entity.frontmatter.id))))
    }));
  }

  async quickCapture(title: string) {
    const clean = title.trim();
    if (!clean) throw new Error("Capture text is required");
    const now = new Date().toISOString();
    const owner = await this.ensureSelfPerson(now);
    const id = uuidV7();
    const task = await this.objects.write({ relativePath: `tasks/${markdownFileName(clean, id, now)}`, frontmatter: { ...this.envelope(id, "task", clean, now), status: "Inbox", owner_person_id: owner.frontmatter.id, source_ids: [] }, body: `# ${clean}\n` });
    await this.writeAudit("task.quick-captured", id, now, {});
    await this.rebuildIndex();
    return task;
  }

  async updateTask(id: string, changes: Record<string, unknown>, expectedHash: string) {
    const task = this.required(id, "task");
    const now = new Date().toISOString();
    const allowed = ["title", "status", "priority", "owner_person_id", "waiting_for_person_id", "due_on", "due_at", "due_timezone", "expected_output", "primary_project_id", "primary_client_id", "primary_product_id", "dependency_ids"];
    const safe = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.includes(key)));
    if (safe.status === "Done") safe.completed_at = now; else safe.completed_at = undefined;
    if (safe.status === "Cancelled") safe.cancelled_at = now; else safe.cancelled_at = undefined;
    const updated = await this.objects.write({ relativePath: task.relativePath, expectedHash, frontmatter: { ...task.frontmatter, ...safe, revision: task.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId }, body: task.body });
    await this.writeAudit("task.updated", id, now, { changes: safe });
    await this.rebuildIndex();
    return updated;
  }

  /**
   * Deletes a meeting or knowledge note as a tombstone (PB-021): `deleted_at` is set and the file
   * stays on disk, so another device cannot resurrect it and it can be restored by hand. Physical
   * removal is a separate maintenance step. The meeting itself is kept; opening its event again
   * starts a fresh note. Idempotent: deleting an already-deleted note returns it unchanged.
   */
  async deleteNote(id: string, expectedHash: string) {
    const current = this.required(id);
    if (!["meeting-note", "knowledge-note"].includes(current.frontmatter.type)) throw new Error("Only notes can be deleted here");
    if (current.frontmatter.deleted_at) return current;
    const now = new Date().toISOString();
    const updated = await this.objects.write({ relativePath: current.relativePath, expectedHash, frontmatter: { ...current.frontmatter, deleted_at: now, revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId }, body: current.body });
    await this.writeAudit("note.deleted", id, now, { type: current.frontmatter.type, meeting_id: current.frontmatter.meeting_id });
    await this.rebuildIndex();
    return updated;
  }

  /**
   * Brings a deleted note back by clearing its tombstone (PB-025). Idempotent. A meeting shows one
   * note, so if the event already got a newer note after this one was deleted, restoring would leave
   * two; refuse and ask the user to delete the newer one first rather than guess which to keep.
   */
  async restoreNote(id: string, expectedHash: string) {
    const current = this.required(id);
    if (!["meeting-note", "knowledge-note"].includes(current.frontmatter.type)) throw new Error("Only notes can be restored here");
    if (!current.frontmatter.deleted_at) return current;
    const meetingId = current.frontmatter.meeting_id;
    if (meetingId && this.index.all().some((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meetingId && !object.frontmatter.deleted_at)) {
      throw new Error("This meeting already has a newer note. Delete that note first, then restore this one.");
    }
    const now = new Date().toISOString();
    const updated = await this.objects.write({ relativePath: current.relativePath, expectedHash, frontmatter: { ...current.frontmatter, deleted_at: undefined, revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId }, body: current.body });
    await this.writeAudit("note.restored", id, now, { type: current.frontmatter.type, meeting_id: meetingId });
    await this.rebuildIndex();
    return updated;
  }

  async archiveObject(id: string, expectedHash: string) {
    const object = this.required(id);
    const now = new Date().toISOString();
    const updated = await this.objects.write({ relativePath: object.relativePath, expectedHash, frontmatter: { ...object.frontmatter, archived_at: now, revision: object.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId }, body: object.body });
    await this.writeAudit("object.archived", id, now, {});
    await this.rebuildIndex();
    return updated;
  }

  /**
   * Finds live meetings that share one calendar event (PB-004) and, with `apply`, archives every
   * copy but one together with its notes (`archived_at`, file kept, audited). The kept copy is the
   * one whose note has the most text, then the highest revision. A group where a second copy's note
   * also holds real text is reported for a manual merge and never archived automatically.
   */
  async reconcileDuplicateMeetings(options: { apply: boolean }) {
    const live = (object: LifeOSObject) => !object.frontmatter.deleted_at && !object.frontmatter.archived_at;
    const all = this.index.all();
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
        const current = this.required(target.id);
        if (current.frontmatter.archived_at) continue;
        await this.objects.write({ relativePath: current.relativePath, expectedHash: current.contentHash, frontmatter: { ...current.frontmatter, archived_at: now, archived_reason: `Duplicate of meeting ${group.keep.meetingId} (PB-004)`, revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.deviceId }, body: current.body });
        await this.writeAudit("object.archived", target.id, now, { reason: "duplicate-meeting", kept_meeting_id: group.keep.meetingId, event: group.eventKey });
      }
    }
    await this.rebuildIndex();
    return { applied: true, groups: report };
  }

  async recordGoogleConnection() {
    const existing = this.index.all().find((object) => object.frontmatter.type === "connector-account" && object.frontmatter.provider === "google");
    if (existing) return existing;
    const now = new Date().toISOString();
    const id = uuidV7();
    const account = await this.objects.write({ relativePath: `connectors/${markdownFileName("Google Calendar", id, now)}`, frontmatter: { ...this.envelope(id, "connector-account", "Google Calendar", now), provider: "google", account_label: "Primary calendar", external_account_id: "primary", status: "active", secret_ref: "google:default:tokens", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }, body: "# Google Calendar\n\nRead-only calendar connection. Credentials are stored in macOS Keychain.\n" });
    await this.rebuildIndex();
    return account;
  }

  async ingestTextSource(title: string, text: string) {
    if (!title.trim() || !text.trim()) throw new Error("Source title and text are required");
    const now = new Date().toISOString();
    const sourceId = uuidV7();
    const fragmentId = "fragment-1";
    const source = await this.objects.write({ relativePath: `sources/${markdownFileName(title, sourceId, now)}`, frontmatter: { ...this.envelope(sourceId, "source", title.trim(), now), source_type: "pasted-text", captured_at: now, ingestion_status: "captured", fragments: [{ id: fragmentId, text: text.trim(), locator: { kind: "full-text" } }] }, body: `# ${title.trim()}\n\n${text.trim()}\n` });
    const proposal = this.ai?.proposeKnowledgeNote ? await this.ai.proposeKnowledgeNote(text) : { title: title.trim(), body: `# ${title.trim()}\n\n${text.trim()}\n`, confidence: "Medium" as const };
    const reviewId = uuidV7();
    await this.objects.write({ relativePath: `review-items/${markdownFileName(proposal.title, reviewId, now)}`, frontmatter: { ...this.envelope(reviewId, "review-item", proposal.title, now), review_type: "create", target_object_type: "knowledge-note", proposed_fields: { title: proposal.title, body: proposal.body }, field_evidence: { title: [{ source_id: sourceId, fragment_id: fragmentId }], body: [{ source_id: sourceId, fragment_id: fragmentId }] }, confidence_label: proposal.confidence, status: "pending", source_ids: [sourceId], operation_id: uuidV7() }, body: `# Knowledge proposal\n\n${proposal.body}` });
    await this.rebuildIndex();
    return source;
  }

  projects() {
    const meetings = this.index.all().filter((object) => object.frontmatter.type === "meeting");
    return this.entities("project").map((project) => {
      const meetingIds = meetings.filter((meeting) => meeting.frontmatter.primary_project_id === project.frontmatter.id).map((meeting) => meeting.frontmatter.id);
      const tasks = this.tasks().filter((task) => task.frontmatter.primary_project_id === project.frontmatter.id || meetingIds.includes(String(task.frontmatter.source_meeting_id)));
      const decisions = this.index.all().filter((object) => object.frontmatter.type === "decision" && object.frontmatter.primary_project_id === project.frontmatter.id);
      const openPoints = this.index.all().filter((object) => object.frontmatter.type === "open-point" && object.frontmatter.primary_project_id === project.frontmatter.id && object.frontmatter.status === "open");
      const projectMeetings = meetings.filter((meeting) => meetingIds.includes(meeting.frontmatter.id));
      const peopleIds = new Set(projectMeetings.flatMap((meeting) => Array.isArray(meeting.frontmatter.attendee_ids) ? meeting.frontmatter.attendee_ids.filter((id): id is string => typeof id === "string") : []));
      return { project, tasks, meetings: projectMeetings, decisions, openPoints, people: [...peopleIds].map((id) => this.index.get(id)).filter((person): person is LifeOSObject => Boolean(person)) };
    });
  }

  async updateReviewTitle(reviewId: string, title: string) {
    const review = this.required(reviewId, "review-item");
    if (review.frontmatter.status !== "pending") throw new Error("Only pending review items can be edited");
    const nextTitle = title.trim();
    if (!nextTitle) throw new Error("Proposal title is required");
    const now = new Date().toISOString();
    const proposed = review.frontmatter.proposed_fields as Record<string, unknown>;
    const updated = await this.objects.write({
      relativePath: review.relativePath,
      expectedHash: review.contentHash,
      frontmatter: {
        ...review.frontmatter,
        revision: review.frontmatter.revision + 1,
        updated_at: now,
        updated_by_device: this.deviceId,
        title: nextTitle,
        proposed_fields: { ...proposed, title: nextTitle }
      },
      body: `# Proposal\n\n${nextTitle}\n`
    });
    await this.rebuildIndex();
    return updated;
  }

  async rejectReviewItem(reviewId: string) {
    const review = this.required(reviewId, "review-item");
    if (review.frontmatter.status === "rejected") return review;
    if (review.frontmatter.status !== "pending") throw new Error("Only pending review items can be rejected");
    const now = new Date().toISOString();
    const updated = await this.objects.write({
      relativePath: review.relativePath,
      expectedHash: review.contentHash,
      frontmatter: {
        ...review.frontmatter,
        revision: review.frontmatter.revision + 1,
        updated_at: now,
        updated_by_device: this.deviceId,
        status: "rejected",
        reviewed_at: now
      },
      body: review.body
    });
    await this.writeAudit("review.rejected", reviewId, now, {});
    await this.rebuildIndex();
    return updated;
  }

  private envelope(id: string, type: ObjectEnvelope["type"], title: string, timestamp: string): ObjectEnvelope {
    return { id, type, schema_version: 1, revision: 1, title, created_at: timestamp, updated_at: timestamp, updated_by_device: this.deviceId };
  }

  /** The live meeting for a calendar event. Identity is provider + calendar + event id (PB-004);
   * refs written before calendar_id or provider were recorded match on the fields they have. */
  private findMeetingForEvent(externalId: string, calendarId?: string) {
    const provider = this.calendar?.provider;
    return this.index.all().find((object) => object.frontmatter.type === "meeting" && !object.frontmatter.deleted_at && !object.frontmatter.archived_at &&
      Array.isArray(object.frontmatter.external_refs) &&
      object.frontmatter.external_refs.some((reference: unknown) => {
        if (typeof reference !== "object" || reference === null) return false;
        const ref = reference as { provider?: string; external_id?: string; calendar_id?: string };
        return ref.external_id === externalId &&
          (!provider || !ref.provider || ref.provider === provider) &&
          (!calendarId || !ref.calendar_id || ref.calendar_id === calendarId);
      }));
  }

  private withNoteLinks(events: CalendarEvent[]) {
    const objects = this.index.all();
    return events.map((event) => {
      const meeting = this.findMeetingForEvent(event.externalId, event.calendarId);
      const note = meeting ? objects.find((object) => object.frontmatter.type === "meeting-note" &&
        object.frontmatter.meeting_id === meeting.frontmatter.id && !object.frontmatter.deleted_at) : undefined;
      return {
        ...event,
        hasNote: Boolean(note),
        meetingId: meeting?.frontmatter.id,
        noteId: note?.frontmatter.id
      };
    });
  }

  private async writeAudit(action: string, objectId: string, timestamp: string, metadata: Record<string, unknown>) {
    const id = uuidV7();
    await this.objects.write({ relativePath: `audit/${markdownFileName(action, id, timestamp)}`, frontmatter: { ...this.envelope(id, "audit-event", action, timestamp), occurred_at: timestamp, actor_type: "person", actor_ref: this.deviceId, action, object_id: objectId, metadata }, body: `# ${action}\n` });
  }

  private async writeSyncRun(status: "succeeded" | "failed", startedAt: string, recordCount: number, error?: string) {
    const account = this.index.all().find((object) => object.frontmatter.type === "connector-account" && object.frontmatter.provider === "google");
    if (!account) return;
    const completedAt = new Date().toISOString();
    // Throttle: repeating the same failure within the window adds no information, only another file.
    const previous = this.googleSyncRuns()[0];
    if (status === "failed" && previous?.frontmatter.status === "failed" && previous.frontmatter.error === error &&
      Date.parse(completedAt) - Date.parse(String(previous.frontmatter.completed_at)) < FAILED_SYNC_RUN_THROTTLE_MS) return;
    const id = uuidV7();
    await this.objects.write({ relativePath: `sync-runs/${markdownFileName("Google Calendar sync", id, completedAt)}`, frontmatter: { ...this.envelope(id, "sync-run", "Google Calendar sync", completedAt), connector_account_id: account.frontmatter.id, resource_type: "calendar-events", status, started_at: startedAt, completed_at: completedAt, record_count: recordCount, error }, body: `# Google Calendar sync\n\n${status}: ${recordCount} events.\n` });
    await this.rebuildIndex();
  }

  /** Google Calendar Sync Runs, newest first. */
  private googleSyncRuns() {
    return this.index.all()
      .filter((object) => object.frontmatter.type === "sync-run" && object.frontmatter.resource_type === "calendar-events")
      .sort((left, right) => Date.parse(String(right.frontmatter.completed_at)) - Date.parse(String(left.frontmatter.completed_at)));
  }

  private required(id: string, type?: ObjectEnvelope["type"]) {
    const object = this.index.get(id);
    if (!object || (type && object.frontmatter.type !== type)) throw new Error(`Object not found: ${id}`);
    return object;
  }

  private async ensureSelfPerson(timestamp: string) {
    const existing = this.index.all().find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true);
    if (existing) return existing;
    const id = uuidV7();
    const created = await this.objects.write({
      relativePath: `people/${markdownFileName("You", id, timestamp)}`,
      frontmatter: { ...this.envelope(id, "person", "You", timestamp), given_name: "You", is_self: true },
      body: "# You\n"
    });
    return created;
  }

  private async ensureEventContext(event: CalendarEvent, timestamp: string) {
    const client = event.clientName ? await this.ensureNamedObject("client", event.clientName, timestamp, { status: "active" }) : undefined;
    const product = event.productName ? await this.ensureNamedObject("product", event.productName, timestamp, { status: "active" }) : undefined;
    const project = event.projectName ? await this.ensureNamedObject("project", event.projectName, timestamp, {
      status: "active",
      objective: "Validate the local-first LifeOS meeting workflow",
      primary_client_id: client?.frontmatter.id,
      primary_product_id: product?.frontmatter.id
    }) : undefined;
    const people: LifeOSObject[] = [];
    for (const name of event.attendees) people.push(await this.ensureNamedObject("person", name, timestamp, { given_name: name.split(" ")[0] }));
    return { client, product, project, people };
  }

  private async ensureNamedObject(type: "client" | "product" | "project" | "person", title: string, timestamp: string, fields: Record<string, unknown>) {
    const existing = this.index.all().find((object) => object.frontmatter.type === type && object.frontmatter.title === title);
    if (existing) return existing;
    const id = uuidV7();
    const folders = { client: "clients", product: "products", project: "projects", person: "people" } as const;
    return this.objects.write({
      relativePath: `${folders[type]}/${markdownFileName(title, id, timestamp)}`,
      frontmatter: { ...this.envelope(id, type, title, timestamp), ...fields },
      body: `# ${title}\n`
    });
  }

  private async enrichMeetingContext(meeting: LifeOSObject, context: Awaited<ReturnType<LifeOSApplication["ensureEventContext"]>>, timestamp: string) {
    const fields = {
      attendee_ids: context.people.map((person) => person.frontmatter.id),
      primary_client_id: context.client?.frontmatter.id,
      primary_product_id: context.product?.frontmatter.id,
      primary_project_id: context.project?.frontmatter.id
    };
    const needsMeetingUpdate = !meeting.frontmatter.primary_project_id || !Array.isArray(meeting.frontmatter.attendee_ids);
    if (needsMeetingUpdate) {
      await this.objects.write({
        relativePath: meeting.relativePath,
        expectedHash: meeting.contentHash,
        frontmatter: { ...meeting.frontmatter, ...fields, revision: meeting.frontmatter.revision + 1, updated_at: timestamp, updated_by_device: this.deviceId },
        body: meeting.body
      });
    }
    const note = this.index.all().find((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meeting.frontmatter.id && !object.frontmatter.deleted_at);
    if (note && !note.frontmatter.primary_project_id) {
      await this.objects.write({
        relativePath: note.relativePath,
        expectedHash: note.contentHash,
        frontmatter: { ...note.frontmatter, ...fields, people_ids: fields.attendee_ids, revision: note.frontmatter.revision + 1, updated_at: timestamp, updated_by_device: this.deviceId },
        body: note.body
      });
    }
  }
}
