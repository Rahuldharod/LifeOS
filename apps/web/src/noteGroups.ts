// Groups the Latest notes list by calendar day in the display timezone (PB-023). The list is
// already sorted newest first, so groups come out newest first and keep each note's order.

/** "YYYY-MM-DD" for an instant, in `timeZone`. */
export function dayKey(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(value));
}

/** "Today", "Yesterday", "Thursday 1 October", or "Monday 29 December 2025" outside this year. */
export function dayLabel(key: string, timeZone: string, now = new Date()) {
  const today = dayKey(now, timeZone);
  if (key === today) return "Today";
  // Noon UTC keeps the calendar date stable whatever the offset; the key is already zone-local.
  const midday = new Date(`${key}T12:00:00.000Z`);
  if (key === dayKey(new Date(Date.parse(`${today}T12:00:00.000Z`) - 86_400_000), "UTC")) return "Yesterday";
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(midday).replace(",", "");
}

export function groupByDay<T>(items: T[], dateOf: (item: T) => string, timeZone: string, now = new Date()) {
  const groups: Array<{ key: string; label: string; items: T[] }> = [];
  for (const item of items) {
    const key = dayKey(dateOf(item), timeZone);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(key, timeZone, now), items: [item] });
  }
  return groups;
}
