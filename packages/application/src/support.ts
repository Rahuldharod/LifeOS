import { sensitivityOf, type LifeOSObject } from "@lifeos/domain";

/** Small helpers shared by the application modules (#53). One home, so the rules cannot drift apart. */

type WithFrontmatter = Pick<LifeOSObject, "frontmatter">;

/** ADR 0010: restricted only when `sensitivity: restricted`; missing means normal. No object is not restricted. */
export const isRestricted = (object: { frontmatter: { sensitivity?: unknown } } | undefined) =>
  object ? sensitivityOf(object.frontmatter) === "restricted" : false;

/**
 * ADR 0010, #63: a meeting counts as restricted when the meeting itself or any of its (non-deleted) meeting
 * notes is restricted. The interface restricts the note, so every exclusion of a meeting goes through this
 * one rule. `objects` is where to look for the notes (usually the whole index).
 */
export function isMeetingRestricted(meeting: WithFrontmatter | undefined, objects: Iterable<WithFrontmatter>) {
  if (!meeting) return false;
  if (isRestricted(meeting)) return true;
  for (const object of objects) {
    if (object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meeting.frontmatter.id && !object.frontmatter.deleted_at && isRestricted(object)) return true;
  }
  return false;
}

/** Live = neither tombstoned (`deleted_at`) nor archived (`archived_at`). */
export const isLive = (object: WithFrontmatter) => !object.frontmatter.deleted_at && !object.frontmatter.archived_at;

/**
 * Equality for frontmatter values. **Null rule:** `null` and `undefined` both mean "field absent" and are equal
 * to each other (YAML cannot hold `undefined`, so audit and plan records write absent as `null`). Absent is never
 * equal to a falsy value such as `""`, `0`, `false` or `[]`. Other values compare structurally (JSON form).
 */
export const sameValue = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The context links an object carries: its primary project, client and product. */
export const contextLinkFields = ["primary_project_id", "primary_client_id", "primary_product_id"] as const;

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

/** A task's due date as `YYYY-MM-DD`: `due_on`, else the date part of `due_at`, else undefined. */
export const dueDate = (task: WithFrontmatter) =>
  typeof task.frontmatter.due_on === "string" ? task.frontmatter.due_on : typeof task.frontmatter.due_at === "string" ? task.frontmatter.due_at.slice(0, 10) : undefined;

/** Predicate: `value` is a list whose every item is text. */
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The text items of `value` when it is a list (others dropped); `[]` when it is not a list. */
export const stringsIn = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
