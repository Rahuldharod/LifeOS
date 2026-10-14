import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import type { LifeOSObject, ObjectEnvelope } from "@lifeos/domain";

// #212: merge suggestions also match a name to an email address and cover automatically created people with no review state.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

function event(externalId: string, attendeeDetails: CalendarAttendee[]): CalendarEvent {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  return { externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: attendeeDetails.map((attendee) => attendee.displayName ?? attendee.email ?? ""), attendeeDetails };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-person-merge-wider-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(store, new MemoryIndex(), calendar, undefined, "test");
  await application.rebuildIndex();
  return { root, store, calendar, application };
}
type Context = Awaited<ReturnType<typeof setup>>;

const people = async (application: LifeOSApplication) => (await application.listObjects()).filter((object) => object.frontmatter.type === "person" && object.frontmatter.is_self !== true);
const merges = (application: LifeOSApplication) => application.reviews().filter((review) => review.frontmatter.review_type === "person-merge");
const proposal = (review: LifeOSObject) => review.frontmatter.proposed_fields as Record<string, string>;
const titled = async (application: LifeOSApplication, title: string) => (await people(application)).find((person) => person.frontmatter.title === title)!;

/** A calendar meeting with these attendees: name-only ones become automatic people with no email and no review state. */
async function attend({ calendar, application }: Context, externalId: string, attendees: CalendarAttendee[]) {
  calendar.events = [event(externalId, attendees)];
  await application.createMeetingFromEvent(externalId);
}

/** A person the user created themselves (origin app, reviewed) that carries an email. */
async function userPerson({ store, application }: Context, title: string, email: string) {
  const id = `0197a000-0000-7000-8000-${String(title.length).padStart(12, "0")}`;
  const now = new Date().toISOString();
  const [given, ...family] = title.split(" ");
  await store.write({
    relativePath: `people/${title.toLowerCase().replace(/\s+/g, "-")}--${id}.md`,
    frontmatter: { id, type: "person", schema_version: 1, revision: 1, title, created_at: now, updated_at: now, updated_by_device: "test", origin: "app", given_name: given, ...(family.length ? { family_name: family.join(" ") } : {}), identifiers: [{ kind: "email", value: email }], review_state: "reviewed" } as unknown as ObjectEnvelope,
    body: `# ${title}\n`
  });
  await application.rebuildIndex();
  return id;
}

const addresses = [
  ["first.last", "john.doe@example.com"],
  ["firstlast", "johndoe@example.com"],
  ["first_last", "John_Doe@example.com"],
  ["flast", "jdoe@example.com"]
] as const;

describe("name-to-email merge suggestions (#212)", () => {
  it.each(addresses)("proposes a name-only calendar person against an email-only person on a %s address", async (_kind, email) => {
    const context = await setup();
    // "JD" does not match "John Doe" by name, so only the address can link them.
    await attend(context, "e1", [{ displayName: "John Doe" }, { email, displayName: "JD" }]);
    expect(await context.application.suggestPersonMerges()).toHaveLength(1);
    const [review] = merges(context.application);
    expect(proposal(review!)).toMatchObject({ match: "name-email" });
    expect([proposal(review!).keep_title, proposal(review!).merge_title].sort()).toEqual(["JD", "John Doe"]);
    // Never merged by itself.
    expect((await people(context.application)).filter((person) => !person.frontmatter.deleted_at)).toHaveLength(2);
  });

  it("ignores accents and case", async () => {
    const context = await setup();
    await attend(context, "e1", [{ displayName: "ZOÉ Müller" }, { email: "zoe.muller@example.com", displayName: "Z M" }]);
    expect(await context.application.suggestPersonMerges()).toHaveLength(1);
  });

  it("suggests an initial-plus-family address only when exactly one live person fits it", async () => {
    const context = await setup();
    await attend(context, "e1", [{ displayName: "John Doe" }, { displayName: "Jane Doe" }, { email: "jdoe@example.com", displayName: "JD" }]);
    // John and Jane both fit jdoe: too ambiguous to suggest.
    expect(await context.application.suggestPersonMerges()).toEqual([]);

    const jane = await titled(context.application, "Jane Doe");
    await context.application.deleteEntity(jane.frontmatter.id, jane.contentHash);
    // Once only one live person fits, the suggestion appears.
    expect(await context.application.suggestPersonMerges()).toHaveLength(1);
    const [review] = merges(context.application);
    expect(proposal(review!)).toMatchObject({ match: "name-email" });
    expect([proposal(review!).keep_title, proposal(review!).merge_title].sort()).toEqual(["JD", "John Doe"]);
  });

  it("does not match a first name alone or a different family name", async () => {
    const context = await setup();
    await attend(context, "e1", [{ displayName: "John Doe" }, { email: "john@example.com", displayName: "J1" }, { email: "john.smith@example.com", displayName: "J2" }]);
    expect(await context.application.suggestPersonMerges()).toEqual([]);
  });
});

describe("who takes part in merge suggestions (#212)", () => {
  it("pairs an unreviewed name-only person with a user-created person that has the email", async () => {
    const context = await setup();
    await userPerson(context, "J Doe", "john.doe@example.com");
    await attend(context, "e1", [{ displayName: "John Doe" }]);
    const named = await titled(context.application, "John Doe");
    expect(named.frontmatter.review_state).toBeUndefined();
    expect(await context.application.suggestPersonMerges()).toHaveLength(1);
    // The user's own person survives; the automatic one would be merged into it.
    expect(proposal(merges(context.application)[0]!)).toMatchObject({ keep_title: "J Doe", merge_title: "John Doe" });
  });

  it("never pairs two people the user created themselves", async () => {
    const context = await setup();
    await userPerson(context, "J Doe", "john.doe@example.com");
    await context.application.createEntity("person", { title: "John Doe", given_name: "John", family_name: "Doe" });
    expect(await context.application.suggestPersonMerges()).toEqual([]);
  });

  it("shows a name-only calendar person as unreviewed, and stops once the user confirms it", async () => {
    const context = await setup();
    await userPerson(context, "J Doe", "john.doe@example.com");
    await attend(context, "e1", [{ displayName: "John Doe" }]);
    const named = await titled(context.application, "John Doe");
    expect(context.application.personLabels().find((label) => label.id === named.frontmatter.id)!.unreviewed).toBe(true);
    await context.application.confirmPersonReviewed(named.frontmatter.id, named.contentHash);
    expect(await context.application.suggestPersonMerges()).toEqual([]);
  });

  it("does not propose a pair again once the user kept it separate", async () => {
    const context = await setup();
    await attend(context, "e1", [{ displayName: "John Doe" }, { email: "john.doe@example.com", displayName: "JD" }]);
    const [id] = await context.application.suggestPersonMerges();
    await context.application.rejectReviewItem(id!);
    expect(await context.application.suggestPersonMerges()).toEqual([]);
    expect(merges(context.application)).toHaveLength(1);
  });

  it("keeps unknown frontmatter on a name-only person through a merge", async () => {
    const context = await setup();
    await attend(context, "e1", [{ displayName: "John Doe" }, { email: "john.doe@example.com", displayName: "JD" }]);
    const named = await titled(context.application, "John Doe");
    const file = path.join(context.root, named.relativePath);
    await writeFile(file, (await readFile(file, "utf8")).replace(/\n---\n/, "\nmy_custom_field: keep-me\n---\n"));
    await context.application.rebuildIndex();
    const [id] = await context.application.suggestPersonMerges();
    await context.application.acceptReviewItem(id!);
    expect(await readFile(file, "utf8")).toContain("my_custom_field: keep-me");
  });
});
