import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent, type SecretStore } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { GoogleAuthError, GoogleCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { KeychainAccessDeniedError, KnownSecrets } from "@lifeos/secrets";

// #88 (PRD story 86, PB-022b): when Google Calendar is unreachable or the Keychain is denied, Today and the
// calendar view fall back to the meetings already stored in LifeOS, labelled offline, and recover on Retry.
// Fakes only: no real Google, no real Keychain.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const now = new Date("2026-10-05T10:00:00.000Z");
const from = new Date("2026-10-04T22:00:00.000Z");
const to = new Date("2026-10-05T22:00:00.000Z");
const at = (time: string) => `2026-10-05T${time}:00.000Z`;

class FakeCalendar implements CalendarConnector {
  readonly provider = "google";
  failure?: Error;
  calls = 0;
  constructor(public events: CalendarEvent[] = []) {}
  async listEvents(start: Date, end: Date) {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return this.events.filter((event) => Date.parse(event.startsAt) < end.getTime() && Date.parse(event.endsAt) > start.getTime());
  }
}

/** A Keychain whose prompts the user denies until `allow` is set. */
class DenyingKeychain implements SecretStore {
  allow = false;
  readonly values = new Map<string, string>();
  async get(reference: string) { if (!this.allow) throw new KeychainAccessDeniedError(); return this.values.get(reference); }
  async set(reference: string, value: string) { if (!this.allow) throw new KeychainAccessDeniedError(); this.values.set(reference, value); }
}

async function vault(calendar: CalendarConnector) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-calendar-offline-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test");
  await application.rebuildIndex();
  await application.recordGoogleConnection();
  return { root, store, application };
}

async function storedMeeting(store: MarkdownObjectStore, title: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) {
  const id = uuidV7();
  await store.write({ relativePath: `meetings/${id}.md`, frontmatter: { id, type: "meeting", schema_version: 1, revision: 1, title, created_at: startsAt, updated_at: startsAt, updated_by_device: "test", status: "confirmed", starts_at: startsAt, ends_at: endsAt, timezone: "Europe/Paris", attendee_ids: [], ...extra }, body: `# ${title}\n` });
  return id;
}

async function meetingFiles(root: string) {
  const folder = path.join(root, "meetings");
  const names = (await readdir(folder)).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(path.join(folder, name), "utf8")] as const)));
}

const liveEvent: CalendarEvent = { externalId: "standup", calendarId: "work", calendarName: "Work", title: "Standup", startsAt: at("09:00"), endsAt: at("09:30"), timezone: "Europe/Paris", attendees: ["ana@example.com"] };

