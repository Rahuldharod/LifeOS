import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { LifeOSApplication, personEmails, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// No path may create a Person whose name is an email address while storing no email (an Email-only person, CONTEXT.md).

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

const startsAt = new Date(Date.now() + 3_600_000).toISOString();
const event = (externalId: string, attendees: CalendarEvent["attendeeDetails"]): CalendarEvent => ({ externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: [], attendeeDetails: attendees });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-bare-address-"));
  roots.push(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "integration-test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  const people = async () => (await application.listObjects()).filter((object) => object.frontmatter.type === "person" && object.frontmatter.is_self !== true);
  return { root, calendar, application, people };
}

async function dropDraft(root: string, name: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ lifeos_draft: 1, captured_at: "2026-10-04T09:15:00+02:00", ...fields })}---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

describe("no bare-address People", () => {
  it("treats a calendar attendee named only by an address as that email", async () => {
    const { calendar, application, people } = await setup();
    calendar.events = [event("e1", [{ displayName: "jane.doe@example.com" }]), event("e2", [{ email: "Jane.Doe@example.com", displayName: "Jane Doe" }])];
    await application.createMeetingFromEvent("e1");
    await application.createMeetingFromEvent("e2");
    const found = await people();
    expect(found.map((person) => [person.frontmatter.title, person.frontmatter.identifiers])).toEqual([["Jane Doe", [{ kind: "email", value: "jane.doe@example.com" }]]]);
  });

  it("stores the address when the user creates a Person named by one, and reuses the Person who already holds it", async () => {
    const { application, people } = await setup();
    const created = await application.createEntity("person", { title: "Kim Lee <kim.lee@example.com>" });
    expect(created.frontmatter).toMatchObject({ title: "Kim Lee", given_name: "Kim", family_name: "Lee" });
    expect(personEmails(created)).toEqual(["kim.lee@example.com"]);
    const again = await application.createEntity("person", { title: "KIM.LEE@example.com" });
    expect(again.frontmatter.id).toBe(created.frontmatter.id);
    expect(await people()).toHaveLength(1);
  });

  it("adopts a person draft titled with an address as the Person holding it", async () => {
    const { root, application, people } = await setup();
    const kim = await application.createEntity("person", { title: "Kim Lee", given_name: "Kim", family_name: "Lee" });
    await application.addPersonEmail(kim.frontmatter.id, "kim.lee@example.com", application.object(kim.frontmatter.id).contentHash);
    await dropDraft(root, "kim.md", { kind: "person", origin: "agent-extracted", draft_key: "kim-addr", title: "kim.lee@example.com" });
    await application.adoptDrafts();
    expect((await people()).map((person) => person.frontmatter.id)).toEqual([kim.frontmatter.id]);
  });
});
