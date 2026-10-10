// Notes list filters (#105) as state, as the API query string, and as text for the empty state.
// Dates are whole local days in the display timezone, both ends inclusive, as in the Decisions filters (#41).
import { dayRangeQuery } from "./zonedTime.js";

export type NoteFilterState = { types: string[]; projectId: string; clientId: string; productId: string; personId: string; fromDay: string; toDay: string };
export const noNoteFilters: NoteFilterState = { types: [], projectId: "", clientId: "", productId: "", personId: "", fromDay: "", toDay: "" };
export const noteTypeLabels: Record<string, string> = { "meeting-note": "Meeting notes", "knowledge-note": "Knowledge notes" };

const contextKeys = ["projectId", "clientId", "productId", "personId"] as const;

export function noteListQuery(state: "open" | "deleted", keyword: string, filters: NoteFilterState, timeZone: string) {
  const query = new URLSearchParams({ state });
  if (keyword.trim()) query.set("q", keyword.trim());
  for (const type of filters.types) query.append("type", type);
  for (const key of contextKeys) if (filters[key]) query.set(key, filters[key]);
  dayRangeQuery(query, filters.fromDay, filters.toDay, timeZone);
  return query.toString();
}

/** One per active control: Type counts once, the date range counts once. The keyword is not a filter. */
export function activeNoteFilterCount(filters: NoteFilterState) {
  return Number(filters.types.length > 0) + contextKeys.filter((key) => filters[key]).length + Number(Boolean(filters.fromDay || filters.toDay));
}

/** Names of the active filters, and whether a project/client/product/person filter hides knowledge notes. */
export function describeNoteFilters(filters: NoteFilterState, state: "open" | "deleted") {
  const names = { projectId: "Project", clientId: "Client", productId: "Product", personId: "Person" } as const;
  const labels = [
    ...(filters.types.length ? ["Type"] : []),
    ...contextKeys.filter((key) => filters[key]).map((key) => names[key]),
    ...(filters.fromDay || filters.toDay ? [state === "open" ? "Last edited" : "Deleted"] : [])
  ];
  return { labels, meetingOnlyRule: contextKeys.some((key) => filters[key]) };
}

/** The empty-list text: what is active (keyword and filters), and the meeting-notes-only rule when it applies. */
export function emptyNotesMessage(state: "open" | "deleted", keyword: string, filters: NoteFilterState) {
  const word = keyword.trim();
  const { labels, meetingOnlyRule } = describeNoteFilters(filters, state);
  if (!word && !labels.length) return state === "open" ? "No notes have been created yet." : "No deleted notes.";
  const quoted = word ? ` “${word}”` : "";
  const withFilters = labels.length ? `${word ? " with" : ""} these filters: ${labels.join(", ")}` : "";
  return `No ${state} notes match${quoted}${withFilters}.${meetingOnlyRule ? " Project, client, product and person only match meeting notes." : ""}`;
}
