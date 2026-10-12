import { dateInTimeZone } from "./zonedTime.js";
import type { Route } from "./routes.js";

type Linked = { frontmatter: Record<string, unknown> };

/**
 * #181: where "Show series" goes for a Note: the Calendar page of its newest linked Meeting, but only
 * when that Meeting belongs to a recurring series. A Legacy shared Note links several Meetings.
 */
export function noteSeriesRoute(note: Linked, objects: Linked[], timeZone: string): Route | undefined {
  const { meeting_id: single, meeting_ids: many } = note.frontmatter;
  const ids = new Set<string>([...(Array.isArray(many) ? many : []), single].filter((id): id is string => typeof id === "string"));
  const meetings = objects
    .filter((object) => object.frontmatter.type === "meeting" && ids.has(String(object.frontmatter.id)) && typeof object.frontmatter.starts_at === "string")
    .sort((a, b) => Date.parse(String(b.frontmatter.starts_at)) - Date.parse(String(a.frontmatter.starts_at)));
  const newest = meetings[0];
  if (!newest || typeof newest.frontmatter.recurrence_series_id !== "string") return undefined;
  return { view: "Calendar", date: dateInTimeZone(new Date(String(newest.frontmatter.starts_at)), timeZone), id: String(newest.frontmatter.id) };
}
