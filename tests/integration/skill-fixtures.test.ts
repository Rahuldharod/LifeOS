import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agentIndexFileNames, LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { draftKinds, draftOrigins } from "../../packages/application/src/adoption.js";
import { autoAppliedTaskFields } from "../../packages/application/src/patches.js";

/**
 * Issue #49 (PRD "Skill examples as fixtures"): every example Inbox Draft and Patch Draft in the skills pack
 * (`skills/`) is fed through the real adoption code. Each example sits in a fenced block right after a
 * `<!-- fixture: {...} -->` comment that says what adoption must do with it. CI fails when an example stops
 * adopting as documented, or when an example has no fixture comment, so skill text and code cannot drift.
 */

const skillsRoot = path.join(process.cwd(), "skills"); // vitest runs from the repository root

interface Expectation {
  /** Also the file name the example is dropped under (`<name>.md`). */
  name: string;
  folder: "drafts" | "patches";
  outcome: "adopted" | "applied" | "review" | "failed";
  /** Types of every object the result lists, in any order. */
  creates?: string[];
  /** Partial match on the first object the result lists. */
  fields?: Record<string, unknown>;
  /** A text the failure reason must contain. */
  error?: string;
}
interface Fixture { file: string; expect: Expectation; content: string }

function markdownFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? markdownFiles(path.join(folder, entry.name)) : entry.name.endsWith(".md") ? [path.join(folder, entry.name)] : []).sort();
}

const fence = /```[\w-]*\n([\s\S]*?)\n```/g;
const annotated = /<!--\s*fixture:\s*(\{[\s\S]*?\})\s*-->\s*\n```[\w-]*\n([\s\S]*?)\n```/g;
const isExample = (block: string) => /^lifeos_(draft|patch):/m.test(block);

/** Read synchronously: the fixtures must be known when the tests are collected. */
function loadSkills() {
  const files = markdownFiles(skillsRoot);
  const fixtures: Fixture[] = [];
  const unannotated: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const relative = path.relative(skillsRoot, file);
    const examples = [...text.matchAll(fence)].map((match) => match[1]!).filter(isExample);
    const found = [...text.matchAll(annotated)].map((match) => ({ file: relative, expect: JSON.parse(match[1]!) as Expectation, content: `${match[2]!}\n` }));
    fixtures.push(...found);
    const covered = new Set(found.map((fixture) => fixture.content));
    unannotated.push(...examples.filter((example) => !covered.has(`${example}\n`)).map((example) => `${relative}: ${example.split("\n").slice(0, 4).join(" | ")}`));
  }
  return { files, fixtures, unannotated };
}

const skills = loadSkills();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** The synthetic vault every example is written against (example.com data only). */
async function seededVault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-skill-fixtures-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  await application.createEntity("person", { title: "Joel Martin", given_name: "Joel", family_name: "Martin" });
  await application.createEntity("person", { title: "Camille Dubois", given_name: "Camille", family_name: "Dubois" });
  await application.createEntity("client", { title: "Example Grocer" });
  await application.createEntity("project", { title: "Spring Promo" });
  await application.createEntity("task", { title: "Send Joel the sizing deck" });
  await application.createOpenPoint({ title: "Which stores join the pilot?" });
  await application.createDecision({ title: "Pilot runs in 12 stores", decision_text: "The spring pilot runs in 12 stores." });
  return { root, application };
}

async function drop(root: string, folder: string, name: string, content: string) {
  const target = path.join(root, "_inbox", folder, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

const frontmatterOf = (text: string) => parse(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "") as Record<string, unknown>;

describe("skills pack examples adopt as documented (#49)", () => {
  it("has examples, and every example draft or patch carries a fixture comment", () => {
    expect(skills.fixtures.length).toBeGreaterThan(0);
    expect(skills.unannotated).toEqual([]);
  });

  it("gives every example its own name and draft_key", () => {
    const names = skills.fixtures.map((fixture) => fixture.expect.name);
    const keys = skills.fixtures.map((fixture) => String(frontmatterOf(fixture.content).draft_key));
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(skills.fixtures.map((fixture) => [`${fixture.file} › ${fixture.expect.name}`, fixture] as const))("%s", async (_label, fixture) => {
    const { expect: want, content } = fixture;
    const { root, application } = await seededVault();
    await drop(root, want.folder, `${want.name}.md`, content);

    const batch = await application.adoptDrafts();
    const [result] = batch.drafts;
    expect(batch.drafts).toHaveLength(1);
    expect(result, result?.reason).toMatchObject({ draft: `_inbox/${want.folder}/${want.name}.md`, outcome: want.outcome });
    if (want.error) expect(result!.reason).toContain(want.error);

    // The self-check the skills teach: the `.result.md` sidecar next to the filed draft says what happened.
    const sidecarFolder = want.outcome === "failed" ? "failed" : "processed";
    const sidecar = frontmatterOf(await readFile(path.join(root, "_inbox", sidecarFolder, `${want.name}.result.md`), "utf8"));
    expect(sidecar).toMatchObject({ lifeos_result: 1, outcome: want.outcome, object_ids: result!.objectIds });

    const objects = result!.objectIds.map((id) => application.object(id));
    if (want.creates) expect(objects.map((object) => object.frontmatter.type).sort()).toEqual([...want.creates].sort());
    if (want.fields) expect(objects[0]?.frontmatter).toMatchObject(want.fields);
  });
});

describe("skills pack stays in step with the code (#49)", () => {
  const skillFolders = ["lifeos-object-contract", "lifeos-capture", "lifeos-ask"];
  const read = (relative: string) => readFile(path.join(skillsRoot, relative), "utf8");

  it.each(skillFolders)("%s has a valid SKILL.md front matter (Anthropic skill format)", async (folder) => {
    const text = await read(`${folder}/SKILL.md`);
    expect(text.startsWith("---\n")).toBe(true);
    const front = frontmatterOf(text);
    expect(front.name).toBe(folder);
    expect(String(front.name)).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(String(front.name)).not.toMatch(/anthropic|claude/);
    expect(typeof front.description).toBe("string");
    expect(String(front.description).length).toBeGreaterThan(20);
    expect(String(front.description).length).toBeLessThanOrEqual(1024);
    expect(String(front.description)).not.toMatch(/[<>]/);
    expect((front.metadata as Record<string, unknown> | undefined)?.version).toBe((frontmatterOf(await read("lifeos-object-contract/SKILL.md")).metadata as Record<string, unknown>).version);
  });

  it("the Object Contract names every draft kind, origin and auto-applied task field the code accepts", async () => {
    const contract = await read("lifeos-object-contract/SKILL.md");
    for (const value of [...draftKinds, ...draftOrigins, ...autoAppliedTaskFields]) expect(contract, value).toContain(`\`${value}\``);
  });

  it("the Ask skill names exactly the Agent Index files LifeOS writes", async () => {
    const ask = await read("lifeos-ask/SKILL.md");
    const named = new Set([...ask.matchAll(/`_agent\/([\w-]+\.md)`/g)].map((match) => match[1]));
    expect([...named].sort()).toEqual([...agentIndexFileNames].sort());
  });

  it("never uses a real email domain in the skills pack", async () => {
    for (const file of skills.files) {
      const domains = [...(await readFile(file, "utf8")).matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)].map((match) => match[1]);
      expect(domains.filter((domain) => !/(^|\.)example\.(com|org|net)$/.test(domain!)), path.relative(skillsRoot, file)).toEqual([]);
    }
  });
});
