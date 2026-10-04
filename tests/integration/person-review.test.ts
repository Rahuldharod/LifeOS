import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #87: automatically created people stay flagged "unreviewed" (PRD story 72) until the user saves or confirms them.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

function event(externalId: string, attendeeDetails: CalendarAttendee[]): CalendarEvent {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  return { externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: attendeeDetails.map((attendee) => attendee.email ?? ""), attendeeDetails };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-person-review-"));
  roots.push(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "integration-test");
  await application.rebuildIndex();
  calendar.events = [event("e1", [{ email: "jean.dupont@example.com" }, { email: "marie.curie@example.com" }])];
  await application.createMeetingFromEvent("e1");
  const idOf = async (title: string) => (await application.listObjects()).find((object) => object.frontmatter.type === "person" && object.frontmatter.title === title)!.frontmatter.id;
  return { application, jean: await idOf("Jean Dupont"), marie: await idOf("Marie Curie") };
}

const labelOf = (application: LifeOSApplication, id: string) => application.personLabels().find((label) => label.id === id)!;

describe("unreviewed people (#87)", () => {
  it("marks calendar-created people unreviewed in their labels, and people the user creates not", async () => {
    const { application, jean } = await setup();
    expect(labelOf(application, jean).unreviewed).toBe(true);
    const own = await application.createEntity("person", { title: "Zoé Martin", given_name: "Zoé" });
    expect(labelOf(application, own.frontmatter.id).unreviewed).toBe(false);
  });

  it("confirming a person clears the marker with a guarded write, and repeating it writes nothing", async () => {
    const { application, jean } = await setup();
    const before = application.object(jean);
    // A stale hash (someone edited the person elsewhere) is refused and leaves the marker in place.
    await expect(application.confirmPersonReviewed(jean, "stale-hash")).rejects.toThrow();
    expect(application.object(jean).frontmatter.review_state).toBe("unreviewed");

    const confirmed = await application.confirmPersonReviewed(jean, before.contentHash);
    expect(confirmed.frontmatter.review_state).toBe("reviewed");
    expect(labelOf(application, jean).unreviewed).toBe(false);
    const audits = (await application.listObjects()).filter((object) => object.frontmatter.action === "person.reviewed" && object.frontmatter.object_id === jean);
    expect(audits).toHaveLength(1);

    const again = await application.confirmPersonReviewed(jean, application.object(jean).contentHash);
    expect(again.frontmatter.revision).toBe(confirmed.frontmatter.revision);
  });

  it("saving a person's details also counts as reviewing them", async () => {
    const { application, marie } = await setup();
    await application.updateEntity(marie, { job_title: "Buyer" }, application.object(marie).contentHash);
    expect(application.object(marie).frontmatter).toMatchObject({ job_title: "Buyer", review_state: "reviewed" });
    expect(labelOf(application, marie).unreviewed).toBe(false);
  });

  it("refuses to confirm something that is not a person", async () => {
    const { application } = await setup();
    const meeting = (await application.listObjects()).find((object) => object.frontmatter.type === "meeting")!;
    await expect(application.confirmPersonReviewed(meeting.frontmatter.id, meeting.contentHash)).rejects.toThrow();
  });
});
