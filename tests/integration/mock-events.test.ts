import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCalendarConnector, mockEventsFromEnv } from "@lifeos/connectors";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const fileWith = async (content: string) => {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-mock-events-"));
  roots.push(root);
  const file = path.join(root, "events.json");
  await writeFile(file, content);
  return file;
};
const event = { externalId: "fixed-1", calendarId: "mock-calendar", title: "Fixed", startsAt: "2026-09-28T08:00:00.000Z", endsAt: "2026-09-28T09:00:00.000Z", timezone: "Europe/Paris", attendees: [] };

describe("LIFEOS_MOCK_EVENTS (#172, browser tests only)", () => {
  it("is read only when the mock calendar is selected", async () => {
    const file = await fileWith(JSON.stringify([event]));
    expect(mockEventsFromEnv({ LIFEOS_CALENDAR: "mock", LIFEOS_MOCK_EVENTS: file })).toEqual([event]);
    expect(mockEventsFromEnv({ LIFEOS_MOCK_EVENTS: file })).toEqual([]);
    expect(mockEventsFromEnv({ LIFEOS_CALENDAR: "google", LIFEOS_MOCK_EVENTS: file })).toEqual([]);
    expect(mockEventsFromEnv({ LIFEOS_CALENDAR: "mock" })).toEqual([]);
  });

  it("is ignored even when unreadable if the mock calendar is not selected", () => {
    expect(mockEventsFromEnv({ LIFEOS_MOCK_EVENTS: "/does/not/exist.json" })).toEqual([]);
  });

  it("fails at startup with a message that names the variable and the file", async () => {
    expect(() => mockEventsFromEnv({ LIFEOS_CALENDAR: "mock", LIFEOS_MOCK_EVENTS: "/does/not/exist.json" })).toThrow(/LIFEOS_MOCK_EVENTS.*\/does\/not\/exist\.json/);
    const broken = await fileWith("{ not json");
    expect(() => mockEventsFromEnv({ LIFEOS_CALENDAR: "mock", LIFEOS_MOCK_EVENTS: broken })).toThrow(/LIFEOS_MOCK_EVENTS.*not valid JSON/);
    const wrongShape = await fileWith(JSON.stringify({ events: [] }));
    expect(() => mockEventsFromEnv({ LIFEOS_CALENDAR: "mock", LIFEOS_MOCK_EVENTS: wrongShape })).toThrow(/LIFEOS_MOCK_EVENTS.*array of calendar events/);
  });

  it("returns the fixed events from the mock calendar only inside the requested window", async () => {
    const calendar = new MockCalendarConnector([event]);
    const inside = await calendar.listEvents(new Date("2026-09-28T00:00:00.000Z"), new Date("2026-09-29T00:00:00.000Z"));
    expect(inside.map((candidate) => candidate.externalId)).toContain("fixed-1");
    const outside = await calendar.listEvents(new Date("2026-09-01T00:00:00.000Z"), new Date("2026-09-02T00:00:00.000Z"));
    expect(outside.map((candidate) => candidate.externalId)).not.toContain("fixed-1");
  });
});
