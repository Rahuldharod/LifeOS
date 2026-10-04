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

// ---------------------------------------------------------------------------------------------------------
// #51 morning routine (`skills/lifeos-morning`). Kept in its own section so other skills' tests merge cleanly.
// Every `daily-focus` example is adopted again in a vault holding the objects it names (fixed IDs), then put
// through the self-check the skill documents. The DM example is checked against the brief it summarises.
// ---------------------------------------------------------------------------------------------------------

/** Fields the morning fixtures add to the shared fixture comment. */
interface MorningExpectation extends Expectation {
  /** What the skill's documented self-check must say about the example (default `pass`). */
  selfCheck?: "pass" | "fail";
  /** The max must-dos setting the example was written for (default 3). */
  maxMustDos?: number;
}

const morningSkill = "lifeos-morning/SKILL.md";
const morningFixtures = skills.fixtures.filter((fixture) => frontmatterOf(fixture.content).kind === "daily-focus");
const morningNow = (fields: Record<string, unknown>) => new Date(String(fields.generated_at));

/** Synthetic objects the morning examples reference, by fixed ID (example.com data only). */
const morningIds = {
  self: "0192f000-0000-7000-8000-000000000001",
  camille: "0192f000-0000-7000-8000-000000000002",
  joel: "0192f000-0000-7000-8000-000000000003",
  deck: "0192f000-0000-7000-8000-000000000101",
  budget: "0192f000-0000-7000-8000-000000000102",
  storeList: "0192f000-0000-7000-8000-000000000103",
  pricingPaper: "0192f000-0000-7000-8000-000000000104",
  venue: "0192f000-0000-7000-8000-000000000105",
  privateTask: "0192f000-0000-7000-8000-000000000199",
  storeCount: "0192f000-0000-7000-8000-000000000201",
  pilotDecision: "0192f000-0000-7000-8000-000000000301",
  pilotStores: "0192f000-0000-7000-8000-000000000401",
  weekly: "0192f000-0000-7000-8000-000000000501",
  steering: "0192f000-0000-7000-8000-000000000502"
} as const;

async function morningVault(now: Date) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-skill-morning-"));
  roots.push(root);
  const written: { files: Array<{ name: string; content: string }> } = { files: [] };
  const writer = { write: async (files: Array<{ name: string; content: string }>) => { written.files = files; } };
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root), writer, { agentIndexDebounceMs: 60_000, timeZone: "Europe/Paris" });
  const seed = async (folder: string, type: string, id: string, title: string, fields: Record<string, unknown> = {}) => {
    const frontmatter = { id, type, schema_version: 1, revision: 1, title, created_at: "2026-09-01T08:00:00.000Z", updated_at: "2026-09-01T08:00:00.000Z", updated_by_device: "test", ...fields };
    await mkdir(path.join(root, folder), { recursive: true });
    // JSON is valid YAML, so no extra import is needed to write front matter.
    await writeFile(path.join(root, folder, `${id}.md`), `---\n${JSON.stringify(frontmatter)}\n---\n# ${title}\n`);
  };
  const mine = { status: "Next", owner_person_id: morningIds.self };
  await seed("people", "person", morningIds.self, "Robin Example", { given_name: "Robin", family_name: "Example", is_self: true, identifiers: [{ kind: "email", value: "me@example.com" }] });
  await seed("people", "person", morningIds.camille, "Camille Dubois", { given_name: "Camille", family_name: "Dubois", identifiers: [{ kind: "email", value: "camille@example.com" }] });
  await seed("people", "person", morningIds.joel, "Joel Martin", { given_name: "Joel", family_name: "Martin", identifiers: [{ kind: "email", value: "joel@example.com" }] });
  await seed("tasks", "task", morningIds.deck, "Send Joel the sizing deck", { ...mine, priority: "High", due_on: "2026-10-02" });
  await seed("tasks", "task", morningIds.budget, "Approve the Spring Promo budget", { ...mine, priority: "High", due_on: "2026-10-05" });
  await seed("tasks", "task", morningIds.storeList, "Draft the pilot store list", { ...mine, priority: "Medium", due_on: "2026-10-05" });
  await seed("tasks", "task", morningIds.pricingPaper, "Read the loyalty pricing paper", { ...mine, priority: "Low" });
  await seed("tasks", "task", morningIds.venue, "Book the supplier day venue", { ...mine, priority: "Medium", due_on: "2026-10-09" });
  await seed("tasks", "task", morningIds.privateTask, "Private appointment", { ...mine, priority: "High", due_on: "2026-10-05", sensitivity: "restricted" });
  await seed("tasks", "task", morningIds.storeCount, "Camille to confirm the store count", { status: "Waiting", owner_person_id: morningIds.self, waiting_for_person_id: morningIds.camille, updated_at: "2026-09-29T08:00:00.000Z" });
  await seed("decisions", "decision", morningIds.pilotDecision, "Pilot runs in 12 stores", { status: "active", decision_text: "The spring pilot runs in 12 stores.", decided_at: "2026-10-01T08:00:00.000Z" });
  await seed("open-points", "open-point", morningIds.pilotStores, "Which stores join the pilot?", { status: "open", created_at: "2026-10-01T08:00:00.000Z" });
  await seed("meetings", "meeting", morningIds.weekly, "Example Grocer weekly", { status: "confirmed", starts_at: "2026-10-05T07:00:00.000Z", ends_at: "2026-10-05T08:00:00.000Z", timezone: "Europe/Paris", attendee_ids: [morningIds.self, morningIds.joel] });
  await seed("meetings", "meeting", morningIds.steering, "Spring Promo steering", { status: "confirmed", starts_at: "2026-10-05T12:00:00.000Z", ends_at: "2026-10-05T13:30:00.000Z", timezone: "Europe/Paris", attendee_ids: [morningIds.self, morningIds.camille] });
  await application.rebuildIndex();
  await application.writeAgentIndex({ now });
  return { root, application, agentIndex: () => written.files };
}

