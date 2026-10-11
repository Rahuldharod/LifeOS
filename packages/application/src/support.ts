import { createHash } from "node:crypto";
import type { LifeOSObject } from "@lifeos/domain";
import { contextLinkFields, isRestricted as restrictedFrontmatter } from "@lifeos/shared";

/** Small helpers shared by the application modules (#53). One home, so the rules cannot drift apart. */

type WithFrontmatter = Pick<LifeOSObject, "frontmatter">;

/** ADR 0010: restricted only when `sensitivity: restricted`; missing means normal. No object is not restricted. */
export const isRestricted = (object: { frontmatter: { sensitivity?: unknown } } | undefined) =>
  object ? restrictedFrontmatter(object.frontmatter) : false;

/**
 * ADR 0010, #63: a meeting counts as restricted when the meeting itself or any of its (non-deleted) meeting
 * notes is restricted. The interface restricts the note, so every exclusion of a meeting goes through this
 * one rule. `objects` is where to look for the notes (usually the whole index).
 */
export function isMeetingRestricted(meeting: WithFrontmatter | undefined, objects: Iterable<WithFrontmatter>) {
  if (!meeting) return false;
  if (isRestricted(meeting)) return true;
  for (const object of objects) {
    // Not isLive on purpose: an archived restricted note still restricts its meeting (fails closed for privacy, ADR 0010).
    if (object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meeting.frontmatter.id && !object.frontmatter.deleted_at && isRestricted(object)) return true;
  }
  return false;
}

/** Live = neither tombstoned (`deleted_at`) nor archived (`archived_at`). */
export const isLive = (object: WithFrontmatter) => !object.frontmatter.deleted_at && !object.frontmatter.archived_at;

/**
 * Decision 2026-10-10 (#118): an identifier (object ID, email, URL) reaches an archived object too, so it is reused
 * rather than duplicated; only deleted objects are gone. When several match, live ones come first.
 */
export const byIdentifier = <T extends WithFrontmatter>(matches: T[]) => {
  const reachable = matches.filter((object) => !object.frontmatter.deleted_at);
  return [...reachable.filter(isLive), ...reachable.filter((object) => !isLive(object))];
};

/**
 * The meeting's one live note (#118): the first `meeting-note` in `objects` (usually the whole index) whose
 * `meeting_id` is `meetingId` and that is live. A deleted or archived note never counts; none gives `undefined`.
 */
export function liveMeetingNote<T extends WithFrontmatter>(meetingId: string, objects: Iterable<T>): T | undefined {
  for (const object of objects) {
    const meetingIds = Array.isArray(object.frontmatter.meeting_ids) ? object.frontmatter.meeting_ids : [];
    if (object.frontmatter.type === "meeting-note" && (object.frontmatter.meeting_id === meetingId || meetingIds.includes(meetingId)) && isLive(object)) return object;
  }
  return undefined;
}

/** Follows additive Meeting/Note migration redirects without mutating the legacy objects. */
export function resolveObjectRedirect<T extends WithFrontmatter>(id: string, objects: Iterable<T>) {
  const byId = new Map(Array.from(objects, (object) => [object.frontmatter.id, object]));
  const first = byId.get(id);
  if (!first) throw new Error(`Object not found: ${id}`);
  const redirectedFrom: string[] = [];
  const seen = new Set([id]);
  let object = first;
  while (true) {
    const target = object.frontmatter.type === "meeting-note" ? object.frontmatter.redirect_to_note_id : object.frontmatter.type === "meeting" ? object.frontmatter.redirect_to_meeting_id : undefined;
    if (typeof target !== "string") break;
    if (seen.has(target)) throw new Error(`Object redirect cycle at ${target}`);
    const next = byId.get(target);
    if (!next) throw new Error(`Object not found: ${target}`);
    redirectedFrom.push(object.frontmatter.id);
    seen.add(target);
    object = next;
  }
  return { object, redirectedFrom, ...(typeof first.frontmatter.redirect_to_section_id === "string" ? { sectionId: first.frontmatter.redirect_to_section_id } : {}) };
}

/**
 * Equality for frontmatter values. **Null rule:** `null` and `undefined` both mean "field absent" and are equal
 * to each other (YAML cannot hold `undefined`, so audit and plan records write absent as `null`). Absent is never
 * equal to a falsy value such as `""`, `0`, `false` or `[]`. Other values compare structurally (JSON form).
 */
export const sameValue = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The context links an object carries (home: @lifeos/shared, so the web app uses the same list, #75). */
export { contextLinkFields };

/** The context links a new object takes from its meeting: each one the meeting holds as text. */
export function inheritContextLinks(meeting: WithFrontmatter | undefined): Record<string, unknown> {
  if (!meeting) return {};
  return Object.fromEntries(contextLinkFields.filter((key) => typeof meeting.frontmatter[key] === "string").map((key) => [key, meeting.frontmatter[key]]));
}

/** An object ID: any UUID, upper or lower case. */
export const objectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `zone` is a time zone this runtime knows (an IANA name such as Europe/Paris). */
export function validTimeZone(zone: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; }
}

/**
 * A filter's instant range (#116) as epoch milliseconds, both ends inclusive; a missing or blank bound is
 * open (-Infinity / Infinity). Throws "Enter a valid date range" for an unparseable bound or `from` after `to`.
 */
