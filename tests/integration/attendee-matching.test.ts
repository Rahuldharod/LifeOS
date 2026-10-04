import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { derivePersonName, LifeOSApplication, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import type { LifeOSObject } from "@lifeos/domain";

// #38: calendar attendees link to People by email; unknown attendees become unreviewed People with derived names.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

function event(externalId: string, attendeeDetails: CalendarAttendee[], attendees = attendeeDetails.map((attendee) => attendee.displayName ?? attendee.email ?? "")): CalendarEvent {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  return { externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees, attendeeDetails };
}

async function setup(seed?: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-attendees-"));
  roots.push(root);
  await seed?.(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "integration-test");
  await application.rebuildIndex();
  return { root, calendar, application };
}

const people = async (application: LifeOSApplication) => (await application.listObjects()).filter((object) => object.frontmatter.type === "person");
const emails = (person: Pick<LifeOSObject, "frontmatter">) => (person.frontmatter.identifiers as Array<{ kind: string; value: string }>).filter((identifier) => identifier.kind === "email").map((identifier) => identifier.value);

describe("name derivation (#38)", () => {
  it.each([
    ["jean-pierre.dupont@acme.fr", undefined, { title: "Jean-Pierre Dupont", given_name: "Jean-Pierre", family_name: "Dupont" }],
    ["first_last@acme.com", undefined, { title: "First Last", given_name: "First", family_name: "Last" }],
    ["élodie.lefèvre@acme.fr", undefined, { title: "Élodie Lefèvre", given_name: "Élodie", family_name: "Lefèvre" }],
    ["JOHN.SMITH@Acme.com", undefined, { title: "John Smith", given_name: "John", family_name: "Smith" }],
    ["anne.marie.de-la-tour@acme.fr", undefined, { title: "Anne Marie De-La-Tour", given_name: "Anne", family_name: "Marie De-La-Tour" }],
    ["john.smith+calendar@acme.com", undefined, { title: "John Smith", given_name: "John", family_name: "Smith" }],
    ["jsmith@acme.com", "Jane Smith", { title: "Jane Smith", given_name: "Jane", family_name: "Smith" }],
    ["john.smith@acme.com", "Johnny S. Smith", { title: "Johnny S. Smith", given_name: "Johnny", family_name: "S. Smith" }],
    ["jsmith@acme.com", undefined, { title: "jsmith", given_name: "jsmith" }],
    ["jsmith@acme.com", "  ", { title: "jsmith", given_name: "jsmith" }],
    ["madonna@acme.com", "Madonna", { title: "Madonna", given_name: "Madonna" }],
    ["john.smith@acme.com", "john.smith@acme.com", { title: "John Smith", given_name: "John", family_name: "Smith" }]
  ])("%s with display name %s", (email, displayName, expected) => {
    const derived = derivePersonName(email, displayName);
    expect(derived).toEqual(expected);
  });
});

describe("attendee matching by email (#38)", () => {
  it("creates an unreviewed calendar Person with derived names, email identifier, organization and external flag", async () => {
    const { calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "Jean-Pierre.Dupont@Acme-Corp.fr" }, { email: "lea_martin@eagleeye.com" }, { email: "kim@gmail.com", displayName: "Kim Lee" }])];
    const workspace = await application.createMeetingFromEvent("e1");
    const [jp, lea, kim] = workspace.context.people;
    expect(jp!.frontmatter).toMatchObject({ title: "Jean-Pierre Dupont", given_name: "Jean-Pierre", family_name: "Dupont", origin: "calendar", review_state: "unreviewed", is_external: true, organization_name: "Acme-Corp", identifiers: [{ kind: "email", value: "jean-pierre.dupont@acme-corp.fr" }] });
    expect(lea!.frontmatter).toMatchObject({ title: "Lea Martin", given_name: "Lea", family_name: "Martin", is_external: false, organization_name: "Eagleeye" });
    // A free-mail domain is not an organization.
    expect(kim!.frontmatter).toMatchObject({ title: "Kim Lee", given_name: "Kim", family_name: "Lee", is_external: true });
    expect(kim!.frontmatter.organization_name).toBeUndefined();
    expect(workspace.meeting.frontmatter.attendee_ids).toEqual([jp, lea, kim].map((person) => person!.frontmatter.id));
  });

  it("links an existing Person by case-insensitive email instead of creating one", async () => {
    const existingId = "01995d3e-912b-7357-8aa6-9816c1ad90b1";
    const { calendar, application } = await setup(async (root) => {
      await mkdir(path.join(root, "people"), { recursive: true });
      await writeFile(path.join(root, "people", `alex--${existingId}.md`), `---\nid: ${existingId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: Alex M\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: Alex\nidentifiers:\n  - kind: email\n    value: Alex.Morgan@Example.com\n---\n# Alex M\n`);
    });
    calendar.events = [event("e1", [{ email: "ALEX.MORGAN@example.COM", displayName: "Alexander Morgan" }])];
    const workspace = await application.createMeetingFromEvent("e1");
    expect(workspace.context.people.map((person) => person.frontmatter.id)).toEqual([existingId]);
    expect((await people(application)).filter((person) => person.frontmatter.is_self !== true)).toHaveLength(1);
    // Matching never rewrites the existing person.
    expect(application.object(existingId).frontmatter).toMatchObject({ title: "Alex M", revision: 1 });
  });

  it("resolves every self address to the single self person, which carries all of them", async () => {
    const { calendar, application } = await setup();
    calendar.events = [
      event("e1", [{ email: "Rahul.Dharod@eagleeye.com" }, { email: "rahul.dharod@untienots.com" }, { email: "baloo.rahul@gmail.com" }, { email: "other.person@eagleeye.com" }]),
      event("e2", [{ email: "someone-else@acme.com", self: true, displayName: "Me" }])
    ];
    const first = await application.createMeetingFromEvent("e1");
    const second = await application.createMeetingFromEvent("e2");
    const all = await people(application);
    const selves = all.filter((person) => person.frontmatter.is_self === true);
    expect(selves).toHaveLength(1);
    expect(emails(selves[0]!).sort()).toEqual(["baloo.rahul@gmail.com", "rahul.dharod@eagleeye.com", "rahul.dharod@untienots.com"]);
    expect(first.context.people.map((person) => person.frontmatter.id)).toEqual([selves[0]!.frontmatter.id, all.find((person) => person.frontmatter.title === "Other Person")!.frontmatter.id]);
    // Calendar's own "self" flag also means the self person.
    expect(second.context.people.map((person) => person.frontmatter.id)).toEqual([selves[0]!.frontmatter.id]);
    expect(all).toHaveLength(2);
  });

  it("adds missing self addresses to an existing self person without creating another", async () => {
    const selfId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
    const { calendar, application } = await setup(async (root) => {
      await mkdir(path.join(root, "people"), { recursive: true });
      await writeFile(path.join(root, "people", `you--${selfId}.md`), `---\nid: ${selfId}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: You\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: You\nis_self: true\n---\n# You\n`);
    });
    calendar.events = [event("e1", [{ email: "baloo.rahul@gmail.com" }])];
    const workspace = await application.createMeetingFromEvent("e1");
    expect(workspace.context.people.map((person) => person.frontmatter.id)).toEqual([selfId]);
    const all = await people(application);
    expect(all).toHaveLength(1);
    expect(emails(all[0]!).sort()).toEqual(["baloo.rahul@gmail.com", "rahul.dharod@eagleeye.com", "rahul.dharod@untienots.com"]);
    expect(all[0]!.frontmatter.origin ?? "app").toBe("app");
  });

  it("never creates duplicates on re-sync, across events, or for an address repeated in one event", async () => {
    const { calendar, application } = await setup();
    calendar.events = [
      event("e1", [{ email: "dana.white@acme.com" }, { email: "Dana.White@acme.com", displayName: "Dana W" }]),
      event("e2", [{ email: "DANA.WHITE@ACME.COM" }])
    ];
    const first = await application.createMeetingFromEvent("e1");
    await application.createMeetingFromEvent("e1");
    // Two different events at once must still agree on one person.
    const [second] = await Promise.all([application.createMeetingFromEvent("e2"), application.createMeetingFromEvent("e1")]);
    const dana = (await people(application)).filter((person) => !person.frontmatter.is_self);
    expect(dana).toHaveLength(1);
    expect(first.context.people.map((person) => person.frontmatter.id)).toEqual([dana[0]!.frontmatter.id]);
    expect(second.context.people.map((person) => person.frontmatter.id)).toEqual([dana[0]!.frontmatter.id]);
  });

  it("treats a bare email string from a name-only connector as an email", async () => {
    const { calendar, application } = await setup();
    const legacy = event("e1", []);
    delete legacy.attendeeDetails;
    legacy.attendees = ["sam.green@acme.com", "Pat Name"];
    calendar.events = [legacy];
    const workspace = await application.createMeetingFromEvent("e1");
    expect(workspace.context.people.map((person) => person.frontmatter.title)).toEqual(["Sam Green", "Pat Name"]);
    expect(workspace.context.people[0]!.frontmatter).toMatchObject({ review_state: "unreviewed", identifiers: [{ kind: "email", value: "sam.green@acme.com" }] });
  });

  it("previews matched and derived attendee names without writing anything", async () => {
    const { calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "jean-pierre.dupont@acme.fr" }])];
    const preview = await application.previewMeetingFromEvent("e1");
    expect(preview.context.people.map((person) => person.frontmatter.title)).toEqual(["Jean-Pierre Dupont"]);
    expect(await people(application)).toHaveLength(0);
  });
});
