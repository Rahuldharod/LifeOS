import { AdoptionModule } from "./adoption.js";
import { AgentIndexModule, type AgentIndexOptions } from "./agent-index.js";
import { AppContext } from "./context.js";
import { CalendarModule } from "./calendar.js";
import { CaptureModule } from "./capture.js";
import { EnrichmentModule } from "./enrichment.js";
import { DecisionsModule, type DecisionFilters } from "./decisions.js";
import { EntitiesModule, type EntityType } from "./entities.js";
import { HistoryModule } from "./history.js";
import { MeetingsModule } from "./meetings.js";
import { NotesModule } from "./notes.js";
import { PatchModule } from "./patches.js";
import { PeopleModule } from "./people.js";
import type { Sensitivity } from "@lifeos/domain";
import type { AgentIndexWriter, AiProvider, CalendarConnector, IndexStore, InboxStore, ObjectStore } from "./ports.js";
import { ReviewModule } from "./review.js";
import { SystemModule } from "./system.js";

export type { DecisionEvidence, DecisionFilters } from "./decisions.js";
export type { ExternalChange } from "./history.js";
export { derivePersonName, DEFAULT_INTERNAL_DOMAINS, DEFAULT_SELF_EMAILS, EXTERNAL_SUFFIX, externalStatus, normalizeDomain, personDisplayLabels, personEmails } from "./people.js";
export type { ExternalSource, PersonLabel } from "./people.js";
export type { AgentIndexFile, AgentIndexWriter, AiProvider, CalendarAttendee, CalendarConnector, CalendarEvent, CalendarPreferences, CalendarSummary, IndexStore, InboxDocument, InboxFile, InboxFolder, InboxStore, ObjectStore, SecretStore } from "./ports.js";
export { inboxFolders } from "./ports.js";
export type { AdoptionBatch, DraftOutcome, DraftResult, InboxStatus } from "./adoption.js";
export { ReferenceResolver, referenceFields, foldName, foldSubject } from "./resolution.js";
export type { Candidate, ReferenceField, Resolution, UnresolvedReference } from "./resolution.js";
export type { EnrichmentEntry, EnrichmentRequest, EnrichmentState, EnrichmentStatus } from "./enrichment.js";
export { attendeeEmails, enrichmentStates, enrichmentStateOf, expectedMaterial } from "./enrichment.js";
export type { AppliedPatch } from "./patches.js";
export { agentIndexFileNames, defaultAgentIndexDebounceMs } from "./agent-index.js";
export type { AgentIndexOptions, AgentIndexStatus } from "./agent-index.js";

/**
 * The public application facade. It only wires and delegates: behaviour lives in one feature
 * module per area, and shared write rules live in `AppContext`.
 */
export class LifeOSApplication {
  private readonly system: SystemModule;
  private readonly entitiesModule: EntitiesModule;
  private readonly notesModule: NotesModule;
  private readonly meetings: MeetingsModule;
  private readonly calendarModule: CalendarModule;
  private readonly review: ReviewModule;
  private readonly capture: CaptureModule;
  private readonly history: HistoryModule;
  private readonly adoption: AdoptionModule;
  private readonly enrichment: EnrichmentModule;
  private readonly decisionsModule: DecisionsModule;
  private readonly patches: PatchModule;
  private readonly people: PeopleModule;
  private readonly agentIndex: AgentIndexModule;

