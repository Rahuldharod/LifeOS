import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #48 (PRD "Daily Focus and Today" → live panels): Today's panels are computed fresh from the index,
// the calendar and `_inbox/`, never from the brief, plus the Today settings (meeting-hours threshold, brief time).

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// 12:00 in Paris (UTC+2) on 5 October; the local day runs 2026-10-04T22:00Z → 2026-10-05T22:00Z.
const now = new Date("2026-10-05T10:00:00.000Z");
const date = "2026-10-05";
const timeZone = "Europe/Paris";
const at = (time: string) => `2026-10-05T${time}:00.000Z`;

function event(externalId: string, startsAt: string, endsAt: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { externalId, calendarId: "work", calendarName: "Work", title: `Meeting ${externalId}`, startsAt, endsAt, timezone: timeZone, attendees: [], ...extra };
}

class FakeCalendar implements CalendarConnector {
  readonly provider = "google";
  failure?: Error;
  constructor(public events: CalendarEvent[] = []) {}
  async listEvents(from: Date, to: Date) {
    if (this.failure) throw this.failure;
    return this.events.filter((candidate) => Date.parse(candidate.startsAt) < to.getTime() && Date.parse(candidate.endsAt) > from.getTime());
  }
}

async function vault(calendar?: FakeCalendar) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-today-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

