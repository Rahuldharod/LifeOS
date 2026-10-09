// PB-026: the breadcrumb trail for a route. Pure: the caller decides when the lists are loaded.

import { type LinkedObject } from "./lifeosLinks.js";
import { routeTarget, type Route, type RouteData } from "./routes.js";

/** A crumb with a `route` is a link; the last crumb (the open item) has none. */
export type Crumb = { label: string; route?: Route };
export type TrailData = RouteData & { /** Fallback source for Inbox titles. */ reviews?: LinkedObject[] };
export type TrailOptions = { /** A meeting preview on `route.date` that has no file (and no id in the URL) yet. */ unsavedMeeting?: boolean };

/** "3 Oct" for a `YYYY-MM-DD` day; the day is calendar text, so no timezone conversion applies. */
function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

const titled = (title: string | undefined) => title?.trim() || "Untitled";

/** Where the user is, as links back up. Empty when the route has no item, or the item cannot be opened. */
export function buildTrail(route: Route, data: TrailData, options: TrailOptions = {}): Crumb[] {
  if (route.view === "Calendar" && route.date && !route.id && options.unsavedMeeting) {
    return [{ label: "Calendar", route: { view: "Calendar" } }, { label: dayLabel(route.date), route: { view: "Calendar", date: route.date } }, { label: "New meeting" }];
  }
  const { id } = route;
  if (!id || routeTarget(route, data).kind !== "ok") return [];
  const find = (list: LinkedObject[]) => list.find((object) => object.frontmatter.id === id)?.frontmatter.title;

  if (route.view === "Notes") {
    const deleted = route.noteTab === "deleted";
    const list: Route = { view: "Notes", noteTab: deleted ? "deleted" : "open" };
    const title = titled(find(deleted ? data.deletedNotes : data.notes));
    return deleted ? [{ label: "Notes", route: list }, { label: "Deleted", route: list }, { label: title }] : [{ label: "Notes", route: list }, { label: title }];
  }
  if (route.view === "Calendar") {
    if (!route.date) return [];
    return [{ label: "Calendar", route: { view: "Calendar" } }, { label: dayLabel(route.date), route: { view: "Calendar", date: route.date } }, { label: titled(find(data.objects)) }];
  }
  const title = route.view === "Inbox" ? find(data.objects) ?? find(data.reviews ?? []) : find(data.objects);
  return [{ label: route.view, route: { view: route.view } }, { label: titled(title) }];
}