  /**
   * `inbox` gives access to `_inbox/` for draft adoption (ADR 0007); without it adoption is a no-op.
   * `agentIndex` writes the derived Agent Index to `_agent/` after index rebuilds (ADR 0009); without it nothing is written.
   */
  constructor(objects: ObjectStore, index: IndexStore, calendar?: CalendarConnector, ai?: AiProvider, deviceId = "local-development", inbox?: InboxStore, agentIndex?: AgentIndexWriter, options: { agentIndexDebounceMs?: number; timeZone?: string } = {}) {
    const ctx = new AppContext(objects, index, calendar, ai, deviceId);
    this.patches = new PatchModule(ctx);
    this.adoption = new AdoptionModule(ctx, inbox, this.patches);
    this.people = new PeopleModule(ctx);
    this.meetings = new MeetingsModule(ctx, this.people);
    this.calendarModule = new CalendarModule(ctx, this.meetings);
    this.review = new ReviewModule(ctx, this.meetings);
    this.decisionsModule = new DecisionsModule(ctx);
    this.enrichment = new EnrichmentModule(ctx, this.meetings, this.calendarModule, inbox);
    this.system = new SystemModule(ctx, this.meetings, this.review, this.adoption, this.decisionsModule, this.enrichment);
    this.entitiesModule = new EntitiesModule(ctx);
    this.notesModule = new NotesModule(ctx);
    this.capture = new CaptureModule(ctx);
    this.history = new HistoryModule(ctx);
    const agentIndexOptions: AgentIndexOptions = { debounceMs: options.agentIndexDebounceMs, timeZone: options.timeZone };
    this.agentIndex = new AgentIndexModule(ctx, this.decisionsModule, this.adoption, inbox, agentIndex, agentIndexOptions);
    ctx.onRebuild = () => this.agentIndex.schedule();
  }

  // System
  rebuildIndex() { return this.system.rebuildIndex(); }
  async health() {
    const health = await this.system.health();
    const diagnostics = [...health.diagnostics, ...this.agentIndex.diagnostics()];
    return { ...health, status: diagnostics.length ? "attention" : "healthy", diagnostics };
  }
  recoverOperations() { return this.system.recoverOperations(); }
  listObjects() { return this.system.listObjects(); }
  object(id: string) { return this.system.object(id); }
  archiveObject(id: string, expectedHash: string) { return this.system.archiveObject(id, expectedHash); }
  /** Called by the file watcher (U4, U5). */
  recordExternalChanges() { return this.history.recordExternalChanges(); }
  setSensitivity(id: string, sensitivity: Sensitivity, expectedHash: string) { return this.system.setSensitivity(id, sensitivity, expectedHash); }

  // Notes
  notes() { return this.notesModule.notes(); }
  deletedNotes() { return this.notesModule.deletedNotes(); }
  searchNotes(query: string, state: "open" | "deleted" = "open") { return this.notesModule.searchNotes(query, state); }
  updateBody(id: string, body: string, expectedHash: string) { return this.notesModule.updateBody(id, body, expectedHash); }
  updateNoteMetadata(id: string, changes: Record<string, unknown>, expectedHash: string) { return this.notesModule.updateNoteMetadata(id, changes, expectedHash); }
  deleteNote(id: string, expectedHash: string) { return this.notesModule.deleteNote(id, expectedHash); }
  restoreNote(id: string, expectedHash: string) { return this.notesModule.restoreNote(id, expectedHash); }

  // Entities
  entities(type: EntityType) { return this.entitiesModule.entities(type); }
  createEntity(type: EntityType, fields: Record<string, unknown>) { return this.entitiesModule.createEntity(type, fields); }
  updateEntity(id: string, fields: Record<string, unknown>, expectedHash: string) { return this.entitiesModule.updateEntity(id, fields, expectedHash); }
  deleteEntity(id: string, expectedHash: string) { return this.entitiesModule.deleteEntity(id, expectedHash); }
  tasks() { return this.entitiesModule.tasks(); }
  updateTask(id: string, changes: Record<string, unknown>, expectedHash: string) { return this.entitiesModule.updateTask(id, changes, expectedHash); }
  today() { return this.entitiesModule.today(); }
  rollups(type: "client" | "product" | "person") { return this.entitiesModule.rollups(type); }
  projects() { return this.entitiesModule.projects(); }

  // Decisions (#41)
  decisions(filters: DecisionFilters = {}) { return this.decisionsModule.decisions(filters); }
  decision(id: string) { return this.decisionsModule.decision(id); }
  createDecision(fields: Record<string, unknown>) { return this.decisionsModule.createDecision(fields); }
  updateDecision(id: string, fields: Record<string, unknown>, expectedHash: string) { return this.decisionsModule.updateDecision(id, fields, expectedHash); }
  supersedeDecision(id: string, fields: Record<string, unknown>, expectedHash: string) { return this.decisionsModule.supersedeDecision(id, fields, expectedHash); }

