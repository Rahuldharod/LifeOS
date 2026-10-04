import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_INTERNAL_DOMAINS, LifeOSApplication, personDisplayLabels, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #39: short, unambiguous display labels for people, and the external-person marker.

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

async function setup(seed?: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-labels-"));
  roots.push(root);
  await seed?.(root);
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "integration-test");
  await application.rebuildIndex();
  return { root, calendar, application };
}

const labelOf = (application: LifeOSApplication, id: string) => application.personLabels().find((label) => label.id === id);
const personId = async (application: LifeOSApplication, title: string) => (await application.listObjects()).find((object) => object.frontmatter.type === "person" && object.frontmatter.title === title)!.frontmatter.id;

describe("display labels (#39)", () => {
  it("shows the first name, and first + last only while another active person shares the first name", async () => {
    const { calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "jean.dupont@eagleeye.com" }, { email: "marie.curie@eagleeye.com" }])];
    await application.createMeetingFromEvent("e1");
    const jean = await personId(application, "Jean Dupont");
    expect(labelOf(application, jean)).toMatchObject({ name: "Jean", label: "Jean", isExternal: false });
    expect(labelOf(application, jean)!.suffix).toBeUndefined();

    // A second Jean appears: both switch to first + last, recomputed live.
    const other = await application.createEntity("person", { title: "Jean Martin", given_name: "Jean", family_name: "Martin" });
    expect(labelOf(application, jean)!.name).toBe("Jean Dupont");
    expect(labelOf(application, other.frontmatter.id)!.name).toBe("Jean Martin");
    expect(labelOf(application, await personId(application, "Marie Curie"))!.name).toBe("Marie");

    // Deleting the other Jean makes "Jean" unambiguous again; the deleted one keeps a full label for old references.
    await application.deleteEntity(other.frontmatter.id, application.object(other.frontmatter.id).contentHash);
    expect(labelOf(application, jean)!.name).toBe("Jean");
    expect(labelOf(application, other.frontmatter.id)!.name).toBe("Jean Martin");
  });

  it("treats first names that differ only by case or accents as shared, and falls back to the title without a family name", () => {
    const person = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ frontmatter: { id, type: "person" as const, title, schema_version: 1, revision: 1, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", updated_by_device: "t", ...extra } });
    const labels = personDisplayLabels([
      person("a", "Élodie Roux", { given_name: "Élodie", family_name: "Roux" }),
      person("b", "elodie (Acme)", { given_name: "elodie" }),
      person("c", "Sam", {}),
      person("d", "Sam", { given_name: "Sam", archived_at: "2026-10-02T00:00:00Z" })
    ], DEFAULT_INTERNAL_DOMAINS);
    expect(labels.map((label) => label.name)).toEqual(["Élodie Roux", "elodie (Acme)", "Sam", "Sam"]);
  });

  it("marks external people with a ' - ext' suffix that is part of the label text", async () => {
    const { calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "kim.lee@acme.fr" }, { email: "lea@untienots.com" }])];
    await application.createMeetingFromEvent("e1");
    expect(labelOf(application, await personId(application, "Kim Lee"))).toMatchObject({ name: "Kim", label: "Kim - ext", suffix: " - ext", isExternal: true });
    expect(labelOf(application, await personId(application, "lea"))).toMatchObject({ label: "lea", isExternal: false });
  });

  it("never marks the self person external, though it carries a personal address", async () => {
    const { calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "baloo.rahul@gmail.com", self: true }])];
    await application.createMeetingFromEvent("e1");
    const self = (await application.listObjects()).find((object) => object.frontmatter.is_self === true)!;
    expect(labelOf(application, self.frontmatter.id)).toMatchObject({ isExternal: false, label: "You" });
  });

  it("treats a person with any internal address as internal", async () => {
    const id = "01995d3e-912b-7357-8aa6-9816c1ad90b1";
    const { application } = await setup(async (root) => {
      await mkdir(path.join(root, "people"), { recursive: true });
      await writeFile(path.join(root, "people", `alex--${id}.md`), `---\nid: ${id}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: Alex Morgan\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: Alex\nis_external: true\nidentifiers:\n  - alex@gmail.com\n  - kind: email\n    value: Alex.Morgan@EagleEye.com\n---\n# Alex Morgan\n`);
    });
    expect(labelOf(application, id)).toMatchObject({ label: "Alex", isExternal: false });
  });

  it("falls back to the stored flag for a person without any email", async () => {
    const { application } = await setup();
    const created = await application.createEntity("person", { title: "Paul Plumber" });
    expect(labelOf(application, created.frontmatter.id)).toMatchObject({ label: "Paul", isExternal: false });
  });
});

