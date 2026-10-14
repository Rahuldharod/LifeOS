// #121: the JSON shapes the localhost API sends and receives, as the browser sees them after `JSON.parse`.
// Types only; no Node dependencies, so the web app can import them. The server's routes are checked against
// these (apps/server/src/route.ts), so a use case whose result stops matching breaks the server's typecheck.
import type { AppInfo } from "@lifeos/shared";

/** #208: the server's App version and short commit, as the health check reports it. */
export type { AppInfo };

export type EntityType = "task" | "project" | "client" | "product" | "person";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** An object's front matter: the envelope every object has, plus whatever fields its type adds. */
export type Frontmatter = Record<string, unknown> & {
  id: string;
  title: string;
  type: string;
  status?: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
/** One LifeOS object (a Markdown file) as the API sends it. */
export type LifeObject = { frontmatter: Frontmatter; body: string; relativePath: string; contentHash: string };
/** `GET /objects`: every object without its body, for links and route checks. */
export type ObjectLink = Pick<LifeObject, "frontmatter" | "relativePath" | "contentHash">;

/** A calendar event, with the LifeOS meeting and note it has, if any. */
export type CalendarEvent = { externalId: string; calendarId?: string; calendarName?: string; calendarColor?: string; title: string; startsAt: string; endsAt: string; timezone: string; isAllDay?: boolean; seriesId?: string; seriesUid?: string; originalOccurrenceStartsAt?: string; previousSeriesId?: string; status?: "confirmed" | "cancelled"; attendees: string[]; location?: string; joinUrl?: string; projectName?: string; hasNote?: boolean; meetingId?: string; noteId?: string; stored?: true };
export type CalendarOfflineReason = "network" | "auth" | "keychain-denied";
export type CalendarOffline = { reason: CalendarOfflineReason; error: string; lastSuccessfulSyncAt?: string };
/** #88: a calendar range; `offline` when the calendar could not be read and `events` are the meetings already in LifeOS. */
export type CalendarDay = { events: CalendarEvent[]; offline?: CalendarOffline };
export type CalendarOption = { id: string; name: string; color?: string };
export type CalendarPreferences = { disabledCalendarIds: string[]; defaultCalendarId?: string; contentHash?: string };

/** A meeting with its note, proposals, tasks and context. `persisted: false` is the read-only preview of an event (PB-020). */
export type Workspace = {
  persisted?: boolean;
  meeting: LifeObject;
  note?: LifeObject;
  reviews: LifeObject[];
  tasks: LifeObject[];
  /** Present on every recurring occurrence (new or stored): the read-only history of the same provider series (ADR 0021). */
  seriesView?: SeriesView;
  context: { project?: LifeObject; client?: LifeObject; product?: LifeObject; people: LifeObject[] };
};
/** Earlier occurrences of the opened occurrence's series that have a live Note, newest first, 4 per page (ADR 0021). */
export type SeriesView = SeriesViewPage & {
  /** Present only when the opened occurrence is not the newest occurrence with a Note: the latest one to open instead (#180). */
  newer?: { meetingId: string; startsAt: string; endsAt: string; timezone: string };
};
/** One page of earlier occurrences. `nextCursor` is present while more remain (opaque; pass it to "Load older"). */
export type SeriesViewPage = { earlier: SeriesViewEarlier[]; nextCursor?: string };
/** #176: what enrichment attached to one occurrence's own Meeting. */
export type SeriesViewMaterials = { summary?: string; sources: Array<{ id: string; title: string; sourceType: string; url?: string }> };
export type SeriesViewEarlier = {
  /** `legacy-shared`: one ADR 0019 Note linked to several Meetings, shown once. */
  kind: "occurrence" | "legacy-shared";
  note: LifeObject;
  /** The covered Meetings of this series: one occurrence's own time, or the span of a Legacy shared Note. */
  range: { startsAt: string; endsAt: string };
  /** The provider cancelled this occurrence; it is listed only because it has a Note. */
  cancelled: boolean;
  /** #176: Sources linked to this occurrence's own Meeting and its accepted summary; absent when there are none, or the occurrence is restricted. */
  materials?: SeriesViewMaterials;
};
export type ProjectRollup = { project: LifeObject; tasks: LifeObject[]; meetings: LifeObject[]; decisions: LifeObject[]; openPoints: LifeObject[]; people: LifeObject[] };
export type EntityRollup = { entity: LifeObject; related: LifeObject[] };

/** The advisory device lease (ADR 0003, ADR 0015). */
export type SessionStatus = { currentDeviceId: string; activeDeviceId: string; startedAt: string; lastActivityAt: string; leaseExpiresAt: string; writeAllowed: boolean; warning?: string; releasedAfterIdle?: boolean };
/** #76: present while the user's own email addresses or the internal domains are unset. */
export type SetupWarning = { selfEmailsMissing: boolean; internalDomainsMissing: boolean };
export type BackupWarningKind = "backup-failed" | "off-drive-failed" | "overdue";
/** #84: a backup or the off-Drive copy failed, or none succeeded in 26 hours. */
export type BackupWarning = { kind: BackupWarningKind; message: string; reason: string; at?: string };
export type SystemHealth = { status: "healthy" | "attention"; objectCount: number; diagnostics: string[]; session: SessionStatus; idleReleaseMinutes: number; setupWarning?: SetupWarning; backupWarning?: BackupWarning; appInfo: AppInfo };

/** ADR 0007: Inbox Drafts plus Patch Drafts waiting to be adopted, and the ones that failed. */
export type InboxStatus = { awaiting: number; drafts: number; patches: number; failed: Array<{ path: string; reason: string }> };
export type DraftOutcome = "adopted" | "applied" | "review" | "duplicate" | "failed" | "skipped";
export type DraftResult = { draft: string; outcome: DraftOutcome; objectIds: string[]; reason?: string; filedAs?: string };
/** One adoption run: `retrySoon` when a draft was skipped only because it may still be being written. */
export type AdoptionBatch = { agentRunId?: string; drafts: DraftResult[]; retrySoon: boolean };
export type AppliedPatch = { auditEventId: string; objectId: string; title: string; type: string; appliedAt: string; before: Record<string, unknown>; after: Record<string, unknown>; appendedNote?: string; undone: boolean };

export type BackupSummary = { backupId: string; createdAt: string; fileCount: number; totalBytes: number };
export type BackupVerification = BackupSummary & { valid: boolean; restoredToTemporaryDirectory: boolean; diagnostics: string[] };
export type BackupSettings = { offDriveFolder?: string; contentHash?: string };

export type GoogleConnection = { configured: boolean; connected: boolean; provider: string; missing?: string[]; reason?: "expired"; lastSuccessfulSyncAt?: string; lastError?: string; keychain?: "ok" | "denied" };
/** #77: answered without reading any secret value. */
export type ConnectionSettings = {
  calendar: { configured: boolean; connected: boolean; reason?: "expired"; lastSuccessfulSyncAt?: string; lastError?: string };
  drive: { configured: boolean; connected: boolean };
  /** "denied" after the user clicked Deny on a macOS Keychain prompt. */
  keychain?: "ok" | "denied";
};

export type StoredAsset = { relativePath: string; markdownPath: string; sha256: string; deduplicated: boolean; mimeType: string };

/** One evidence reference as the Review screen shows it; a source that cannot be found is unresolved. */
export type ReviewEvidence = { field: string; resolved: boolean; source_id?: string; source_ref?: string; source_title?: string; locator?: string; quote?: string };
/** `GET /review-items`: each item carries its evidence per field. */
export type ReviewItem = LifeObject & { evidence: Record<string, ReviewEvidence[]> };
/** #34: the proposal fields the user may edit before accepting; `null` clears a field. */
export type ReviewEdits = Partial<Record<"title" | "owner_person_id" | "due_on" | "due_at" | "due_timezone" | "priority" | "primary_project_id" | "primary_client_id" | "primary_product_id", string | null>>;

/** #39: a person's display label; `externalSource` says why they are (or are not) external. */
export type PersonLabel = { id: string; name: string; label: string; suffix?: string; isExternal: boolean; externalSource: "self" | "override" | "email" | "stored"; unreviewed?: boolean };

export type FocusItem = { id: string; state: "open" | "done" | "cancelled" | "past" | "missing"; object?: LifeObject; overdue?: boolean; whyToday?: string; ifThen?: string; ageDays?: number; context?: string; ask?: string; reason?: string; pinned?: boolean; replaces?: { id: string; title: string } };
/** #47: one change to the date's Top 3. */
export type FocusChange = { action: "pin" | "unpin" | "replace" | "dismiss" | "restore" | "reset"; taskId?: string; replacementId?: string };
/** #46: the Daily Focus brief with live status. */
export type DailyFocus = { date: string; brief?: { id: string; title: string; path: string; generatedAt: string; body: string; lengthWarning?: string }; iOwe: FocusItem[]; top3: FocusItem[]; top3Source: "brief" | "rule"; maxMustDos: number; override?: { contentHash: string }; dismissedTop3: FocusItem[]; waitingAndDecisions: FocusItem[]; meetingPrep: FocusItem[]; dayShape?: { meetingHours: number; freeHours: number }; deferCandidates: FocusItem[]; restrictedHidden: number };
export type Today = { tasks: LifeObject[]; overdue: LifeObject[]; dueToday: LifeObject[]; upcoming: LifeObject[]; waiting: LifeObject[]; topThree: Array<{ task: LifeObject; reason: string }>; reviewCount: number; focus?: DailyFocus };
export type TodaySettings = { meetingHoursThreshold: number; briefTime: string; briefTimeZone: string; briefDays: Weekday[]; contentHash?: string };
export type FocusSettings = { maxMustDos: number; contentHash?: string };
export type WaitingGroup = { personId?: string; name: string; suffix?: string; label: string; isExternal: boolean; tasks: LifeObject[] };
export type NextMeeting = { title: string; startsAt: string; endsAt: string; inProgress: boolean; meetingId?: string; noteId?: string; calendarEventId?: string; calendarName?: string; restricted: boolean };
export type MeetingOpenPoint = { openPoint: LifeObject; meetingId: string; meetingTitle: string; link: "raised-in" | "project" | "client" | "people" };
/** #48: Today's live panels, computed by the server on each load (never from the brief). */
export type TodayPanels = {
  date: string; overdue: LifeObject[]; dueToday: LifeObject[]; upcomingHighPriority: LifeObject[];
  waitingByPerson: WaitingGroup[];
  nextMeetings: NextMeeting[];
  meetingHours: number; meetingHeavy: boolean;
  /** #88: set when the calendar could not be read; Next meetings then lists the meetings already in LifeOS. */
  calendarOffline?: CalendarOffline;
  openPointsForMeetings: MeetingOpenPoint[];
  reviewCount: number; inbox: { awaiting: number; drafts: number; patches: number }; failedDrafts: Array<{ path: string; reason: string }>;
  staleWorkOrders: Array<{ path: string; requestedAt: string; ageDays: number }>; settings: TodaySettings;
  setupWarning?: SetupWarning;
  backupWarning?: BackupWarning;
};
/** #44: meetings proposed as given up and Work Orders nobody picked up. */
export type EnrichmentStatus = { proposedGaveUp: Array<{ meetingId: string; title: string; requestedAt: string }>; staleWorkOrders: Array<{ path: string; requestedAt: string; ageDays: number }> };

/** #85: one kept version or one audit event about an object. */
export type HistoryEntry = {
  kind: "version" | "event"; id: string; at: string; device: string; external: boolean;
  versionPath?: string; kept: boolean; current: boolean; title?: string; revision?: number; action?: string;
};
/** #92: the history plus the object's hash and sensitivity when the panel opened. */
export type HistoryPanel = { entries: HistoryEntry[]; contentHash?: string; restricted: boolean };

/** PB-030: what blocks a permanent delete (front-matter references) and what it would leave missing (body links). */
export type PurgeReference = { id: string; type: string; title: string };
export type PurgeCheck = { blockers: PurgeReference[]; bodyLinks: PurgeReference[] };

export type Evidence = { field: string; sourceId: string; sourceTitle?: string; fragmentId: string; text?: string; locator?: unknown };
export type DecisionDetail = { decision: LifeObject; supersedes?: LifeObject; supersededBy?: LifeObject; meeting?: LifeObject; sources: LifeObject[]; people: LifeObject[]; project?: LifeObject; client?: LifeObject; product?: LifeObject; review?: LifeObject; evidence: Evidence[]; resolvesOpenPoints?: LifeObject[] };
export type OpenPointDetail = { openPoint: LifeObject; resolutionDecision?: LifeObject; meeting?: LifeObject; sources: LifeObject[]; people: LifeObject[]; owner?: LifeObject; project?: LifeObject; client?: LifeObject; product?: LifeObject; review?: LifeObject; evidence: Evidence[] };

/** A synced list setting (#54, #39) and the hash of the version it was read from. */
export type InternalDomains = { domains: string[]; contentHash?: string };
export type SelfEmails = { emails: string[]; contentHash?: string };

/** ADR 0020: the skill pack this LifeOS expects and the one that wrote the latest draft. */
export type ClaudeSkillsStatus = {
  expected: number; oldestAccepted: number; lastSeen?: { skillPack: number; at: string; draft: string; outdated: boolean };
  /** The skills this LifeOS ships, each downloadable as a zip for Claude chat and the phone. */
  skills: Array<{ name: string; version?: string }>;
  /** The Claude Code plugin, when the repository is known: `/plugin marketplace add <marketplace>`, then `/plugin install <install>`. */
  plugin?: { marketplace: string; install: string };
};

/** A message for the user, e.g. after writing a Work Order. */
export type Message = { message: string };
