// #120: request checks that several routes share, each written once. Messages stay with the routes that send them.

export const invalidCalendarRange = "Enter a valid calendar date range";

/**
 * The optional `from`/`to` instants of a calendar request; undefined when either is not a date or `from` is not
 * before `to`. Route-level rule only: the use-case and browser copies are #116's.
 */
export function calendarRange(query: { from?: string; to?: string }): { from?: Date; to?: Date } | undefined {
  const from = query.from ? new Date(query.from) : undefined;
  const to = query.to ? new Date(query.to) : undefined;
  return (from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to) ? undefined : { from, to };
}

/** A calendar day as the browser sends it: the user's local date, `YYYY-MM-DD`. */
export const isCalendarDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Whether a write carries the expected content hash it was based on (a stale one answers 409). */
export const hasExpectedHash = <Body extends { expectedHash?: unknown }>(body: Body | undefined): body is Body & { expectedHash: string } => typeof body?.expectedHash === "string";
