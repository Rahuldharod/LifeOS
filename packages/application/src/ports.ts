import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";

export interface ObjectStore {
  list(): Promise<LifeOSObject[]>;
  scan?(): Promise<{ objects: LifeOSObject[]; diagnostics: string[] }>;
  read(relativePath: string): Promise<LifeOSObject>;
  write(input: { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string }): Promise<LifeOSObject>;
  /** Saves a copy of `object` in the versions store and returns its relative path (U4: external changes). */
  keepVersion?(object: LifeOSObject): Promise<string>;
  /**
   * #69: the newest copy of `id` in the versions store (highest revision, then most recently saved), read as an object
   * whose `relativePath` is the version's path. The store also keeps each revision it writes (the last N, ADR 0012), so
   * this is the last-known state across restarts and devices. Undefined when nothing is stored for `id`.
   */
  latestVersion?(id: string): Promise<LifeOSObject | undefined>;
  /**
   * #72: where the newest stored version of `id` is, its revision and the first hex digits of the hash of the file
   * it copies, without reading it. Lets a start skip unchanged objects cheaply (ADR 0012).
   */
  latestVersionInfo?(id: string): Promise<{ relativePath: string; revision: number; hashPrefix: string } | undefined>;
  /** #85: the kept copies of `id`, newest first (highest revision, then most recently saved), without reading them. */
  listVersions?(id: string): Promise<Array<{ relativePath: string; revision: number; hashPrefix: string }>>;
  /**
   * #81: `id` as the app last saved it at or before `instant`: of the stored copies whose `updated_at` is not after it,
   * the highest revision, and of that revision the copy saved first (a later copy of the same revision holds an edit
   * made outside the app). Undefined when no such copy is kept (none yet, or pruned per ADR 0012).
   */
  versionAt?(id: string, instant: string): Promise<LifeOSObject | undefined>;
  /** Journals an operation before its first write (ADR 0013). Exclusive: if `operationId` exists, its stored record wins. */
  prepareOperation?(kind: OperationKind, payload: Record<string, unknown>, operationId: string): Promise<StoredOperation>;
  completeOperation?(operationId: string): Promise<void>;
  incompleteOperations?(): Promise<StoredOperation[]>;
}

/**
 * The operations journal (ADR 0013): every kind of multi-write step that is journalled before its first write.
 * The text values are stored in `.lifeos/operations/*.json`, so they never change.
 */
export const operationKinds = {
  acceptReview: "accept-review",
  mergePerson: "merge-person",
  rejectReview: "reject-review",
  createMeeting: "create-meeting",
  supersedeDecision: "supersede-decision",
  resolveOpenPoint: "resolve-open-point",
  applyPatch: "apply-patch",
  adoptDraft: "adopt-draft",
  adoptBatch: "adopt-batch"
} as const;
export type OperationKind = typeof operationKinds[keyof typeof operationKinds];

/** One journalled operation: its ID, kind and the payload recovery needs to finish or undo it. */
export interface Operation {
  id: string;
  /** An `OperationKind`; typed as text because the journal on disk may hold a kind this version does not know. */
  kind: string;
  payload: Record<string, unknown>;
}
/** An operation as the journal stores it; `prepared` means not finished yet. */
export interface StoredOperation extends Operation { status: string }

export interface IndexStore {
  rebuild(objects: LifeOSObject[], diagnostics?: string[]): void;
  all(): LifeOSObject[];
  get(id: string): LifeOSObject | undefined;
  diagnostics(): string[];
  /** Every file path claiming `id` when more than one does (U3); undefined when the ID is unique. */
  duplicatePaths?(id: string): string[] | undefined;
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
  /** The user declined the invitation; declined events are never enriched (#44). */
  declined?: boolean;
  /** Display labels (name, else email). Kept for the UI and name-only connectors. */
  attendees: string[];
  /** Attendees with email when the connector knows it (#38); people are matched on these when present. */
  attendeeDetails?: CalendarAttendee[];
  clientName?: string;
  productName?: string;
  projectName?: string;
  hasNote?: boolean;
  meetingId?: string;
  noteId?: string;
}

export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  /** The calendar owner (Google's `self`): always the self person. */
  self?: boolean;
}

export interface AiProvider {
  proposeMeetingOutputs(note: string): Promise<Array<{ type: "task" | "decision" | "open-point"; title: string; confidence: "High" | "Medium" | "Low" }>>;
  proposeKnowledgeNote?(source: string): Promise<{ title: string; body: string; confidence: "High" | "Medium" | "Low" }>;
}

export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
  set(reference: string, value: string): Promise<void>;
}

/** The `_inbox/` subfolders (ADR 0007). Agents write drafts, patches and requests; the application files outcomes. */
export const inboxFolders = ["drafts", "patches", "requests", "processed", "failed"] as const;
export type InboxFolder = typeof inboxFolders[number];

export interface InboxFile {
  name: string;
  /** Data-root relative path, e.g. `_inbox/drafts/x.md`, for path-aware messages. */
  relativePath: string;
  /** Last modification time in epoch milliseconds (used to skip files still being written). */
  modifiedAt: number;
}

/** A Markdown file split into front matter and body. `error` says why the front matter could not be read; nothing is validated here. */
export interface InboxDocument extends InboxFile {
  content: string;
  contentHash: string;
  frontmatter?: Record<string, unknown>;
  body: string;
  error?: string;
}

/**
 * Raw access to `_inbox/` and `_agent/`. These files are not objects: the object scan ignores them
 * and only adoption reads them. Contract rules (what makes a draft valid) live in the application.
 */
export interface InboxStore {
  /** Creates the `_inbox/` subfolders and `_agent/` when missing. */
  ensureFolders(): Promise<void>;
  /** Markdown files directly inside the folder, sorted by name; hidden and temporary files are left out. */
  list(folder: InboxFolder): Promise<InboxFile[]>;
  read(folder: InboxFolder, name: string): Promise<InboxDocument>;
  /** Moves a file between inbox folders without overwriting; a `-2`, `-3`… suffix avoids clashes. Returns where it was filed. */
  move(from: InboxFolder, name: string, to: InboxFolder): Promise<InboxFile>;
  /** Atomically writes a Markdown file with YAML front matter, replacing any file of that name. */
  writeDocument(folder: InboxFolder, name: string, frontmatter: Record<string, unknown>, body: string): Promise<InboxFile>;
}

/** One derived Agent Index file: a plain file name in `_agent/` and its Markdown content. */
export interface AgentIndexFile { name: string; content: string }

/**
 * Writes the derived Agent Index into `_agent/` (ADR 0009). Write-only on purpose: the application
 * never reads `_agent/` back, so deleting the folder, or an Agent scribbling in it, changes nothing.
 */
export interface AgentIndexWriter {
  /** Atomically replaces each named file; other files in `_agent/` are left alone. */
  write(files: AgentIndexFile[]): Promise<void>;
}