// Deliberately looser than the calendar's `calendarRange` (apps/server/src/request-checks.ts): filters are inclusive, so from == to is valid; a half-open calendar window rejects it.
export function parseInstantRange(from?: string, to?: string) {
  const range = { from: from ? Date.parse(from) : -Infinity, to: to ? Date.parse(to) : Infinity };
  if (Number.isNaN(range.from) || Number.isNaN(range.to) || range.from > range.to) throw new Error("Enter a valid date range");
  return range;
}

/** A task's due date as `YYYY-MM-DD`: `due_on`, else the date part of `due_at`, else undefined. */
export const dueDate = (task: WithFrontmatter) =>
  typeof task.frontmatter.due_on === "string" ? task.frontmatter.due_on : typeof task.frontmatter.due_at === "string" ? task.frontmatter.due_at.slice(0, 10) : undefined;

/** Predicate: `value` is a list whose every item is text. */
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The text items of `value` when it is a list (others dropped); `[]` when it is not a list. */
export const stringsIn = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * ADR 0013: runs work one call at a time per key. Each call starts once every earlier call with the same key has
 * settled; an earlier failure does not stop later calls. Use one key (e.g. "all") for a module-wide queue.
 */
export class OneAtATime {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const current = (this.tails.get(key) ?? Promise.resolve()).then(work);
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return current;
  }
}

/** A role key for a replayable ID (#59). Build one only with `replayRoles`, so the text never drifts. */
export type ReplayRole = string & { readonly replayRole: unique symbol };
const role = (text: string) => text as ReplayRole;

/**
 * ADR 0013: the role keys of replayable IDs. A role names what an ID is for, never what an attempt found already
 * written. The text is part of stored data (each ID is derived from it), so an existing role's text never changes.
 * Grammar: `kind` or `kind:key:key`; `parent/child` nests a role raised inside another; `role:operation` is the
 * operation ID of the Review Item with that role.
 */
export const replayRoles = {
  /** The draft's main object. */
  main: role("main"),
  /** The meeting a meeting-material draft creates. */
  meeting: role("meeting"),
  /** The summary Review Item of meeting material. */
  summary: role("summary"),
  /** The update Review Item a patch raises. */
  review: role("review"),
  /** A Source found by provider and external ID (meeting material). */
  source: (provider: string, externalId: string) => role(`source:${provider}:${externalId}`),
  /** A web-link Source for a cited URL. */
  urlSource: (url: string) => role(`source:url:${url}`),
  /** The Source made from a draft's own body text. */
  bodySource: role("source:body"),
  /** A proposal Review Item, by its key in the draft. */
  proposal: (key: string) => role(`proposal:${key}`),
  /** A link-resolution Review Item for one unresolved reference. */
  link: (field: string, reference: string) => role(`link:${field}:${reference}`),
  /** A person-merge Review Item, by its (order-free) pair key. */
  merge: (pair: string) => role(`merge:${pair}`),
  /** The Agent run of a step that proposes Review Items outside adoption (processing a meeting, a pasted Source). */
  agentRun: role("agent-run"),
  /** The Knowledge Note proposed from a pasted Source. */
  knowledge: role("knowledge"),
  /** A meeting output Review Item for one version of the note, by what it proposes: its type and normalised title. */
  meetingOutput: (type: string, title: string) => role(`output:${createHash("sha256").update(`${type}\n${title.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()}`).digest("hex").slice(0, 16)}`),
  /** `child` raised inside `parent`'s handler, e.g. a merge suggestion raised for the main object. */
  within: (parent: ReplayRole, child: ReplayRole) => role(`${parent}/${child}`),
  /** The operation ID of the Review Item with role `of`. */
  operation: (of: ReplayRole) => role(`${of}:operation`)
} as const;

/** Bytes 0–9 of every replayable ID of one operation: the 48-bit timestamp of `now`, then the version and 26 bits of the operation's tag. */
function operationBytes(seed: string, now: string) {
  const bytes = Buffer.alloc(16);
  let timestamp = BigInt(Date.parse(now));
  for (let position = 5; position >= 0; position -= 1) { bytes[position] = Number(timestamp & 0xffn); timestamp >>= 8n; }
  const tag = createHash("sha256").update(`operation:${seed}`).digest();
  bytes[6] = 0x70 | (tag[0]! & 0x0f);
  bytes[7] = tag[1]!;
  bytes[8] = 0x80 | (tag[2]! & 0x3f);
  bytes[9] = tag[3]!;
  return bytes;
}

/** UUID text of 16 bytes: 8-4-4-4-12 hex digits. */
function uuidText(bytes: Buffer) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The UUIDv7 for `role` in the journalled operation `seed` (#59): the same inputs always give the same ID.
 * Layout: the operation's bytes (timestamp and tag, shared by all its IDs), then 48 bits derived from operation + role.
 */
export function replayableId(seed: string, role: ReplayRole, now: string) {
  const bytes = operationBytes(seed, now);
  createHash("sha256").update(`${seed}\n${role}`).digest().copy(bytes, 10, 0, 6);
  return uuidText(bytes);
}

/** Whether `id` is one of the replayable IDs of operation `seed`, whatever its role: the replay window for `ctx.replaying`. */
export function replayScope(seed: string, now: string) {
  const shared = uuidText(operationBytes(seed, now)).split("-").slice(0, 4).join("-");
  return (id: string) => id.startsWith(`${shared}-`);
}
