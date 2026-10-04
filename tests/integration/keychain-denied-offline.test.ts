import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent, type SecretStore } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { KeychainAccessDeniedError, KnownSecrets } from "@lifeos/secrets";
import { calendarSource } from "../../apps/server/src/calendar-source.js";
import { secretRefs } from "../../apps/server/src/connections.js";

// #94: a Keychain denied at startup must show the offline banner with the stored meetings, never the mock
// calendar's demo meetings as if they were real. Fakes only: no real Keychain, no real Google.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const from = new Date("2026-10-04T22:00:00.000Z");
const to = new Date("2026-10-05T22:00:00.000Z");
const at = (time: string) => `2026-10-05T${time}:00.000Z`;
const clientId = "example.apps.googleusercontent.com";

/** A Keychain whose prompts the user denies until `allow` is set. */
class DenyingKeychain implements SecretStore {
  allow = false;
  reads = 0;
  readonly values = new Map<string, string>();
  async get(reference: string) { this.reads += 1; if (!this.allow) throw new KeychainAccessDeniedError(); return this.values.get(reference); }
  async set(reference: string, value: string) { if (!this.allow) throw new KeychainAccessDeniedError(); this.values.set(reference, value); }
}

/** Stands in for the Google connector: never calls Google. */
class FakeGoogle implements CalendarConnector {
  readonly provider = "google";
  async listEvents() { return [{ externalId: "standup", calendarId: "work", title: "Standup", startsAt: at("09:00"), endsAt: at("09:30"), timezone: "Europe/Paris", attendees: [] }] as CalendarEvent[]; }
  async listCalendars() { return [{ id: "work", name: "Work" }]; }
}

async function setUp(keychain: SecretStore, mockOnly = false) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-keychain-offline-"));
  roots.push(root);
  const secrets = new KnownSecrets(keychain);
  const created: string[] = [];
  const source = calendarSource({ secrets, mockOnly, mock: new MockCalendarConnector(), createGoogle: (id) => { created.push(id); return new FakeGoogle(); } });
  await source.probe().catch(() => undefined);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), source.calendar, undefined, "test");
  const id = uuidV7();
  await store.write({ relativePath: `meetings/${id}.md`, frontmatter: { id, type: "meeting", schema_version: 1, revision: 1, title: "Board prep", created_at: at("08:00"), updated_at: at("08:00"), updated_by_device: "test", status: "confirmed", starts_at: at("11:00"), ends_at: at("12:00"), timezone: "Europe/Paris", attendee_ids: [] }, body: "# Board prep\n" });
  await application.rebuildIndex();
  return { source, application, created };
}

const demoTitles = async () => (await new MockCalendarConnector().listEvents(from, to)).map((event) => event.title);

describe("Keychain denied at startup (#94)", () => {
  it("answers the calendar endpoints with the offline keychain-denied state and stored meetings, never mock data", async () => {
    const { application } = await setUp(new DenyingKeychain());
    for (const sync of [false, true]) {
      const day = await application.calendarDay(from, to, { sync });
      expect(day.offline).toMatchObject({ reason: "keychain-denied", error: "Keychain access denied" });
      expect(day.events.map((event) => event.title)).toEqual(["Board prep"]);
    }
    const panels = await application.todayPanels({ date: "2026-10-05", now: new Date(at("10:00")), timeZone: "Europe/Paris" });
    expect(panels.calendarOffline?.reason).toBe("keychain-denied");
    const titles = panels.nextMeetings.map((meeting) => meeting.title);
    for (const demo of await demoTitles()) expect(titles).not.toContain(demo);
    await expect(application.listCalendarEvents(from, to)).rejects.toThrow("Keychain access denied");
    await expect(application.listCalendars()).rejects.toThrow("Keychain access denied");
  });

  it("keeps the offline state when Retry is still denied, and recovers once the Keychain answers", async () => {
    const keychain = new DenyingKeychain();
    const { source, application, created } = await setUp(keychain);
    await source.probe().catch(() => undefined); // Retry, still denied
    expect((await application.calendarDay(from, to)).offline?.reason).toBe("keychain-denied");

    keychain.allow = true;
    keychain.values.set(secretRefs.calendarClientId, clientId);
    await source.probe(); // Retry, allowed this time
    expect(created).toEqual([clientId]);
    const day = await application.calendarDay(from, to);
    expect(day.offline).toBeUndefined();
    expect(day.events.map((event) => event.title)).toEqual(["Standup"]);
  });

  it("never serves demo meetings outside dev mode, even when nothing is configured", async () => {
    const keychain = new DenyingKeychain();
    keychain.allow = true; // readable, but no Google client saved
    const { application, created } = await setUp(keychain);
    expect(created).toEqual([]);
    const day = await application.calendarDay(from, to);
    expect(day.offline).toBeUndefined();
    expect(day.events).toEqual([]);
    expect(await application.listCalendars()).toEqual([]);
  });

  it("uses the mock calendar only in explicit dev/mock mode, without reading any secret", async () => {
    const keychain = new DenyingKeychain();
    const { application } = await setUp(keychain, true);
    expect(keychain.reads).toBe(0);
    const day = await application.calendarDay(from, to);
    expect(day.offline).toBeUndefined();
    expect(day.events.map((event) => event.title)).toEqual(expect.arrayContaining(await demoTitles()));
  });
});
