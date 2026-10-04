import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";

export interface ObjectStore {
  list(): Promise<LifeOSObject[]>;
  scan?(): Promise<{ objects: LifeOSObject[]; diagnostics: string[] }>;
  read(relativePath: string): Promise<LifeOSObject>;
  write(input: { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string }): Promise<LifeOSObject>;
  /** Saves a copy of `object` in the versions store and returns its relative path (U4: external changes). */
  keepVersion?(object: LifeOSObject): Promise<string>;
  prepareOperation?(kind: string, payload: Record<string, unknown>, operationId: string): Promise<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>;
  completeOperation?(operationId: string): Promise<void>;
  incompleteOperations?(): Promise<Array<{ id: string; kind: string; status: string; payload: Record<string, unknown> }>>;
}

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
