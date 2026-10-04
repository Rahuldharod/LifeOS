import { AdoptionModule, type AutoAdoptionOptions } from "./adoption.js";
import { AgentIndexModule, type AgentIndexOptions } from "./agent-index.js";
import { BackupModule, type AutoBackupOptions, type BackupService } from "./backups.js";
import { AppContext } from "./context.js";
import { CalendarModule } from "./calendar.js";
import { CaptureModule } from "./capture.js";
import { EnrichmentModule } from "./enrichment.js";
import { DecisionsModule, type DecisionFilters } from "./decisions.js";
import { EntitiesModule, type EntityType } from "./entities.js";
import { DailyFocusModule } from "./focus.js";
import { HistoryModule } from "./history.js";
import { MeetingsModule } from "./meetings.js";
import { NotesModule } from "./notes.js";
import { OpenPointsModule, type OpenPointFilters } from "./open-points.js";
import { PatchModule } from "./patches.js";
import { PeopleModule } from "./people.js";
import type { Sensitivity } from "@lifeos/domain";
import type { AgentIndexWriter, AiProvider, CalendarConnector, IndexStore, InboxStore, ObjectStore } from "./ports.js";
import { ReviewModule, type ReviewEdits } from "./review.js";
import { SystemModule } from "./system.js";
import { TodayModule, type TodaySettings } from "./today.js";

