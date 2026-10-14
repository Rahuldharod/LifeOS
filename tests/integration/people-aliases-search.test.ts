import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { validateFrontmatter } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { personMatchesQuery } from "@lifeos/shared";

// #211: aliases, merged_into_person_id and is_external_override are declared on Person, and People search finds a person by email or alias.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const keptId = "01995d60-0000-7000-8000-000000000001";
const mergedId = "01995d60-0000-7000-8000-000000000002";
const otherId = "01995d60-0000-7000-8000-000000000003";
const person = (id: string, title: string, extra: string) => `---\nid: ${id}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: ${title}\ncreated_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test\ngiven_name: ${title.split(" ")[0]}\n${extra}---\n# ${title}\n`;

const keptFile = person(keptId, "Jonathan Smith", "identifiers:\n  - kind: email\n    value: jon.smith@example.com\naliases:\n  - Johnny S\n  - Jon\nis_external_override: true\nx_unknown: keep me\n");
const mergedFile = person(mergedId, "Johnny S", `merged_into_person_id: ${keptId}\narchived_at: 2026-10-02T08:00:00Z\n`);
const otherFile = person(otherId, "Alice Martin", "identifiers:\n  - alice.martin@example.org\n");

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-people-search-"));
  roots.push(root);
  await mkdir(path.join(root, "people"), { recursive: true });
  await mkdir(path.join(root, ".lifeos"), { recursive: true });
  await writeFile(path.join(root, ".lifeos/schema.md"), "---\nschema_version: 1\n---\n");
  for (const [name, content] of Object.entries({ kept: keptFile, merged: mergedFile, other: otherFile })) await writeFile(path.join(root, "people", `${name}.md`), content);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "integration-test");
  await application.rebuildIndex();
  return { root, application };
}

async function search(application: LifeOSApplication, query: string) {
  const people = (await application.listObjects()).filter((object) => object.frontmatter.type === "person");
  return people.filter((object) => personMatchesQuery(object.frontmatter, object.frontmatter.title, query)).map((object) => object.frontmatter.title).sort();
}

describe("Person aliases and emails (#211)", () => {
  it("validates people carrying the merge fields and rejects malformed ones", () => {
    const base = { id: keptId, type: "person", schema_version: 1, revision: 1, title: "A B", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", updated_by_device: "t", given_name: "A" };
    expect(validateFrontmatter({ ...base, aliases: ["Al"], merged_into_person_id: mergedId, is_external_override: false })).toMatchObject({ aliases: ["Al"] });
    expect(() => validateFrontmatter({ ...base, aliases: "Al" })).toThrow();
    expect(() => validateFrontmatter({ ...base, merged_into_person_id: "nope" })).toThrow();
  });

  it("declares the fields in the portable JSON schema", async () => {
    const schema = JSON.parse(await readFile(path.join(process.cwd(), "schemas/objects/domain-objects.schema.json"), "utf8"));
    expect(Object.keys(schema.$defs.person.properties)).toEqual(expect.arrayContaining(["aliases", "merged_into_person_id", "is_external_override"]));
  });

  it("loads existing person files and leaves them byte-identical on disk", async () => {
    const { root, application } = await vault();
    const kept = (await application.listObjects()).find((object) => object.frontmatter.id === keptId)!;
    expect(kept.frontmatter).toMatchObject({ aliases: ["Johnny S", "Jon"], is_external_override: true, x_unknown: "keep me" });
    expect(await readFile(path.join(root, "people/kept.md"), "utf8")).toBe(keptFile);
  });

  it("finds a person by email, by alias, and still by name", async () => {
    const { application } = await vault();
    expect(await search(application, "jon.smith@example.com")).toEqual(["Jonathan Smith"]);
    expect(await search(application, "JON.SMITH@EXAMPLE")).toEqual(["Jonathan Smith"]);
    expect(await search(application, "example.org")).toEqual(["Alice Martin"]);
    expect(await search(application, "jonny")).toEqual([]);
    expect(await search(application, "johnny")).toEqual(["Johnny S", "Jonathan Smith"]);
    expect(await search(application, "martin")).toEqual(["Alice Martin"]);
    expect(await search(application, "")).toHaveLength(3);
  });

  it("matches every typed word and ignores accents", () => {
    const frontmatter = { identifiers: [{ kind: "email", value: "elodie@example.com" }], aliases: ["Élodie Dupont"] };
    expect(personMatchesQuery(frontmatter, "Ellie Martin", "elodie dupont")).toBe(true);
    expect(personMatchesQuery(frontmatter, "Ellie Martin", "elodie ghost")).toBe(false);
  });
});
