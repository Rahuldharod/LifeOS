import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #44 (PRD "Enrichment Work Orders"): "Enrich last 48h" writes one Work Order to `_inbox/requests/`
// and moves each selected meeting's `enrichment_state` to `requested`.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const now = new Date("2026-10-04T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

/** An ended one-hour event that started `startedHoursAgo` before `now`. */
function event(externalId: string, startedHoursAgo: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { externalId, calendarId: "work", calendarName: "Work", title: `Meeting ${externalId}`, startsAt: hoursAgo(startedHoursAgo), endsAt: hoursAgo(startedHoursAgo - 1), timezone: "Europe/Paris", attendees: ["joel@client.example", "Robin Doe"], ...extra };
}

class FakeCalendar implements CalendarConnector {
  readonly provider = "google";
  failure?: Error;
  calls: Array<{ from: Date; to: Date }> = [];
  constructor(public events: CalendarEvent[]) {}
  async listEvents(from: Date, to: Date) {
    this.calls.push({ from, to });
    if (this.failure) throw this.failure;
    return this.events.filter((candidate) => Date.parse(candidate.startsAt) < to.getTime() && Date.parse(candidate.endsAt) > from.getTime());
  }
}

async function vault(events: CalendarEvent[]) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-enrichment-"));
  roots.push(root);
  const calendar = new FakeCalendar(events);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, calendar, application };
}

const requestFiles = async (root: string) => (await readdir(path.join(root, "_inbox", "requests")).catch(() => [] as string[])).filter((name) => name.endsWith(".md"));
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const range = { from: new Date(now.getTime() - 7 * 86_400_000), to: now };
const createMeeting = async (application: LifeOSApplication, externalId: string) => (await application.createMeetingFromEvent(externalId, range.from, range.to, "work")).meeting;