describe("manual external override (#39)", () => {
  it("overrides the derived flag both ways, writes the file and an audit event, and can be cleared", async () => {
    const { root, calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "kim.lee@acme.fr" }])];
    await application.createMeetingFromEvent("e1");
    const kim = await personId(application, "Kim Lee");

    const internal = await application.setPersonExternal(kim, false, application.object(kim).contentHash);
    expect(internal.frontmatter).toMatchObject({ is_external_override: false, is_external: false });
    expect(labelOf(application, kim)).toMatchObject({ label: "Kim", isExternal: false });
    const file = await readFile(path.join(root, internal.relativePath), "utf8");
    expect(file).toContain("is_external_override: false");
    const audits = (await application.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "person.external-changed");
    expect(audits).toHaveLength(1);

    // Repeating the same value writes nothing.
    const again = await application.setPersonExternal(kim, false, internal.contentHash);
    expect(again.contentHash).toBe(internal.contentHash);

    // Clearing goes back to the email rule.
    const cleared = await application.setPersonExternal(kim, null, internal.contentHash);
    expect(cleared.frontmatter.is_external_override).toBeUndefined();
    expect(cleared.frontmatter.is_external).toBe(true);
    expect(await readFile(path.join(root, cleared.relativePath), "utf8")).not.toContain("is_external_override");
    expect(labelOf(application, kim)!.label).toBe("Kim - ext");

    // An internal colleague can be marked external (e.g. a contractor on a company address).
    const forced = await application.setPersonExternal(kim, true, cleared.contentHash);
    expect(forced.frontmatter.is_external_override).toBe(true);
    await application.saveInternalDomains(["acme.fr"], undefined);
    expect(labelOf(application, kim)!.isExternal).toBe(true);
  });

  it("rejects a stale hash, a non-person and the self person", async () => {
    const { application } = await setup();
    const person = await application.createEntity("person", { title: "Ann Lee" });
    await expect(application.setPersonExternal(person.frontmatter.id, true, "stale")).rejects.toThrow();
    const task = await application.createEntity("task", { title: "Call Ann" });
    await expect(application.setPersonExternal(task.frontmatter.id, true, task.contentHash)).rejects.toThrow(/not found/i);
    const self = (await application.listObjects()).find((object) => object.frontmatter.is_self === true)!;
    await expect(application.setPersonExternal(self.frontmatter.id, true, self.contentHash)).rejects.toThrow(/self/i);
    // @ts-expect-error runtime guard for API callers
    await expect(application.setPersonExternal(person.frontmatter.id, "yes", application.object(person.frontmatter.id).contentHash)).rejects.toThrow(/true, false or null/);
  });
});

describe("internal-domains setting (#39)", () => {
  it("defaults to eagleeye.com and untienots.com without writing a file", async () => {
    const { application } = await setup();
    expect(await application.getInternalDomains()).toEqual({ domains: DEFAULT_INTERNAL_DOMAINS });
    expect(DEFAULT_INTERNAL_DOMAINS).toEqual(["eagleeye.com", "untienots.com"]);
  });

  it("saves a normalized list to settings/internal-domains.md and re-derives labels live", async () => {
    const { root, calendar, application } = await setup();
    calendar.events = [event("e1", [{ email: "kim.lee@acme.fr" }, { email: "lea.roux@untienots.com" }])];
    await application.createMeetingFromEvent("e1");
    const kim = await personId(application, "Kim Lee");
    const lea = await personId(application, "Lea Roux");

    const saved = await application.saveInternalDomains([" EagleEye.com ", "@acme.fr", "acme.fr", ""], undefined);
    expect(saved.domains).toEqual(["eagleeye.com", "acme.fr"]);
    const file = await readFile(path.join(root, "settings", "internal-domains.md"), "utf8");
    expect(file).toContain("setting_key: internal-domains");
    expect(file).toMatch(/internal_domains:\n\s+- eagleeye.com\n\s+- acme.fr/);
    expect(labelOf(application, kim)).toMatchObject({ label: "Kim", isExternal: false });
    expect(labelOf(application, lea)).toMatchObject({ label: "Lea - ext", isExternal: true });

    // New people are flagged against the saved setting too.
    calendar.events = [event("e2", [{ email: "zoe.hart@acme.fr" }])];
    const workspace = await application.createMeetingFromEvent("e2");
    expect(workspace.context.people[0]!.frontmatter.is_external).toBe(false);

    // Stale hash is a conflict; a fresh one succeeds.
    await expect(application.saveInternalDomains(["eagleeye.com"], "stale")).rejects.toThrow(/another device/);
    await expect(application.saveInternalDomains(["eagleeye.com"], undefined)).rejects.toThrow(/another device/);
    const next = await application.saveInternalDomains(["eagleeye.com"], saved.contentHash);
    expect(next.domains).toEqual(["eagleeye.com"]);
    expect((await application.getInternalDomains()).contentHash).toBe(next.contentHash);
  });

  it("rejects an empty list and invalid domains, naming them", async () => {
    const { application } = await setup();
    await expect(application.saveInternalDomains(["", "  "], undefined)).rejects.toThrow(/at least one/i);
    await expect(application.saveInternalDomains(["eagleeye.com", "not a domain", "foo@bar.com", "localhost"], undefined)).rejects.toThrow(/not a domain.*foo@bar\.com.*localhost/);
  });

  it("ignores a hand-edited setting with no valid domains and uses the defaults", async () => {
    const id = "01995d3e-912b-7357-8aa6-9816c1ad90b2";
    const { application } = await setup(async (root) => {
      await mkdir(path.join(root, "settings"), { recursive: true });
      await writeFile(path.join(root, "settings", "internal-domains.md"), `---\nid: ${id}\ntype: app-setting\nschema_version: 1\nrevision: 1\ntitle: Internal domains\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\nsetting_key: internal-domains\ninternal_domains: []\n---\n# Internal domains\n`);
    });
    const person = await application.createEntity("person", { title: "Ann" });
    expect(labelOf(application, person.frontmatter.id)!.isExternal).toBe(false);
    expect((await application.getInternalDomains()).domains).toEqual(DEFAULT_INTERNAL_DOMAINS);
  });
});