export type { DecisionEvidence, DecisionFilters } from "./decisions.js";
export type { OpenPointFilters } from "./open-points.js";
export type { ExternalChange, HistoryEntry } from "./history.js";
export { derivePersonName, EXTERNAL_SUFFIX, externalStatus, normalizeDomain, personDisplayLabels, personEmails } from "./people.js";
export type { ExternalSource, PeopleSetupWarning, PersonLabel } from "./people.js";
export type { AgentIndexFile, AgentIndexWriter, AiProvider, CalendarAttendee, CalendarConnector, CalendarEvent, CalendarPreferences, CalendarSummary, IndexStore, InboxDocument, InboxFile, InboxFolder, InboxStore, ObjectStore, Operation, OperationKind, SecretStore, StoredOperation } from "./ports.js";
export { inboxFolders, operationKinds } from "./ports.js";
export type { AdoptionBatch, AutoAdoption, AutoAdoptionOptions, DraftOutcome, DraftResult, InboxStatus } from "./adoption.js";
export type { ReviewEdits, ReviewEvidence } from "./review.js";
export { ReferenceResolver, referenceFields, foldName, foldSubject } from "./resolution.js";
export type { Candidate, ReferenceField, Resolution, UnresolvedReference } from "./resolution.js";
export type { EnrichmentEntry, EnrichmentRequest, EnrichmentState, EnrichmentStatus } from "./enrichment.js";
export { attendeeEmails, enrichmentStates, enrichmentStateOf, expectedMaterial } from "./enrichment.js";
export type { AppliedPatch, UpdateChange, UpdateProposal } from "./patches.js";
export type { DailyFocusView, FocusItem, FocusItemState, FocusOverrideAction, FocusOverrideChange, FocusOverrideState, ReplanRequest } from "./focus.js";
export { maxTopThree, maxMeetingPrep, maxDeferCandidates, maxBriefWords, defaultMaxMustDos, maxMustDosLimit, focusOverrideActions } from "./focus.js";
import type { FocusOverrideChange } from "./focus.js";
export type { CalendarDay, CalendarOffline, CalendarOfflineReason } from "./calendar.js";
export type { MeetingOpenPoint, NextMeeting, OpenPointLink, TodayPanels, TodaySettings, WaitingGroup, Weekday } from "./today.js";
export { defaultTodaySettings, weekdays } from "./today.js";
export { agentIndexFileNames, defaultAgentIndexDebounceMs } from "./agent-index.js";
export type { AgentIndexOptions, AgentIndexStatus } from "./agent-index.js";
export type { AutoBackupOptions, AutoBackups, BackupService, BackupSettings, BackupStatus, BackupSummary, BackupTrigger, BackupWarning, BackupWarningKind } from "./backups.js";

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
  private readonly openPointsModule: OpenPointsModule;
  private readonly patches: PatchModule;
  private readonly people: PeopleModule;
  private readonly focus: DailyFocusModule;
  private readonly agentIndex: AgentIndexModule;
  private readonly todayModule: TodayModule;
  private readonly backups: BackupModule;

  /**
   * `inbox` gives access to `_inbox/` for draft adoption (ADR 0007); without it adoption is a no-op.
   * `agentIndex` writes the derived Agent Index to `_agent/` after index rebuilds (ADR 0009); without it nothing is written.
   */
  constructor(objects: ObjectStore, index: IndexStore, calendar?: CalendarConnector, ai?: AiProvider, deviceId = "local-development", inbox?: InboxStore, agentIndex?: AgentIndexWriter, options: { agentIndexDebounceMs?: number; timeZone?: string } = {}) {
    const ctx = new AppContext(objects, index, calendar, ai, deviceId);
    this.patches = new PatchModule(ctx);
    this.people = new PeopleModule(ctx);
    this.meetings = new MeetingsModule(ctx, this.people);
    this.adoption = new AdoptionModule(ctx, inbox, this.patches, this.meetings);
    this.calendarModule = new CalendarModule(ctx, this.meetings);
    this.decisionsModule = new DecisionsModule(ctx);
    this.review = new ReviewModule(ctx, this.meetings, this.decisionsModule);
    this.openPointsModule = new OpenPointsModule(ctx, this.decisionsModule);
    this.enrichment = new EnrichmentModule(ctx, this.meetings, this.calendarModule, inbox);
    this.system = new SystemModule(ctx, this.meetings, this.review, this.adoption, this.decisionsModule, this.enrichment, this.openPointsModule, this.patches);
    this.entitiesModule = new EntitiesModule(ctx);
    this.focus = new DailyFocusModule(ctx, inbox);
    this.todayModule = new TodayModule(ctx, this.entitiesModule, this.adoption, this.enrichment, this.meetings, this.calendarModule, this.people);
    this.notesModule = new NotesModule(ctx);
    this.capture = new CaptureModule(ctx);
    this.history = new HistoryModule(ctx);
    const agentIndexOptions: AgentIndexOptions = { debounceMs: options.agentIndexDebounceMs, timeZone: options.timeZone };
    this.agentIndex = new AgentIndexModule(ctx, this.decisionsModule, this.adoption, inbox, agentIndex, agentIndexOptions);
    ctx.onRebuild = () => this.agentIndex.schedule();
    this.backups = new BackupModule(ctx);
  }

  // System
  rebuildIndex() { return this.system.rebuildIndex(); }
  async health() {
    const health = await this.system.health();
    const diagnostics = [...health.diagnostics, ...this.agentIndex.diagnostics()];
    // #76: a setup warning, not an integrity problem, so it never turns the status to "attention".
    const setupWarning = this.people.setupWarning();
    return { ...health, status: diagnostics.length ? "attention" : "healthy", diagnostics, ...(setupWarning ? { setupWarning } : {}) };
  }
  recoverOperations(options?: Parameters<SystemModule["recoverOperations"]>[0]) { return this.system.recoverOperations(options); }
  listObjects() { return this.system.listObjects(); }
  object(id: string) { return this.system.object(id); }
  archiveObject(id: string, expectedHash: string) { return this.system.archiveObject(id, expectedHash); }
  /** Called by the file watcher (U4, U5). */
  recordExternalChanges() { return this.history.recordExternalChanges(); }
  /** #79: restores the version copy an external-change audit event names. */
  restoreVersion(auditEventId: string) { return this.history.restoreVersion(auditEventId); }
  objectHistory(objectId: string) { return this.history.objectHistory(objectId); }
  restoreKeptVersion(objectId: string, versionPath: string) { return this.history.restoreKeptVersion(objectId, versionPath); }
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
  /** Today: the live lists plus the Daily Focus brief with live status (#46). `date` is the user's local date; `now` marks past meetings. */
  today(options: { date?: string; now?: Date } = {}) {
    const date = options.date ?? (options.now ?? new Date()).toISOString().slice(0, 10);
    const today = this.entitiesModule.today(date);
    return { ...today, focus: this.focus.view(date, this.entitiesModule.ruleCandidates(date), options.now) };
  }
  /** #47: pin, unpin, replace, dismiss, restore or reset on the date's Top 3; a guarded save (409 on a stale hash). Returns the new Daily Focus view. */
  overrideFocus(date: string, change: FocusOverrideChange, expectedHash?: string, options?: { now?: Date }) { return this.focus.changeOverride(date, change, expectedHash, this.entitiesModule.ruleCandidates(date), options); }
  /** #47: the synced max must-dos setting (default 3). */
  getFocusSettings() { return this.focus.settings(); }
  saveFocusSettings(input: { maxMustDos?: unknown }, expectedHash?: string) { return this.focus.saveSettings(input, expectedHash); }
  /** #48: Today's live panels, computed fresh from the index, calendar and `_inbox/` (never from the brief). */
  todayPanels(options: { date?: string; now?: Date; timeZone?: string } = {}) { return this.todayModule.panels(options); }
  getTodaySettings() { return this.todayModule.settings(); }
  saveTodaySettings(input: Partial<Omit<TodaySettings, "contentHash">>, expectedHash?: string) { return this.todayModule.saveSettings(input, expectedHash); }
  /** "Refresh" on Today: writes a `replan` Work Order for the date (#46). */
  requestReplan(date: string, options?: { now?: Date }) { return this.focus.requestReplan(date, options); }
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
  confirmPersonReviewed(id: string, expectedHash: string) { return this.people.confirmReviewed(id, expectedHash); }
  getInternalDomains() { return this.people.getInternalDomains(); }
  saveInternalDomains(domains: unknown[], expectedHash?: string) { return this.people.saveInternalDomains(domains, expectedHash); }
  getSelfEmails() { return this.people.getSelfEmails(); }
  saveSelfEmails(emails: unknown[], expectedHash?: string) { return this.people.saveSelfEmails(emails, expectedHash); }

  // Open Points (#42)
  openPoints(filters: OpenPointFilters = {}) { return this.openPointsModule.openPoints(filters); }
  openPoint(id: string) { return this.openPointsModule.openPoint(id); }
  createOpenPoint(fields: Record<string, unknown>) { return this.openPointsModule.createOpenPoint(fields); }
  updateOpenPoint(id: string, fields: Record<string, unknown>, expectedHash: string) { return this.openPointsModule.updateOpenPoint(id, fields, expectedHash); }
  resolveOpenPoint(id: string, fields: { resolution_summary?: unknown; resolution_decision_id?: unknown }, expectedHash: string) { return this.openPointsModule.resolveOpenPoint(id, fields, expectedHash); }
  resolveOpenPointWithDecision(id: string, decisionFields: Record<string, unknown>, expectedHash: string) { return this.openPointsModule.resolveOpenPointWithDecision(id, decisionFields, expectedHash); }
  closeOpenPoint(id: string, fields: { reason?: unknown }, expectedHash: string) { return this.openPointsModule.closeOpenPoint(id, fields, expectedHash); }

  // Calendar
  listCalendarEvents(from?: Date, to?: Date) { return this.calendarModule.listCalendarEvents(from, to); }
  listCalendars() { return this.calendarModule.listCalendars(); }
  getCalendarPreferences() { return this.calendarModule.getCalendarPreferences(); }
  saveCalendarPreferences(input: { disabledCalendarIds: string[]; defaultCalendarId?: string }, expectedHash?: string) { return this.calendarModule.saveCalendarPreferences(input, expectedHash); }
  syncCalendar(from?: Date, to?: Date) { return this.calendarModule.syncCalendar(from, to); }
  calendarSyncStatus() { return this.calendarModule.calendarSyncStatus(); }
  /** #88: the range from the calendar, or the meetings already in LifeOS, labelled offline, when it cannot be read. */
  calendarDay(from?: Date, to?: Date, options?: { sync?: boolean }) { return this.calendarModule.calendarDay(from, to, options); }
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
  updateReviewFields(reviewId: string, changes: ReviewEdits) { return this.review.updateReviewFields(reviewId, changes); }
  reviewEvidence(reviewId: string) { return this.review.reviewEvidence(reviewId); }
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
  /** #32: debounced adoption on `_inbox/drafts/` watcher events, retries for half-written drafts, and a periodic sweep. */
  startAutoAdoption(options?: AutoAdoptionOptions) { return this.adoption.startAutoAdoption(options); }

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

  // Backups (#84, ADR 0004): automatic at start, clean stop and daily; a weekly off-Drive copy; a warning on failure
  startAutoBackups(service: BackupService, options?: AutoBackupOptions) { return this.backups.start(service, options); }
  getBackupSettings() { return this.backups.settings(); }
  saveBackupSettings(input: { offDriveFolder?: unknown }, expectedHash?: string) { return this.backups.saveSettings(input, expectedHash); }
}
