import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";

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
