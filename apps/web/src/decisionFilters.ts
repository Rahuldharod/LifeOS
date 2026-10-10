// Decisions list filters (#41) as the API query string. Dates are whole local days in the display
// timezone: "from" starts at that day's midnight, "to" ends just before the next day's midnight.
import { dayRangeQuery } from "./zonedTime.js";

export type DecisionFilterState = { projectId: string; clientId: string; productId: string; personId: string; status: string; fromDay: string; toDay: string };
export const noDecisionFilters: DecisionFilterState = { projectId: "", clientId: "", productId: "", personId: "", status: "", fromDay: "", toDay: "" };

export function decisionQuery(filters: DecisionFilterState, timeZone: string) {
  const query = new URLSearchParams();
  for (const key of ["projectId", "clientId", "productId", "personId", "status"] as const) if (filters[key]) query.set(key, filters[key]);
  dayRangeQuery(query, filters.fromDay, filters.toDay, timeZone);
  return query.toString();
}
