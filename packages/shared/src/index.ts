import { foldForSearch } from "./person-match.js";

export const LIFEOS_SCHEMA_VERSION = 1;

// Rules both the server and the browser bundle need (#75). This package has no Node dependencies, so the web app
// can import it; @lifeos/domain cannot be (it uses node:crypto).

/** The three note types (ADR 0023). Every list of "what is a note" uses this one, so a new type is added once. */
export const noteTypes = ["meeting-note", "knowledge-note", "standalone-note"] as const;
export type NoteType = (typeof noteTypes)[number];
export const isNoteType = (type: unknown): type is NoteType => (noteTypes as readonly unknown[]).includes(type);

/** The context links an object carries: its primary project, client and product. */
export const contextLinkFields = ["primary_project_id", "primary_client_id", "primary_product_id"] as const;

export type EntityType = "task" | "project" | "client" | "product" | "person";
/** One relationship field on an entity form (PB-010): `target` is the linked object type; `multi` fields hold a list of ids. */
export type EntityLinkField = { key: string; label: string; target: EntityType; multi?: boolean; required?: boolean };

/**
 * The relationship fields of the Tasks, Projects, Clients, Products and People forms (PB-010). The
 * server validates new links against this list and the web form draws a searchable picker for each.
 */
export const entityLinkFields: Record<EntityType, EntityLinkField[]> = {
  task: [
    { key: "owner_person_id", label: "Owner", target: "person", required: true },
    { key: "waiting_for_person_id", label: "Waiting for", target: "person" },
    { key: "primary_project_id", label: "Project", target: "project" },
    { key: "primary_client_id", label: "Client", target: "client" },
    { key: "primary_product_id", label: "Product", target: "product" },
    { key: "dependency_ids", label: "Depends on", target: "task", multi: true }
  ],
  project: [
    { key: "owner_person_id", label: "Owner", target: "person" },
    { key: "primary_client_id", label: "Client", target: "client" },
    { key: "primary_product_id", label: "Product", target: "product" }
  ],
  client: [{ key: "primary_contact_person_id", label: "Primary contact", target: "person" }],
  product: [{ key: "owner_person_id", label: "Owner", target: "person" }],
  person: []
};

/** ADR 0010: restricted only when `sensitivity: restricted`; missing or any other value means normal. */
export function isRestricted(frontmatter: { sensitivity?: unknown } | Record<string, unknown>) {
  return (frontmatter as { sensitivity?: unknown }).sensitivity === "restricted";
}

/** The Summary section of a meeting body is fenced by these markers (#66). */
export const summaryStartMarker = "<!-- lifeos:summary:start -->";
export const summaryEndMarker = "<!-- lifeos:summary:end -->";

const isSummaryMarkerLine = (line: string, marker: string) => line.trim() === marker;

/** The one parser of the summary fence: line index of the start marker (-1 if none) and of its end marker (-1 if none). */
export function findSummaryFence(lines: string[]) {
  const start = lines.findIndex((line) => isSummaryMarkerLine(line, summaryStartMarker));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && isSummaryMarkerLine(line, summaryEndMarker));
  return { start, end };
}

/** The accepted summary text inside the markers, without its heading; empty when the body has no marked summary (#176). */
export function acceptedSummaryText(body: string) {
  const lines = body.split("\n");
  const { start, end } = findSummaryFence(lines);
  if (end < 0) return "";
  return lines.slice(start + 1, end).join("\n").replace(/^\s*##\s+Summary\s*\n/i, "").trim();
}

/** Email addresses recorded on a Person, as stored (#211, #214). Hand-edited files may list plain strings. */
export function personEmailAddresses(frontmatter: Readonly<Record<string, unknown>>): string[] {
  const identifiers = Array.isArray(frontmatter.identifiers) ? frontmatter.identifiers as unknown[] : [];
  return identifiers.map((identifier) => typeof identifier === "string" ? identifier
    : identifier && typeof identifier === "object" && (identifier as { kind?: unknown }).kind === "email" ? (identifier as { value?: unknown }).value : undefined)
    .filter((email): email is string => typeof email === "string" && email.trim() !== "");
}

/** Email addresses and aliases recorded on a Person (#211): what People search matches besides the name. */
export function personSearchTerms(frontmatter: Readonly<Record<string, unknown>>): string[] {
  const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases as unknown[] : [];
  return [...personEmailAddresses(frontmatter), ...aliases].filter((term): term is string => typeof term === "string" && term.trim() !== "");
}

/** People search (#211): every typed word must appear in the name, an email address or an alias, ignoring case and accents. An empty query matches everyone. */
export function personMatchesQuery(frontmatter: Readonly<Record<string, unknown>>, name: string, query: string): boolean {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean);
  const haystack = foldForSearch([name, ...personSearchTerms(frontmatter)].join("\n"));
  return words.every((word) => haystack.includes(word));
}

export { emailFitsName, emailNameMatch, foldForSearch, isUnreviewedPerson, type EmailNameMatchKind, type NameCandidate } from "./person-match.js";
export { appVersion, unknownAppInfo, type AppInfo, type BuildHistory, type MainCommit } from "./app-version.js";

/** `Note 14 Oct 2026 14:05`: the auto title of a Standalone Note, in the user's time zone (throws on an invalid zone). */
export function standaloneNoteTitle(instant: Date | string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `Note ${part("day")} ${part("month")} ${part("year")} ${part("hour")}:${part("minute")}`;
}

/** A time-ordered UUIDv7. Uses Web Crypto (Node and browsers), so the server and the browser share one algorithm. */
export function uuidV7(now = Date.now()): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