describe("Calendar offline fallback (#88)", () => {
  it("lists the stored meetings for the range, labelled offline with the last sync time, when the network fails", async () => {
    const calendar = new FakeCalendar([liveEvent]);
    const { store, application } = await vault(calendar);
    // A successful sync first, so there is a last-synced time to show.
    const synced = await application.calendarDay(from, to, { sync: true });
    expect(synced.offline).toBeUndefined();
    expect(synced.events.map((event) => event.title)).toEqual(["Standup"]);
    const { lastSuccessfulSyncAt } = application.calendarSyncStatus();
    expect(lastSuccessfulSyncAt).toBeDefined();

    const linked = await storedMeeting(store, "Client review", at("13:00"), at("14:00"), { external_refs: [{ provider: "google", external_id: "review", calendar_id: "work" }] });
    await storedMeeting(store, "Manual call", at("15:00"), at("15:30"));
    await storedMeeting(store, "Tomorrow", "2026-10-06T09:00:00.000Z", "2026-10-06T10:00:00.000Z");
    await storedMeeting(store, "Archived", at("16:00"), at("17:00"), { deleted_at: at("08:00") });
    await application.rebuildIndex();

    calendar.failure = new TypeError("fetch failed");
    for (const sync of [false, true]) {
      const day = await application.calendarDay(from, to, { sync });
      expect(day.offline).toEqual({ reason: "network", error: "fetch failed", lastSuccessfulSyncAt });
      expect(day.events.map((event) => event.title)).toEqual(["Client review", "Manual call"]);
      expect(day.events[0]).toMatchObject({ externalId: "review", calendarId: "work", meetingId: linked, startsAt: at("13:00"), endsAt: at("14:00"), stored: true });
    }
  });

  it("falls back on an expired Google token, and on a denied Keychain from the real connector", async () => {
    const calendar = new FakeCalendar();
    calendar.failure = new GoogleAuthError("Google Calendar access expired or was revoked. Reconnect Google Calendar.", "expired");
    const { store, application } = await vault(calendar);
    await storedMeeting(store, "Board prep", at("11:00"), at("12:00"));
    await application.rebuildIndex();
    const auth = await application.calendarDay(from, to);
    expect(auth.offline).toMatchObject({ reason: "auth", lastSuccessfulSyncAt: undefined });
    expect(auth.events.map((event) => event.title)).toEqual(["Board prep"]);

    const keychain = new DenyingKeychain();
    const google = new GoogleCalendarConnector({ clientId: "client.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:4310/cb", secrets: new KnownSecrets(keychain) });
    const denied = await vault(google);
    await storedMeeting(denied.store, "Board prep", at("11:00"), at("12:00"));
    await denied.application.rebuildIndex();
    const day = await denied.application.calendarDay(from, to, { sync: true });
    expect(day.offline).toMatchObject({ reason: "keychain-denied", error: "Keychain access denied" });
    expect(day.events.map((event) => event.title)).toEqual(["Board prep"]);
  });

  it("recovers on retry once the calendar is reachable again, without restarting anything", async () => {
    const calendar = new FakeCalendar([liveEvent]);
    calendar.failure = new TypeError("fetch failed");
    const { application } = await vault(calendar);
    expect((await application.calendarDay(from, to)).offline?.reason).toBe("network");
    expect((await application.todayPanels({ date: "2026-10-05", now, timeZone: "Europe/Paris" })).calendarOffline?.reason).toBe("network");

    calendar.failure = undefined;
    const retried = await application.calendarDay(from, to, { sync: true });
    expect(retried.offline).toBeUndefined();
    expect(retried.events.map((event) => event.title)).toEqual(["Standup"]);
    const panels = await application.todayPanels({ date: "2026-10-05", now, timeZone: "Europe/Paris" });
    expect(panels.calendarOffline).toBeUndefined();
    expect(panels.calendarError).toBeUndefined();
  });

  it("Today's panels carry the offline state with the last sync time, and list the stored meetings", async () => {
    const calendar = new FakeCalendar([liveEvent]);
    const { store, application } = await vault(calendar);
    await application.calendarDay(from, to, { sync: true });
    const { lastSuccessfulSyncAt } = application.calendarSyncStatus();
    await storedMeeting(store, "Client review", at("13:00"), at("14:00"), { external_refs: [{ provider: "google", external_id: "review", calendar_id: "work" }] });
    await application.rebuildIndex();
    calendar.failure = new KeychainAccessDeniedError();
    const panels = await application.todayPanels({ date: "2026-10-05", now, timeZone: "Europe/Paris" });
    expect(panels.calendarOffline).toEqual({ reason: "keychain-denied", error: "Keychain access denied", lastSuccessfulSyncAt });
    expect(panels.nextMeetings.map((meeting) => meeting.title)).toEqual(["Client review"]);
  });

  it("changes and deletes no stored meeting while offline", async () => {
    const calendar = new FakeCalendar();
    const { root, store, application } = await vault(calendar);
    await storedMeeting(store, "Client review", at("13:00"), at("14:00"), { external_refs: [{ provider: "google", external_id: "review", calendar_id: "work" }] });
    await storedMeeting(store, "Manual call", at("15:00"), at("15:30"));
    await application.rebuildIndex();
    const before = await meetingFiles(root);

    for (const failure of [new TypeError("fetch failed"), new GoogleAuthError("expired", "expired"), new KeychainAccessDeniedError()]) {
      calendar.failure = failure;
      await application.calendarDay(from, to, { sync: true });
      await application.calendarDay(from, to);
      await application.todayPanels({ date: "2026-10-05", now, timeZone: "Europe/Paris" });
    }
    expect(await meetingFiles(root)).toEqual(before);
  });
});
