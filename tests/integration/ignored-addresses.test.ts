import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, personEmails, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// "Not a person" and Ignored addresses (CONTEXT.md): a mailing list's Person is archived and future invites skip its address.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

const startsAt = new Date(Date.now() + 3_600_000).toISOString();
const invite = (externalId: string, emails: string[]): CalendarEvent => ({ externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: emails, attendeeDetails: emails.map((email) => ({ email })) });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-ignored-"));
  roots.push(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "integration-test");
  await application.rebuildIndex();
  calendar.events = [invite("e1", ["team@example.com", "kim.lee@example.com"])];
  await application.createMeetingFromEvent("e1");
  const team = application.entities("person").find((person) => personEmails(person).includes("team@example.com"))!;
  return { root, calendar, application, team };
}

describe("Not a person", () => {
  it("archives the Person, ignores its address, and later invites never turn it into an Attendee", async () => {
    const { root, calendar, application, team } = await setup();
    await application.markNotAPerson(team.frontmatter.id, team.contentHash);
    expect(application.object(team.frontmatter.id).frontmatter.archived_at).toEqual(expect.any(String));
    expect((await application.getIgnoredAddresses()).emails).toEqual(["team@example.com"]);
    expect(await readFile(path.join(root, "settings", "ignored-addresses.md"), "utf8")).toContain("team@example.com");

    calendar.events = [invite("e2", ["Team@Example.com", "kim.lee@example.com"])];
    const workspace = await application.createMeetingFromEvent("e2");
    const kim = application.entities("person").find((person) => person.frontmatter.title === "Kim Lee")!;
    expect(workspace.meeting.frontmatter.attendee_ids).toEqual([kim.frontmatter.id]);
  });

  it("refuses the Self person and a Person with no email address", async () => {
    const { application } = await setup();
    const self = application.entities("person").find((person) => person.frontmatter.is_self === true);
    if (self) await expect(application.markNotAPerson(self.frontmatter.id, self.contentHash)).rejects.toThrow(/yourself/);
    const nameOnly = await application.createEntity("person", { title: "Robin" });
    await expect(application.markNotAPerson(nameOnly.frontmatter.id, nameOnly.contentHash)).rejects.toThrow(/no email address/);
  });

  it("lets the user take an address off the ignore list", async () => {
    const { calendar, application, team } = await setup();
    await application.markNotAPerson(team.frontmatter.id, team.contentHash);
    const { contentHash } = await application.getIgnoredAddresses();
    await application.saveIgnoredAddresses([], contentHash);
    calendar.events = [invite("e3", ["team@example.com"])];
    const workspace = await application.createMeetingFromEvent("e3");
    expect(workspace.meeting.frontmatter.attendee_ids).toEqual([team.frontmatter.id]);
  });
});