async function task(application: LifeOSApplication, title: string, fields: Record<string, unknown> = {}) {
  const { status, ...rest } = fields;
  // Done needs `completed_at`, which only the update path sets.
  const created = await application.createEntity("task", status === "Done" ? { title, ...rest } : { title, ...fields });
  if (status === "Done") await application.updateEntity(created.frontmatter.id, { status }, created.contentHash);
  return created.frontmatter.id;
}
async function person(store: MarkdownObjectStore, title: string, email: string) {
  const id = uuidV7();
  const [given, family] = title.split(" ");
  await store.write({ relativePath: `people/${id}.md`, frontmatter: { id, type: "person", schema_version: 1, revision: 1, title, created_at: at("08:00"), updated_at: at("08:00"), updated_by_device: "test", given_name: given, family_name: family, identifiers: [{ kind: "email", value: email }] }, body: `# ${title}\n` });
  return id;
}
async function meeting(store: MarkdownObjectStore, title: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) {
  const id = uuidV7();
  await store.write({ relativePath: `meetings/${id}.md`, frontmatter: { id, type: "meeting", schema_version: 1, revision: 1, title, created_at: startsAt, updated_at: startsAt, updated_by_device: "test", status: "confirmed", starts_at: startsAt, ends_at: endsAt, timezone: timeZone, attendee_ids: [], ...extra }, body: `# ${title}\n` });
  return id;
}
async function inboxFile(root: string, folder: string, name: string, fields: Record<string, unknown>, ageMs = 60_000) {
  const target = path.join(root, "_inbox", folder, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify(fields)}---\nBody\n`);
  const past = new Date(Date.now() - ageMs);
  await utimes(target, past, past);
}
const titles = (objects: Array<{ frontmatter: { title: string } }>) => objects.map((object) => object.frontmatter.title);
const panels = (application: LifeOSApplication) => application.todayPanels({ date, now, timeZone });

describe("Today task panels", () => {
  it("lists overdue, due today and upcoming high-priority work, and follows live changes", async () => {
    const { application } = await vault();
    const late = await task(application, "Late report", { due_on: "2026-10-01" });
    await task(application, "Pay invoice", { due_on: date });
    await task(application, "Board deck", { priority: "High", due_on: "2026-10-09" });
    await task(application, "Strategy memo", { priority: "High" });
    await task(application, "Urgent today", { priority: "High", due_on: date });
    await task(application, "Low later", { priority: "Low", due_on: "2026-10-07" });
    await task(application, "Finished", { priority: "High", status: "Done", due_on: "2026-10-08" });

    let view = await panels(application);
    expect(titles(view.overdue)).toEqual(["Late report"]);
    expect(titles(view.dueToday).sort()).toEqual(["Pay invoice", "Urgent today"]);
    // Due today or overdue belongs to those panels; dated work comes before undated.
    expect(titles(view.upcomingHighPriority)).toEqual(["Board deck", "Strategy memo"]);

    const current = (await application.tasks()).find((object) => object.frontmatter.id === late)!;
    await application.updateTask(late, { status: "Done" }, current.contentHash);
    view = await panels(application);
    expect(view.overdue).toEqual([]);
  });

  it("ignores the Daily Focus brief: panels come from the index only", async () => {
    const { root, application } = await vault();
    const gone = await task(application, "Already done", { due_on: "2026-10-01", status: "Done" });
    await inboxFile(root, "drafts", "focus.md", { lifeos_draft: 1, kind: "daily-focus", draft_key: "focus-1", origin: "agent-extracted", title: "Daily Focus", captured_at: at("04:00"), focus_on: date, generated_at: at("04:00"), i_owe: [{ task_id: gone, overdue: true }], top3: [{ task_id: gone, why_today: "Because" }] });
    await application.adoptDrafts({ now });
    const view = await panels(application);
    expect(view.overdue).toEqual([]);
    expect(view.dueToday).toEqual([]);
  });

  it("groups waiting tasks by person, most-waited-on first, with the external marker and an unknown-person group last", async () => {
    const { store, application } = await vault();
    const joel = await person(store, "Joel Martin", "joel@client.example");
    const anna = await person(store, "Anna Roux", "anna@eagleeye.com");
    await application.rebuildIndex();
    await task(application, "Signed DPA", { status: "Waiting", waiting_for_person_id: joel });
    await task(application, "Pilot data", { status: "Waiting", waiting_for_person_id: joel });
    await task(application, "Budget sign-off", { status: "Waiting", waiting_for_person_id: anna });
    await task(application, "Vendor quote", { status: "Waiting" });

    const groups = (await panels(application)).waitingByPerson;
    expect(groups.map((group) => [group.label, group.isExternal, titles(group.tasks).sort()])).toEqual([
      ["Joel - ext", true, ["Pilot data", "Signed DPA"]],
      ["Anna", false, ["Budget sign-off"]],
      ["No person recorded", false, ["Vendor quote"]]
    ]);
    expect(groups[0]!.personId).toBe(joel);
    expect(groups[2]!.personId).toBeUndefined();
  });
});

describe("Today meetings panels", () => {
  it("lists the rest of the local day's timed, accepted meetings and sums the day's meeting hours", async () => {
    const calendar = new FakeCalendar([
      event("early", "2026-10-04T22:30:00.000Z", "2026-10-04T23:30:00.000Z"), // 00:30 Paris: today, already over
      event("now", at("09:30"), at("10:30")),
      event("later", at("13:00"), at("14:30"), { title: "Carrefour QBR" }),
      event("all-day", "2026-10-04T22:00:00.000Z", "2026-10-05T22:00:00.000Z", { isAllDay: true }),
      event("declined", at("15:00"), at("16:00"), { declined: true }),
      event("hidden", at("16:00"), at("17:00"), { calendarId: "personal" }),
      event("tomorrow", "2026-10-05T22:30:00.000Z", "2026-10-05T23:00:00.000Z") // 00:30 Paris on the 6th
    ]);
    const { store, application } = await vault(calendar);
    await application.saveCalendarPreferences({ disabledCalendarIds: ["personal"] });
    const manual = await meeting(store, "Coffee with Anna", at("16:30"), at("17:00"));
    const restricted = await meeting(store, "HR one-to-one", at("11:00"), at("11:30"), { sensitivity: "restricted" });
    await application.rebuildIndex();
    await application.createMeetingFromEvent("later", new Date(at("00:00")), new Date(at("23:00")), "work");

    const view = await panels(application);
    expect(view.nextMeetings.map((entry) => [entry.title, entry.inProgress])).toEqual([
      ["Meeting now", true], ["HR one-to-one", false], ["Carrefour QBR", false], ["Coffee with Anna", false]
    ]);
    expect(view.nextMeetings.find((entry) => entry.title === "Carrefour QBR")).toMatchObject({ calendarEventId: "later", meetingId: expect.any(String), restricted: false });
    expect(view.nextMeetings.find((entry) => entry.meetingId === restricted)!.restricted).toBe(true);
    expect(view.nextMeetings.find((entry) => entry.meetingId === manual)).toBeDefined();
    // early 1 + now 1 + later 1.5 + manual 0.5 + restricted 0.5
    expect(view.meetingHours).toBe(4.5);
    expect(view.meetingHeavy).toBe(false);
    expect(view.calendarError).toBeUndefined();
  });

  it("flags a meeting-heavy day at the configured threshold (default 5 hours)", async () => {
    const calendar = new FakeCalendar([event("long", at("06:00"), at("11:00"))]);
    const { application } = await vault(calendar);
    expect(await panels(application)).toMatchObject({ meetingHours: 5, meetingHeavy: true });
    await application.saveTodaySettings({ meetingHoursThreshold: 6 });
    expect(await panels(application)).toMatchObject({ meetingHours: 5, meetingHeavy: false });
  });

  it("falls back to the index's meetings when the calendar cannot be read, and says so", async () => {
    const calendar = new FakeCalendar();
    calendar.failure = new Error("network down");
    const { store, application } = await vault(calendar);
    await meeting(store, "Synced earlier", at("12:00"), at("13:00"), { external_refs: [{ provider: "google", external_id: "x", calendar_id: "work" }] });
    await application.rebuildIndex();
    const view = await panels(application);
    expect(view.calendarError).toBe("network down");
    expect(view.nextMeetings.map((entry) => entry.title)).toEqual(["Synced earlier"]);
  });

  it("uses the index's meetings when no calendar is configured", async () => {
    const { store, application } = await vault();
    await meeting(store, "Yesterday", "2026-10-04T12:00:00.000Z", "2026-10-04T13:00:00.000Z");
    await meeting(store, "Afternoon", at("14:00"), at("15:00"));
    await application.rebuildIndex();
    const view = await panels(application);
    expect(view.nextMeetings.map((entry) => entry.title)).toEqual(["Afternoon"]);
    expect(view.calendarError).toBeUndefined();
  });

  it("lists open points linked to today's meetings: raised there, same project or client, or shared non-self attendees", async () => {
    const { store, application } = await vault();
    const joel = await person(store, "Joel Martin", "joel@client.example");
    const anna = await person(store, "Anna Roux", "anna@eagleeye.com");
    const project = (await application.createEntity("project", { title: "Pilot" })).frontmatter.id;
    const client = (await application.createEntity("client", { title: "Carrefour" })).frontmatter.id;
    await task(application, "Creates the self person");
    const self = (await application.listObjects()).find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true)!.frontmatter.id;
    const qbr = await meeting(store, "Carrefour QBR", at("13:00"), at("14:00"), { primary_project_id: project, primary_client_id: client, attendee_ids: [joel, self] });
    const lastWeek = await meeting(store, "QBR last week", "2026-09-28T13:00:00.000Z", "2026-09-28T14:00:00.000Z");
    await application.rebuildIndex();
    await application.createOpenPoint({ title: "Raised here", source_meeting_id: qbr });
    await application.createOpenPoint({ title: "Same project", primary_project_id: project, importance: "High" });
    await application.createOpenPoint({ title: "Same client", primary_client_id: client, source_meeting_id: lastWeek });
    await application.createOpenPoint({ title: "With Joel", people_ids: [joel] });
    await application.createOpenPoint({ title: "Only with me", people_ids: [self] });
    await application.createOpenPoint({ title: "With Anna", people_ids: [anna] });
    const resolved = await application.createOpenPoint({ title: "Resolved already", source_meeting_id: qbr });
    await application.resolveOpenPoint(resolved.frontmatter.id, { resolution_summary: "Done" }, resolved.contentHash);

    const rows = (await panels(application)).openPointsForMeetings;
    expect(rows.map((row) => [row.openPoint.frontmatter.title, row.link, row.meetingTitle])).toEqual([
      ["Raised here", "raised-in", "Carrefour QBR"], ["Same project", "project", "Carrefour QBR"], ["Same client", "client", "Carrefour QBR"], ["With Joel", "people", "Carrefour QBR"]
    ]);
  });
});

describe("Today inbox and agent panels", () => {
  it("counts review items, drafts and patches separately, lists failed drafts with reasons and stale Work Orders", async () => {
    const { root, application } = await vault();
    await inboxFile(root, "drafts", "a.md", { lifeos_draft: 1 }, 1_000);
    await inboxFile(root, "drafts", "b.md", { lifeos_draft: 1 }, 1_000);
    await inboxFile(root, "patches", "p.md", { lifeos_patch: 1 }, 1_000);
    await inboxFile(root, "failed", "bad.md", { lifeos_draft: 1 });
    await inboxFile(root, "failed", "bad.result.md", { lifeos_result: 1, outcome: "failed", errors: ["title: is required"] });
    await inboxFile(root, "requests", "old.md", { lifeos_work_order: 1, kind: "enrichment", requested_at: "2026-09-27T10:00:00.000Z" });
    await inboxFile(root, "requests", "fresh.md", { lifeos_work_order: 1, kind: "enrichment", requested_at: "2026-10-04T10:00:00.000Z" });

    const view = await panels(application);
    expect(view.inbox).toEqual({ awaiting: 3, drafts: 2, patches: 1 });
    expect(view.failedDrafts).toEqual([{ path: "_inbox/failed/bad.md", reason: "title: is required" }]);
    expect(view.staleWorkOrders).toEqual([{ path: "_inbox/requests/old.md", requestedAt: "2026-09-27T10:00:00.000Z", ageDays: 8 }]);
    expect(view.reviewCount).toBe(0);
    expect(await application.inboxStatus()).toMatchObject({ awaiting: 3, drafts: 2, patches: 1 });
  });
});

describe("Today settings", () => {
  it("defaults to a 5-hour threshold and a 06:00 Europe/Paris brief on workdays", async () => {
    const { application } = await vault();
    expect(await application.getTodaySettings()).toEqual({ meetingHoursThreshold: 5, briefTime: "06:00", briefTimeZone: "Europe/Paris", briefDays: ["mon", "tue", "wed", "thu", "fri"] });
    expect((await panels(application)).settings.meetingHoursThreshold).toBe(5);
  });

  it("saves a synced app-setting file and refuses invalid values and stale writes", async () => {
    const { root, application } = await vault();
    const saved = await application.saveTodaySettings({ meetingHoursThreshold: 4.5, briefTime: "07:15", briefDays: ["fri", "mon"] });
    expect(saved).toMatchObject({ meetingHoursThreshold: 4.5, briefTime: "07:15", briefTimeZone: "Europe/Paris", briefDays: ["mon", "fri"], contentHash: expect.any(String) });
    const file = parse((await readFile(path.join(root, "settings", "today.md"), "utf8")).split("---")[1]!) as Record<string, unknown>;
    expect(file).toMatchObject({ type: "app-setting", setting_key: "today", meeting_hours_threshold: 4.5, brief_time: "07:15", brief_time_zone: "Europe/Paris", brief_days: ["mon", "fri"] });

    await expect(application.saveTodaySettings({ meetingHoursThreshold: -1, briefTime: "25:00", briefTimeZone: "Mars/Olympus", briefDays: [] }, saved.contentHash))
      .rejects.toThrow("Meeting-hours threshold must be a number of hours from 0 to 24; Brief time must be HH:MM (24-hour); Brief time zone must be an IANA time zone such as Europe/Paris; Brief days must be one or more of");
    await expect(application.saveTodaySettings({ briefTime: "06:30" })).rejects.toThrow("changed on another device");
    const updated = await application.saveTodaySettings({ briefTime: "06:30" }, saved.contentHash);
    expect(updated).toMatchObject({ briefTime: "06:30", meetingHoursThreshold: 4.5 });
    expect(await application.getTodaySettings()).toEqual(updated);
  });
});