/**
 * The self-check `lifeos-morning` tells the routine to run before it writes the draft (section "Self-check
 * before writing"). Returns the problems found; an empty list means the draft may be written.
 */
function morningSelfCheck(brief: string, agentIndex: Array<{ name: string; content: string }>, maxMustDos: number) {
  const fields = frontmatterOf(brief);
  const body = brief.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const listed = new Set(agentIndex.flatMap((file) => [...file.content.matchAll(/\bid: ([0-9a-f-]{36})\b/g)].map((match) => match[1])));
  const problems: string[] = [];
  const sections: Array<[string, string]> = [["i_owe", "task_id"], ["top3", "task_id"], ["waiting_and_decisions", "object_id"], ["meeting_prep", "meeting_id"], ["defer_candidates", "task_id"]];
  for (const [section, idField] of sections) {
    for (const entry of (fields[section] as Array<Record<string, unknown>> | undefined) ?? []) {
      const id = String(entry[idField]);
      if (!listed.has(id)) problems.push(`${section}: ${id} is not listed in _agent/`);
    }
  }
  const count = (section: string) => ((fields[section] as unknown[] | undefined) ?? []).length;
  if (count("top3") < 1 || count("top3") > maxMustDos) problems.push(`top3: has ${count("top3")} entries; 1 to ${maxMustDos}`);
  if (count("meeting_prep") > 3) problems.push("meeting_prep: more than 3");
  if (count("defer_candidates") > 3) problems.push("defer_candidates: more than 3");
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (words > 300) problems.push(`body: ${words} words; at most 300`);
  if (/\(restricted\)/i.test(body)) problems.push("body: names a restricted item");
  return problems;
}

