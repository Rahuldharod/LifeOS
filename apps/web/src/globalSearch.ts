import type { CalendarEvent, LifeObject } from "@lifeos/contracts";
import type { Route } from "./routes.js";
import { foldText } from "./searchOptions.js";
import { dateInTimeZone } from "./zonedTime.js";

export const recentSearchIdsKey = "lifeos.search.recentIds";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;

export type GlobalSearchItem = {
  id: string;
  kind: "Task" | "Calendar" | "Note";
  title: string;
  body: string;
  updatedAt: string;
  recentIndex: number;
  route: Route;
};

export type GlobalSearchGroups = { tasks: GlobalSearchItem[]; calendar: GlobalSearchItem[]; notes: GlobalSearchItem[] };

/** Calendar is deliberately a bounded, read-only search: 90 days back and one year ahead. */
export function calendarSearchRange(now = new Date()) {
  const from = new Date(now.getTime() - 90 * 86_400_000);
  const to = new Date(now);
  to.setUTCFullYear(to.getUTCFullYear() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function readRecentSearchIds(storage: StorageReader = localStorage): string[] {
  try {
    const value = JSON.parse(storage.getItem(recentSearchIdsKey) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 40) : [];
  } catch { return []; }
}

export function recordRecentSearchId(id: string, storage: StorageWriter = localStorage) {
  try { storage.setItem(recentSearchIdsKey, JSON.stringify([id, ...readRecentSearchIds(storage).filter((item) => item !== id)].slice(0, 40))); }
  catch { /* Search still works when browser storage is unavailable. */ }
}

function eligible(objects: LifeObject[], kind: "Task" | "Note"): GlobalSearchItem[] {
  return objects
    .filter((object) => !object.frontmatter.archived_at && !object.frontmatter.deleted_at)
    .map((object) => ({
      id: object.frontmatter.id,
      kind,
      title: object.frontmatter.title,
      body: object.body,
      updatedAt: object.frontmatter.updated_at,
      recentIndex: Number.POSITIVE_INFINITY,
      route: kind === "Task" ? { view: "Tasks", id: object.frontmatter.id } : { view: "Notes", noteTab: "open", id: object.frontmatter.id }
    }));
}

function rank(item: GlobalSearchItem, query: string) {
  const title = foldText(item.title);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  return 3;
}

function results(items: GlobalSearchItem[], query: string, recentIds: string[]) {
  if (!query) {
    const positions = new Map(recentIds.map((id, index) => [id, index]));
    return items
      .filter((item) => positions.has(item.id))
      .map((item) => ({ ...item, recentIndex: positions.get(item.id)! }))
      .sort((left, right) => left.recentIndex - right.recentIndex);
  }
  return items
    .filter((item) => foldText(item.title).includes(query) || foldText(item.body).includes(query))
    .sort((left, right) => rank(left, query) - rank(right, query)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.title.localeCompare(right.title));
}

function eventText(event: CalendarEvent, timeZone: string) {
  return `${event.title}\n${event.startsAt}\n${dateInTimeZone(new Date(event.startsAt), timeZone)}\n${event.attendees.join("\n")}`;
}

function calendarItem(event: CalendarEvent, timeZone: string): GlobalSearchItem {
  return {
    id: `calendar:${event.calendarId ?? ""}:${event.externalId}`,
    kind: "Calendar",
    title: event.title,
    body: eventText(event, timeZone),
    updatedAt: event.startsAt,
    recentIndex: Number.POSITIVE_INFINITY,
    route: { view: "Calendar", date: dateInTimeZone(new Date(event.startsAt), timeZone) }
  };
}

export function globalSearchResults({ tasks, notes, calendar = [], query, recentIds, timeZone = "UTC" }: { tasks: LifeObject[]; notes: LifeObject[]; calendar?: CalendarEvent[]; query: string; recentIds: string[]; timeZone?: string }): GlobalSearchGroups {
  const folded = foldText(query.trim());
  const liveNotes = notes.filter((note) => (note.frontmatter.type === "knowledge-note" || note.frontmatter.type === "meeting-note") && !note.frontmatter.archived_at && !note.frontmatter.deleted_at);
  const calendarByNote = new Map<string, CalendarEvent[]>();
  for (const event of calendar) if (event.noteId) calendarByNote.set(event.noteId, [...calendarByNote.get(event.noteId) ?? [], event]);
  const noteItems = liveNotes.map((note) => {
    const events = calendarByNote.get(note.frontmatter.id) ?? [];
    return {
      ...eligible([note], "Note")[0]!,
      body: `${note.body}\n${events.map((event) => eventText(event, timeZone)).join("\n")}`,
      route: { view: "Notes" as const, noteTab: "open" as const, id: note.frontmatter.id }
    };
  });
  const noteIds = new Set(liveNotes.map((note) => note.frontmatter.id));
  return {
    tasks: results(eligible(tasks.filter((object) => object.frontmatter.type === "task"), "Task"), folded, recentIds),
    // When a live Meeting Note represents an event, the Note is the one searchable result (#152).
    calendar: results(calendar.filter((event) => !(event.hasNote && event.noteId && noteIds.has(event.noteId))).map((event) => calendarItem(event, timeZone)), folded, recentIds),
    notes: results(noteItems, folded, recentIds)
  };
}
