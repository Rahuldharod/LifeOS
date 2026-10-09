// PB-026: the breadcrumb trail for a route. Pure: the caller decides when the lists are loaded.

import { type LinkedObject } from "./lifeosLinks.js";
import { routeTarget, type Route, type RouteData } from "./routes.js";

/** A crumb with a `route` is a link; the last crumb (the open item) has none. */
export type Crumb = { label: string; route?: Route };
export type TrailData = RouteData & { /** Fallback source for Inbox titles. */ reviews?: LinkedObject[] };
export type TrailOptions = {
  /** Today (`YYYY-MM-DD`) in the display timezone: where the Calendar crumb goes. */
  today: string;
  /** A meeting preview on `route.date` that has no file (and no id in the URL) yet. */
  unsavedMeeting?: boolean;
};

/** "3 Oct" for a `YYYY-MM-DD` day; the day is calendar text, so no timezone conversion applies. */
function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const titled = (title: string | undefined) => title?.trim() || "Untitled";

/** Calendar › day › last: the tab crumb goes to today, the day crumb to that day with no meeting. */
const calendarTrail = (date: string, today: string, last: string): Crumb[] =>
  [{ label: "Calendar", route: { view: "Calendar", date: today } }, { label: dayLabel(date), route: { view: "Calendar", date } }, { label: last }];

/** Where the user is, as links back up. Empty when the route has no item, or the item cannot be opened. */
export function buildTrail(route: Route, data: TrailData, options: TrailOptions): Crumb[] {
  if (route.view === "Calendar" && route.date && !route.id && options.unsavedMeeting) return calendarTrail(route.date, options.today, "New meeting");
  const { id } = route;
  if (!id || routeTarget(route, data).kind !== "ok") return [];
  const find = (list: LinkedObject[]) => list.find((object) => object.frontmatter.id === id)?.frontmatter.title;

  if (route.view === "Notes") {
    const notes: Crumb = { label: "Notes", route: { view: "Notes", noteTab: "open" } };
    return route.noteTab === "deleted"
      ? [notes, { label: "Deleted", route: { view: "Notes", noteTab: "deleted" } }, { label: titled(find(data.deletedNotes)) }]
      : [notes, { label: titled(find(data.notes)) }];
  }
  if (route.view === "Calendar") return route.date ? calendarTrail(route.date, options.today, titled(find(data.objects))) : [];
  const title = route.view === "Inbox" ? find(data.objects) ?? find(data.reviews ?? []) : find(data.objects);
  return [{ label: route.view, route: { view: route.view } }, { label: titled(title) }];
}