describe("morning routine skill (#51)", () => {
  it("has a valid SKILL.md front matter at the pack version", async () => {
    const front = frontmatterOf(await readFile(path.join(skillsRoot, morningSkill), "utf8"));
    expect(front.name).toBe("lifeos-morning");
    expect(String(front.description).length).toBeGreaterThan(20);
    expect(String(front.description).length).toBeLessThanOrEqual(1024);
    expect(String(front.description)).not.toMatch(/[<>]/);
    expect((front.metadata as Record<string, unknown>).version).toBe((frontmatterOf(await readFile(path.join(skillsRoot, "lifeos-object-contract/SKILL.md"), "utf8")).metadata as Record<string, unknown>).version);
  });

  it("documents passing briefs and a restricted counter-example, all from the morning skill", () => {
    expect(morningFixtures.every((fixture) => fixture.file === morningSkill)).toBe(true);
    expect(morningFixtures.filter((fixture) => (fixture.expect as MorningExpectation).selfCheck !== "fail").length).toBeGreaterThanOrEqual(2);
    expect(morningFixtures.filter((fixture) => (fixture.expect as MorningExpectation).selfCheck === "fail")).toHaveLength(1);
  });

  it("states the brief-time default and the open connector question", async () => {
    const text = await readFile(path.join(skillsRoot, morningSkill), "utf8");
    expect(text).toContain("06:00");
    expect(text).toContain("Europe/Paris");
    expect(text).toContain("[TBD — verify cloud routines can use Slack/Gong connectors]");
  });

  it.each(morningFixtures.map((fixture) => [fixture.expect.name, fixture] as const))("%s: adopts against the objects it names and meets the self-check as documented", async (_name, fixture) => {
    const want = fixture.expect as MorningExpectation;
    const fields = frontmatterOf(fixture.content);
    const now = morningNow(fields);
    const { root, application, agentIndex } = await morningVault(now);
    if (want.maxMustDos) await application.saveFocusSettings({ maxMustDos: want.maxMustDos });

    const problems = morningSelfCheck(fixture.content, agentIndex(), want.maxMustDos ?? 3);
    if ((want.selfCheck ?? "pass") === "pass") expect(problems).toEqual([]);
    else expect(problems.join("; ")).toContain(`${morningIds.privateTask} is not listed in _agent/`);

    await drop(root, "drafts", `${want.name}.md`, fixture.content);
    const batch = await application.adoptDrafts({ now });
    expect(batch.drafts[0], batch.drafts[0]?.reason).toMatchObject({ outcome: "adopted" });
    // Adoption accepts a restricted reference (Today hides and counts it), which is why the self-check exists.
    const focus = application.today({ date: String(fields.focus_on), now }).focus;
    expect(focus.restrictedHidden).toBe((want.selfCheck ?? "pass") === "pass" ? 0 : 1);
    if ((want.selfCheck ?? "pass") === "pass") expect(focus.top3.every((item) => item.state !== "missing")).toBe(true);
  });

  it("the Slack DM example is 5 lines that match its brief and name nothing restricted", async () => {
    const text = await readFile(path.join(skillsRoot, morningSkill), "utf8");
    const dms = [...text.matchAll(/<!--\s*slack-dm:\s*(\{[\s\S]*?\})\s*-->\s*\n```[\w-]*\n([\s\S]*?)\n```/g)].map((match) => ({ ...(JSON.parse(match[1]!) as { brief: string }), lines: match[2]!.split("\n") }));
    expect(dms.length).toBeGreaterThan(0);
    for (const dm of dms) {
      const brief = morningFixtures.find((fixture) => fixture.expect.name === dm.brief);
      expect(brief, dm.brief).toBeDefined();
      const fields = frontmatterOf(brief!.content);
      const { application } = await morningVault(morningNow(fields));
      const title = (id: unknown) => application.object(String(id)).frontmatter.title;
      expect(dm.lines).toHaveLength(5);
      const [, top3, iOwe, day, link] = dm.lines;
      for (const entry of fields.top3 as Array<Record<string, unknown>>) expect(top3).toContain(title(entry.task_id));
      expect(top3).toMatch(/^Top 3: /);
      const owed = fields.i_owe as Array<Record<string, unknown>>;
      expect(iOwe).toBe(`I owe: ${owed.length} (${owed.filter((entry) => entry.overdue === true).length} overdue)`);
      const shape = fields.day_shape as Record<string, number>;
      expect(day).toBe(`Day: ${shape.meeting_hours} h meetings · ${shape.free_hours} h free`);
      expect(link).toMatch(/^Brief: .*_inbox\/drafts\/[\w.-]+\.md/);
      expect(dm.lines.join("\n")).not.toContain("Private appointment");
    }
  });
});
