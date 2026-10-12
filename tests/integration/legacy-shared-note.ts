import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type { CalendarEvent } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";

// The ADR 0019 id formats, spelled out so the fixture does not depend on the code that is about to be removed (#178).
const recurrenceSeriesKey = (provider: string, event: Pick<CalendarEvent, "calendarId" | "seriesId">) => event.seriesId ? `${provider}:${event.calendarId ?? "default"}:${event.seriesId}` : undefined;
const recurrenceOccurrenceId = (provider: string, event: Pick<CalendarEvent, "calendarId" | "seriesId" | "originalOccurrenceStartsAt">) => `${recurrenceSeriesKey(provider, event)}:${event.originalOccurrenceStartsAt}`;
const occurrenceSectionId = (original: string) => `occurrence-${original.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}`;

/**
 * #172: creating a recurring occurrence no longer builds a shared Note (ADR 0021), but Legacy shared Notes (ADR 0019)
 * still exist in real vaults until the removal slice (#178). Tests that cover that stored shape write one straight
 * into the vault, exactly as ADR 0019 laid it out: one Note, `meeting_ids`, `occurrence_sections` and a section
 * heading plus anchor per occurrence, newest first. The caller rebuilds the index afterwards.
 */
export async function seedLegacySharedNote(root: string, provider: string, occurrences: Array<{ event: CalendarEvent; body: string }>, noteFrontmatter: Record<string, unknown> = {}) {
  const timestamp = "2026-10-01T08:00:00.000Z";
  const stamp = { schema_version: 1, revision: 1, created_at: timestamp, updated_at: timestamp, updated_by_device: "test" };
  await mkdir(path.join(root, "meetings"), { recursive: true });
  const ordered = [...occurrences].sort((left, right) => Date.parse(right.event.startsAt) - Date.parse(left.event.startsAt));
  const items = [];
  for (const { event, body } of ordered) {
    const meetingId = uuidV7();
    const seriesKey = recurrenceSeriesKey(provider, event)!;
    const occurrenceId = recurrenceOccurrenceId(provider, event)!;
    const sectionId = occurrenceSectionId(event.originalOccurrenceStartsAt!);
    const meeting = {
      id: meetingId, type: "meeting", ...stamp, title: event.title, origin: "calendar", status: event.status === "cancelled" ? "cancelled" : "scheduled",
      starts_at: event.startsAt, ends_at: event.endsAt, timezone: event.timezone, attendee_ids: [], attendee_snapshot: [...event.attendees],
      recurrence_series_id: seriesKey, ...(event.seriesUid ? { recurrence_series_uid: event.seriesUid } : {}), recurrence_occurrence_id: occurrenceId, original_occurrence_starts_at: event.originalOccurrenceStartsAt,
      external_refs: [{ provider, external_id: event.externalId, calendar_id: event.calendarId, series_id: event.seriesId, original_occurrence_starts_at: event.originalOccurrenceStartsAt }]
    };
    await writeFile(path.join(root, "meetings", `${meetingId}.md`), `---\n${stringify(meeting).trimEnd()}\n---\n# ${event.title}\n`);
    items.push({ meetingId, occurrenceId, sectionId, event, body, section: { occurrence_id: occurrenceId, section_id: sectionId, meeting_id: meetingId, original_starts_at: event.originalOccurrenceStartsAt!, starts_at: event.startsAt } });
  }
  const first = ordered[0]!.event;
  const noteId = uuidV7();
  const note = {
    id: noteId, type: "meeting-note", ...stamp, title: `${first.title} notes`, origin: "app", meeting_id: items[0]!.meetingId, meeting_ids: items.map((item) => item.meetingId),
    recurrence_series_id: recurrenceSeriesKey(provider, first), generated_title: `${first.title} notes`, ...(first.seriesUid ? { recurrence_series_uid: first.seriesUid } : {}),
    occurrence_sections: items.map((item) => item.section), ...noteFrontmatter
  };
  const body = items.map((item) => `## ${item.event.title} — ${item.event.startsAt}\n<a id="${item.sectionId}"></a>\n\n${item.body}`).join("\n\n");
  await writeFile(path.join(root, "meetings", `${noteId}-note.md`), `---\n${stringify(note).trimEnd()}\n---\n${body}`);
  return { noteId, items };
}