describe("Enrich last 48h Work Order", () => {
  it("lists emails of attendees the calendar only names, using the attendee details (#38)", async () => {
    const { root, application } = await vault([event("named", 3, { attendees: ["Joel Martin"], attendeeDetails: [{ email: "joel.martin@client.example", displayName: "Joel Martin" }] })]);
    await application.requestEnrichment({ now });
    const [file] = await requestFiles(root);
    const entries = (await frontmatterOf(path.join(root, "_inbox", "requests", file!))).meetings as Array<Record<string, unknown>>;
    expect(entries[0]!.attendee_emails).toEqual(["joel.martin@client.example"]);
  });

  it("selects ended, timed, accepted events from selected calendars in the last 48 h, with or without a meeting", async () => {
    const { root, application, calendar } = await vault([
      event("with-meeting", 3),
      event("no-meeting", 30, { attendees: ["anna@example.com", "Bob Builder", "ANNA@example.com"] }),
      event("too-old", 50),
      event("in-progress", 0.5),
      event("future", -2),
      event("all-day", 20, { isAllDay: true }),
      event("declined", 10, { declined: true }),
      event("hidden-calendar", 5, { calendarId: "personal", calendarName: "Personal" })
    ]);
    await application.saveCalendarPreferences({ disabledCalendarIds: ["personal"] });
    const meeting = await createMeeting(application, "with-meeting");

    const result = await application.requestEnrichment({ now });

    expect(calendar.calls.at(-1)).toEqual({ from: new Date(hoursAgo(48)), to: now });
    expect(result.workOrder).toMatch(/^_inbox\/requests\/2026-10-04-1200-enrich-last-48h--[0-9a-f-]{36}\.md$/);
    expect(result.meetings.map((entry) => entry.calendarEventId)).toEqual(["no-meeting", "with-meeting"]);
    const files = await requestFiles(root);
    expect(files).toHaveLength(1);
    const order = await frontmatterOf(path.join(root, result.workOrder!));
    expect(order).toMatchObject({ lifeos_work_order: 1, kind: "enrichment", requested_at: now.toISOString(), window_start: hoursAgo(48), window_end: now.toISOString() });
    const entries = order.meetings as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      calendar_event_id: "no-meeting", calendar_id: "work", title: "Meeting no-meeting", starts_at: hoursAgo(30), ends_at: hoursAgo(29), timezone: "Europe/Paris",
      attendee_emails: ["anna@example.com"], existing_sources: [], missing_material: ["meet-transcript", "meet-recording", "gong-call", "gong-summary-email"]
    });
    expect(entries[1]).toMatchObject({ meeting_id: meeting.frontmatter.id, calendar_event_id: "with-meeting", note_path: expect.stringMatching(/^meetings\/.+-notes--.+\.md$/), attendee_emails: ["joel@client.example"] });
    // The body tells the Agent what to do, in plain words.
    expect(await readFile(path.join(root, result.workOrder!), "utf8")).toContain("meeting-material");
  });

  it("marks selected meetings requested and keeps enriched and gave_up meetings out", async () => {
    const { root, store, application } = await vault([event("a", 3), event("b", 4), event("c", 5)]);
    const a = await createMeeting(application, "a");
    const b = await createMeeting(application, "b");
    const c = await createMeeting(application, "c");
    await store.write({ relativePath: b.relativePath, expectedHash: b.contentHash, frontmatter: { ...b.frontmatter, revision: b.frontmatter.revision + 1, enrichment_state: "enriched" }, body: b.body });
    await application.rebuildIndex();
    await application.markEnrichmentGaveUp(c.frontmatter.id, application.object(c.frontmatter.id).contentHash);

    const result = await application.requestEnrichment({ now });
    expect(result.meetings.map((entry) => entry.calendarEventId)).toEqual(["a"]);
    const requested = application.object(a.frontmatter.id);
    expect(requested.frontmatter).toMatchObject({ enrichment_state: "requested", enrichment_requested_at: now.toISOString(), enrichment_work_order: result.workOrder, revision: a.frontmatter.revision + 1 });
    expect(application.object(c.frontmatter.id).frontmatter.enrichment_state).toBe("gave_up");
    expect(application.object(b.frontmatter.id).frontmatter.enrichment_state).toBe("enriched");
    const onDisk = await frontmatterOf(path.join(root, requested.relativePath));
    expect(onDisk.enrichment_state).toBe("requested");
    const audits = (await application.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "meeting.enrichment-requested");
    expect(audits.map((audit) => audit.frontmatter.object_id)).toEqual([a.frontmatter.id]);
  });

  it("re-requests requested and partial meetings and lists existing sources and the material still missing", async () => {
    const { root, store, application } = await vault([event("a", 3)]);
    const meeting = await createMeeting(application, "a");
    const sourceId = uuidV7();
    const restrictedSourceId = uuidV7();
    const sourceEnvelope = (id: string, title: string) => ({ id, type: "source" as const, schema_version: 1, revision: 1, title, created_at: now.toISOString(), updated_at: now.toISOString(), updated_by_device: "test", captured_at: now.toISOString(), ingestion_status: "captured" });
    await store.write({ relativePath: `sources/transcript--${sourceId}.md`, frontmatter: { ...sourceEnvelope(sourceId, "Meet transcript"), source_type: "meet-transcript", meeting_id: meeting.frontmatter.id, url: "https://docs.example/t", external_id: "doc-1" }, body: "# Transcript\n" });
    await store.write({ relativePath: `sources/private--${restrictedSourceId}.md`, frontmatter: { ...sourceEnvelope(restrictedSourceId, "Private recording"), source_type: "meet-recording", meeting_id: meeting.frontmatter.id, sensitivity: "restricted" }, body: "# Private\n" });
    const current = await store.read(meeting.relativePath);
    await store.write({ relativePath: current.relativePath, expectedHash: current.contentHash, frontmatter: { ...current.frontmatter, revision: current.frontmatter.revision + 1, enrichment_state: "partial" }, body: current.body });
    await application.rebuildIndex();

    const result = await application.requestEnrichment({ now });
    const [entry] = (await frontmatterOf(path.join(root, result.workOrder!))).meetings as Array<Record<string, unknown>>;
    expect(entry!.existing_sources).toEqual([{ id: sourceId, source_type: "meet-transcript", path: `sources/transcript--${sourceId}.md`, url: "https://docs.example/t", external_id: "doc-1" }]);
    // #63: a restricted Source still covers its material, so Claude is never sent to fetch it again.
    expect(entry!.missing_material).toEqual(["gong-call", "gong-summary-email"]);
    expect(JSON.stringify(entry)).not.toContain(restrictedSourceId);
    expect(application.object(meeting.frontmatter.id).frontmatter.enrichment_state).toBe("requested");

    // A second run re-requests the still-requested meeting in a new Work Order.
    const again = await application.requestEnrichment({ now: new Date(now.getTime() + 60_000) });
    expect(again.meetings).toHaveLength(1);
    expect(await requestFiles(root)).toHaveLength(2);
  });

  it("excludes a meeting when the meeting or its note is restricted (#63)", async () => {
    const { root, application } = await vault([event("secret", 3), event("noted", 4), event("open", 5)]);
    const secret = await createMeeting(application, "secret");
    const noted = await application.createMeetingFromEvent("noted", range.from, range.to, "work");
    await createMeeting(application, "open");
    await application.setSensitivity(secret.frontmatter.id, "restricted", application.object(secret.frontmatter.id).contentHash);
    await application.setSensitivity(noted.note!.frontmatter.id, "restricted", noted.note!.contentHash);

    const result = await application.requestEnrichment({ now });
    expect(result.meetings.map((entry) => entry.calendarEventId)).toEqual(["open"]);
    expect(result.restrictedExcluded).toBe(2);
    const content = await readFile(path.join(root, result.workOrder!), "utf8");
    expect(content).not.toContain("secret");
    expect(content).not.toContain("noted");
    expect(content).not.toContain(noted.meeting.frontmatter.id);
    expect(content).not.toContain(noted.note!.relativePath);
    expect(application.object(secret.frontmatter.id).frontmatter.enrichment_state).toBeUndefined();
    expect(application.object(noted.meeting.frontmatter.id).frontmatter.enrichment_state).toBeUndefined();
  });

  it("excludes every occurrence governed by one restricted recurring Note (#148)", async () => {
    const firstEvent = event("series-first", 30, { seriesId: "weekly-series", originalOccurrenceStartsAt: hoursAgo(30) });
    const secondEvent = event("series-second", 3, { seriesId: "weekly-series", originalOccurrenceStartsAt: hoursAgo(3) });
    const { root, application } = await vault([firstEvent, secondEvent]);
    const first = await application.createMeetingFromEvent(firstEvent.externalId, range.from, range.to, "work", "First occurrence\n");
    const second = await application.createMeetingFromEvent(secondEvent.externalId, range.from, range.to, "work", "Second occurrence\n");
    expect(first.note?.frontmatter.id).toBe(second.note?.frontmatter.id);
    await application.setSensitivity(first.note!.frontmatter.id, "restricted", second.note!.contentHash);

    const result = await application.requestEnrichment({ now });

    expect(result.meetings).toEqual([]);
    expect(result.restrictedExcluded).toBe(2);
    expect(result.workOrder).toBeUndefined();
    expect(await requestFiles(root)).toEqual([]);
    expect(application.object(first.meeting.frontmatter.id).frontmatter.enrichment_state).toBeUndefined();
    expect(application.object(second.meeting.frontmatter.id).frontmatter.enrichment_state).toBeUndefined();
  });

  it("never lists the email of a restricted person (#63)", async () => {
    const attendeeDetails = [{ email: "hidden@client.example", displayName: "Hidden Person" }, { email: "joel@client.example", displayName: "Joel Martin" }];
    const { root, application } = await vault([event("a", 3, { attendees: ["Hidden Person", "Joel Martin"], attendeeDetails })]);
    await createMeeting(application, "a");
    const hidden = (await application.listObjects()).find((object) => object.frontmatter.type === "person" && JSON.stringify(object.frontmatter.identifiers ?? []).includes("hidden@client.example"))!;
    await application.setSensitivity(hidden.frontmatter.id, "restricted", hidden.contentHash);

    const result = await application.requestEnrichment({ now });
    const [entry] = (await frontmatterOf(path.join(root, result.workOrder!))).meetings as Array<Record<string, unknown>>;
    expect(entry!.attendee_emails).toEqual(["joel@client.example"]);
    expect(await readFile(path.join(root, result.workOrder!), "utf8")).not.toContain("hidden@client.example");
  });

  it("writes no file and says so when no meeting qualifies", async () => {
    const { root, application } = await vault([event("too-old", 60), event("all-day", 5, { isAllDay: true })]);
    const result = await application.requestEnrichment({ now });
    expect(result).toEqual({ meetings: [], restrictedExcluded: 0, message: "No ended meetings from the last 48 hours need enrichment; no Work Order was written" });
    expect(await requestFiles(root)).toEqual([]);
  });

  it("fails clearly and writes nothing when the calendar is unreachable", async () => {
    const { root, application, calendar } = await vault([event("a", 3)]);
    const meeting = await createMeeting(application, "a");
    calendar.failure = new Error("getaddrinfo ENOTFOUND www.googleapis.com");
    await expect(application.requestEnrichment({ now })).rejects.toThrow("Could not read the calendar (getaddrinfo ENOTFOUND www.googleapis.com); no Work Order was written");
    expect(await requestFiles(root)).toEqual([]);
    expect(application.object(meeting.frontmatter.id).frontmatter.enrichment_state).toBeUndefined();

    // An expired Google login keeps its error name so the server still offers Reconnect.
    const expired = Object.assign(new Error("Google rejected the token"), { name: "GoogleAuthError" });
    calendar.failure = expired;
    await expect(application.requestEnrichment({ now })).rejects.toBe(expired);
  });

  it("lets the user give up on a meeting, and proposes it after 48 h with no material", async () => {
    const { application } = await vault([event("quiet", 3), event("busy", 4)]);
    const quiet = await createMeeting(application, "quiet");
    const busy = await createMeeting(application, "busy");
    expect(await application.markEnrichmentGaveUp(quiet.frontmatter.id, "stale-hash").catch((error: Error) => error.name)).toBe("ObjectConflictError");
    await application.requestEnrichment({ now });
    expect((await application.enrichmentStatus({ now: new Date(now.getTime() + 47 * 3_600_000) })).proposedGaveUp).toEqual([]);

    const later = new Date(now.getTime() + 49 * 3_600_000);
    const status = await application.enrichmentStatus({ now: later });
    expect(status.proposedGaveUp.map((entry) => entry.meetingId).sort()).toEqual([quiet.frontmatter.id, busy.frontmatter.id].sort());
    expect(status.proposedGaveUp[0]).toMatchObject({ title: expect.stringMatching(/^Meeting /), requestedAt: now.toISOString() });

    const gaveUp = await application.markEnrichmentGaveUp(quiet.frontmatter.id, application.object(quiet.frontmatter.id).contentHash);
    expect(gaveUp.frontmatter).toMatchObject({ enrichment_state: "gave_up" });
    expect((await application.enrichmentStatus({ now: later })).proposedGaveUp.map((entry) => entry.meetingId)).toEqual([busy.frontmatter.id]);
    // Repeating it writes nothing new.
    expect((await application.markEnrichmentGaveUp(quiet.frontmatter.id, gaveUp.contentHash)).contentHash).toBe(gaveUp.contentHash);
    const audits = (await application.listObjects()).filter((object) => object.frontmatter.action === "meeting.enrichment-gave-up");
    expect(audits).toHaveLength(1);
    await expect(application.markEnrichmentGaveUp(uuidV7(), "x")).rejects.toThrow("Object not found");
  });

  it("flags Work Orders left unprocessed for 7 days as stale on Today and in System", async () => {
    const real = new Date();
    const at = (hours: number) => new Date(real.getTime() - hours * 3_600_000).toISOString();
    const { root, application } = await vault([{ ...event("old", 0), startsAt: at(8 * 24 + 3), endsAt: at(8 * 24 + 2) }, { ...event("recent", 0), startsAt: at(3), endsAt: at(2) }]);
    const result = await application.requestEnrichment({ now: new Date(real.getTime() - 8 * 86_400_000) });
    const fresh = await application.requestEnrichment({ now: real });
    expect(fresh.workOrder).toBeDefined();
    // A file whose front matter cannot be read falls back to its modification time.
    const broken = path.join(root, "_inbox", "requests", "broken.md");
    await writeFile(broken, "---\n: [\n---\n");
    const old = new Date(real.getTime() - 9 * 86_400_000);
    await utimes(broken, old, old);

    const status = await application.enrichmentStatus();
    expect(status.staleWorkOrders.map((entry) => entry.path).sort()).toEqual(["_inbox/requests/broken.md", result.workOrder!].sort());
    expect(status.staleWorkOrders.find((entry) => entry.path === result.workOrder)!.ageDays).toBe(8);
    const health = await application.health();
    expect(health.status).toBe("attention");
    expect(health.diagnostics).toContain(`${result.workOrder}: Work Order not processed for 8 days`);
  });
});
