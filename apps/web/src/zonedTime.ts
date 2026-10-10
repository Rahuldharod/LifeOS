// Local days and times in the user's display timezone, turned into portable UTC instants (and back).
// Shared by the calendar day view and the Decisions workspace (#41).

export function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The instant at which `date` (YYYY-MM-DD) at `time` (HH:MM) happens in `timeZone`, daylight saving included. */
export function zonedDateTime(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour ?? 0, minute ?? 0, 0);
  let guess = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    guess += target - represented;
  }
  return new Date(guess);
}

export function zonedMidnight(date: string, timeZone: string) {
  return zonedDateTime(date, "00:00", timeZone);
}

/**
 * Sets a filter's `from` / `to` query params (#116) from whole local days (YYYY-MM-DD, blank = open) in `timeZone`,
 * both ends inclusive: `from` is that day's midnight, `to` is 1 ms before the next day's midnight. The server
 * validates the range (an unparseable day throws here).
 */
export function dayRangeQuery(query: URLSearchParams, fromDay: string, toDay: string, timeZone: string) {
  if (fromDay) query.set("from", zonedMidnight(fromDay, timeZone).toISOString());
  if (toDay) query.set("to", new Date(zonedMidnight(addCalendarDays(toDay, 1), timeZone).getTime() - 1).toISOString());
}

/** `YYYY-MM-DDTHH:MM` for a `datetime-local` input showing `instant` in `timeZone`. */
export function zonedInputValue(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
