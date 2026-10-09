// PB-027: every tab and every open item has its own path, so Back/Forward, reload and bookmarks work.
// The URL is the source of truth for which tab and which item are open.

import { resolveLifeosLink, type LinkedObject } from "./lifeosLinks.js";

export type View = "Today" | "Calendar" | "Notes" | "Tasks" | "Decisions" | "Open Points" | "Projects" | "Clients" | "Products" | "People" | "Knowledge" | "Inbox" | "System" | "Settings";

export const views: View[] = ["Today", "Calendar", "Notes", "Tasks", "Decisions", "Open Points", "Projects", "Clients", "Products", "People", "Knowledge", "Inbox", "System", "Settings"];

/**
 * `id` is the open item: a note on Notes, a meeting on Calendar, the highlighted card on an entity
 * tab, the Review Item on Inbox. `date` is the Calendar day; `noteTab` the Notes list being shown.
 */
export type Route = { view: View; id?: string; date?: string; noteTab?: "open" | "deleted" };

const slugs = Object.fromEntries(views.map((view) => [view, view.toLowerCase().replace(/ /g, "-")])) as Record<View, string>;
const viewsBySlug = new Map(views.map((view) => [slugs[view], view]));
/** Tabs whose path may name one open item. */
const itemViews = new Set<View>(["Tasks", "Decisions", "Open Points", "Projects", "Clients", "Products", "People", "Inbox"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The route a path names, or undefined for `/` and paths that are not a LifeOS tab. */
export function parseRoute(pathname: string): Route | undefined {
  let segments: string[];
  try { segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment)); }
  catch { return undefined; }
  const [first, ...rest] = segments;
  const view = first ? viewsBySlug.get(first.toLowerCase()) : undefined;
  if (!view) return undefined;
  if (view === "Notes") {
    const deleted = rest[0] === "deleted";
    const id = deleted ? rest[1] : rest[0];
    return { view, noteTab: deleted ? "deleted" : "open", ...(id ? { id } : {}) };
  }
  if (view === "Calendar") {
    const [date, id] = rest;
    if (!date || !DAY.test(date)) return { view };
    return { view, date, ...(id ? { id } : {}) };
  }
  return itemViews.has(view) && rest[0] ? { view, id: rest[0] } : { view };
}

/** The path for a route; the inverse of `parseRoute`. */
export function routePath(route: Route): string {
  const parts = [slugs[route.view]];
  if (route.view === "Notes" && route.noteTab === "deleted") parts.push("deleted");
  if (route.view === "Calendar" && route.date) parts.push(route.date);
  if (route.id && (route.view === "Notes" || itemViews.has(route.view) || (route.view === "Calendar" && route.date))) parts.push(route.id);
  return `/${parts.map(encodeURIComponent).join("/")}`;
}

export type RouteData = { notes: LinkedObject[]; deletedNotes: LinkedObject[]; objects: LinkedObject[]; pendingReviewIds: string[] };
export type RouteTarget = { kind: "ok" } | { kind: "redirect"; route: Route } | { kind: "missing"; message: string };

const nouns: Partial<Record<View, string>> = { Tasks: "task", Decisions: "decision", "Open Points": "open point", Projects: "project", Clients: "client", Products: "product", People: "person" };

/**
 * Whether the item a route names can be opened. A note found in the other list (open vs deleted) is
 * moved there; anything unknown, deleted or of the wrong type shows the tab's list with an explanation.
 */
export function routeTarget(route: Route, data: RouteData): RouteTarget {
  const { id } = route;
  if (!id) return { kind: "ok" };
  const has = (list: LinkedObject[]) => list.some((object) => object.frontmatter.id === id);
  if (route.view === "Notes") {
    const [here, there] = route.noteTab === "deleted" ? [data.deletedNotes, data.notes] : [data.notes, data.deletedNotes];
    if (has(here)) return { kind: "ok" };
    if (has(there)) return { kind: "redirect", route: { ...route, noteTab: route.noteTab === "deleted" ? "open" : "deleted" } };
    return { kind: "missing", message: "That note no longer exists." };
  }
  if (route.view === "Inbox") return data.pendingReviewIds.includes(id) ? { kind: "ok" } : { kind: "missing", message: "That proposal is no longer waiting in the Inbox." };
  const target = resolveLifeosLink(`lifeos://object/${id}`, data.objects);
  if (route.view === "Calendar") return target.kind === "meeting" ? { kind: "ok" } : { kind: "missing", message: "That meeting no longer exists." };
  const noun = nouns[route.view];
  if (!noun) return { kind: "ok" };
  return target.kind === "entity" && target.view === route.view ? { kind: "ok" } : { kind: "missing", message: `That ${noun} no longer exists.` };
}