  // People (#39): display labels (also the Agent Index's source, #43), the External override, internal domains
  personLabels() { return this.people.labels(); }
  setPersonExternal(id: string, isExternal: boolean | null, expectedHash: string) { return this.people.setExternal(id, isExternal, expectedHash); }
  getInternalDomains() { return this.people.getInternalDomains(); }
  saveInternalDomains(domains: unknown[], expectedHash?: string) { return this.people.saveInternalDomains(domains, expectedHash); }

  // Calendar
  listCalendarEvents(from?: Date, to?: Date) { return this.calendarModule.listCalendarEvents(from, to); }
  listCalendars() { return this.calendarModule.listCalendars(); }
  getCalendarPreferences() { return this.calendarModule.getCalendarPreferences(); }
  saveCalendarPreferences(input: { disabledCalendarIds: string[]; defaultCalendarId?: string }, expectedHash?: string) { return this.calendarModule.saveCalendarPreferences(input, expectedHash); }
  syncCalendar(from?: Date, to?: Date) { return this.calendarModule.syncCalendar(from, to); }
  calendarSyncStatus() { return this.calendarModule.calendarSyncStatus(); }
  recordGoogleConnection() { return this.calendarModule.recordGoogleConnection(); }

  // Meetings
  createMeetingFromEvent(externalId: string, from?: Date, to?: Date, calendarId?: string, initialBody?: string) { return this.meetings.createMeetingFromEvent(externalId, from, to, calendarId, initialBody); }
  previewMeetingFromEvent(externalId: string, from?: Date, to?: Date, calendarId?: string) { return this.meetings.previewMeetingFromEvent(externalId, from, to, calendarId); }
  meetingFromEvent(externalId: string) { return this.meetings.meetingFromEvent(externalId); }
  meetingWorkspace(meetingId: string) { return this.meetings.meetingWorkspace(meetingId); }
  reconcileDuplicateMeetings(options: { apply: boolean }) { return this.meetings.reconcileDuplicateMeetings(options); }

  // Review
  reviews() { return this.review.reviews(); }
  processMeeting(meetingId: string) { return this.review.processMeeting(meetingId); }
  acceptReviewItem(reviewId: string, options?: { linkTo?: string }) { return this.review.acceptReviewItem(reviewId, options); }
  updateReviewTitle(reviewId: string, title: string) { return this.review.updateReviewTitle(reviewId, title); }
  rejectReviewItem(reviewId: string) { return this.review.rejectReviewItem(reviewId); }
  /** #40: proposes `person-merge` Review Items for likely duplicate people; never merges by itself. */
  suggestPersonMerges() { return this.review.merges.suggest(); }

  // Capture and knowledge
  quickCapture(title: string) { return this.capture.quickCapture(title); }
  knowledge(query = "") { return this.capture.knowledge(query); }
  ingestTextSource(title: string, text: string) { return this.capture.ingestTextSource(title, text); }

  // Inbox Drafts (ADR 0007)
  /** Also refreshes the Agent Index's pending-adoption list: filing a draft may not rebuild the index. */
  async adoptDrafts(options?: { now?: Date }) { const batch = await this.adoption.adoptDrafts(options); this.agentIndex.schedule(); return batch; }
  inboxStatus() { return this.adoption.inboxStatus(); }

  // Enrichment Work Orders (#44)
  requestEnrichment(options?: { now?: Date }) { return this.enrichment.requestEnrichment(options); }
  markEnrichmentGaveUp(meetingId: string, expectedHash: string) { return this.enrichment.markGaveUp(meetingId, expectedHash); }
  enrichmentStatus(options?: { now?: Date }) { return this.enrichment.status(options); }

  // Agent Index (#43, ADR 0009): written debounced after each index rebuild; these write now / report the last write.
  writeAgentIndex(options?: { now?: Date }) { return this.agentIndex.write(options); }
  agentIndexStatus() { return this.agentIndex.status(); }

  // Patch Drafts: applied by adoption; listed and undone here
  appliedPatches() { return this.patches.appliedPatches(); }
  undoPatch(auditEventId: string) { return this.patches.undoPatch(auditEventId); }
}
