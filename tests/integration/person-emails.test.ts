import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #214: the user adds and removes a Person's email addresses; an address on another live person is refused.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-person-emails-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test");
  await application.rebuildIndex();
  return { root, store, application };
}

const emailsOf = (application: LifeOSApplication, id: string) => (application.object(id).frontmatter.identifiers as Array<{ kind: string; value: string }> | undefined ?? []).map((identifier) => identifier.value);

describe("edit a Person's emails (#214)", () => {
  it("adds an address lowercased and trimmed, and it persists in the Person's Markdown with unknown frontmatter kept", async () => {
    const { root, store, application } = await setup();
    const person = await application.createEntity("person", { title: "Ada Example" });
    const stamped = await store.write({ relativePath: person.relativePath, frontmatter: { ...person.frontmatter, custom_unknown: "keep me", revision: person.frontmatter.revision + 1 }, body: person.body, expectedHash: person.contentHash });
    await application.rebuildIndex();

    const updated = await application.addPersonEmail(person.frontmatter.id, "  Ada@Example.COM ", stamped.contentHash);
    expect(emailsOf(application, person.frontmatter.id)).toEqual(["ada@example.com"]);
    expect(updated.frontmatter.identifiers).toEqual([{ kind: "email", value: "ada@example.com" }]);
    const onDisk = await readFile(path.join(root, person.relativePath), "utf8");
    expect(onDisk).toContain("ada@example.com");
    expect(onDisk).toContain("custom_unknown: keep me");
  });

  it("is a no-op when the address is already on this person (any casing), writing nothing", async () => {
    const { application } = await setup();
    const person = await application.createEntity("person", { title: "Ada Example" });
    const first = await application.addPersonEmail(person.frontmatter.id, "ada@example.com", person.contentHash);
    const again = await application.addPersonEmail(person.frontmatter.id, "ADA@example.com", first.contentHash);
    expect(again.contentHash).toBe(first.contentHash);
    expect(emailsOf(application, person.frontmatter.id)).toEqual(["ada@example.com"]);
  });

  it("refuses an address that belongs to another live person, naming that person, and writes nothing", async () => {
    const { application } = await setup();
    const ada = await application.createEntity("person", { title: "Ada Example" });
    const grace = await application.createEntity("person", { title: "Grace Example" });
    const adaWithEmail = await application.addPersonEmail(ada.frontmatter.id, "shared@example.com", ada.contentHash);

    const failure = await application.addPersonEmail(grace.frontmatter.id, "Shared@Example.com", grace.contentHash).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "PersonEmailTakenError", otherPersonId: ada.frontmatter.id, otherPersonName: "Ada Example" });
    expect(application.object(grace.frontmatter.id).contentHash).toBe(grace.contentHash);
    expect(application.object(ada.frontmatter.id).contentHash).toBe(adaWithEmail.contentHash);
  });

  it("allows an address that only a deleted person had", async () => {
    const { application } = await setup();
    const ada = await application.createEntity("person", { title: "Ada Example" });
    const grace = await application.createEntity("person", { title: "Grace Example" });
    const withEmail = await application.addPersonEmail(ada.frontmatter.id, "old@example.com", ada.contentHash);
    await application.deleteEntity(ada.frontmatter.id, withEmail.contentHash);
    const updated = await application.addPersonEmail(grace.frontmatter.id, "old@example.com", grace.contentHash);
    expect(updated.frontmatter.identifiers).toEqual([{ kind: "email", value: "old@example.com" }]);
  });

  it("rejects a malformed address", async () => {
    const { application } = await setup();
    const person = await application.createEntity("person", { title: "Ada Example" });
    await expect(application.addPersonEmail(person.frontmatter.id, "not-an-email", person.contentHash)).rejects.toThrow(/valid email/i);
  });

  it("removes an address (any casing); removing one that is not there is a no-op; other addresses stay", async () => {
    const { root, application } = await setup();
    const person = await application.createEntity("person", { title: "Ada Example" });
    const one = await application.addPersonEmail(person.frontmatter.id, "ada@example.com", person.contentHash);
    const two = await application.addPersonEmail(person.frontmatter.id, "ada.second@example.com", one.contentHash);
    const removed = await application.removePersonEmail(person.frontmatter.id, "ADA@example.com", two.contentHash);
    expect(emailsOf(application, person.frontmatter.id)).toEqual(["ada.second@example.com"]);
    expect(await readFile(path.join(root, person.relativePath), "utf8")).not.toContain("ada@example.com");
    const again = await application.removePersonEmail(person.frontmatter.id, "ada@example.com", removed.contentHash);
    expect(again.contentHash).toBe(removed.contentHash);
  });

  it("refuses a stale content hash", async () => {
    const { application } = await setup();
    const person = await application.createEntity("person", { title: "Ada Example" });
    await application.addPersonEmail(person.frontmatter.id, "ada@example.com", person.contentHash);
    await expect(application.addPersonEmail(person.frontmatter.id, "ada2@example.com", person.contentHash)).rejects.toThrow();
  });

  it("frees a removed address for another person to take", async () => {
    const { application } = await setup();
    const ada = await application.createEntity("person", { title: "Ada Example" });
    const grace = await application.createEntity("person", { title: "Grace Example" });
    const withEmail = await application.addPersonEmail(ada.frontmatter.id, "shared@example.com", ada.contentHash);
    await application.removePersonEmail(ada.frontmatter.id, "shared@example.com", withEmail.contentHash);
    const updated = await application.addPersonEmail(grace.frontmatter.id, "shared@example.com", grace.contentHash);
    expect(updated.frontmatter.identifiers).toEqual([{ kind: "email", value: "shared@example.com" }]);
  });
});
