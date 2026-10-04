import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agentIndexFileNames, LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { draftKinds, draftOrigins } from "../../packages/application/src/adoption.js";
import { autoAppliedTaskFields } from "../../packages/application/src/patches.js";
import { expectedMaterial } from "../../packages/application/src/enrichment.js";
import { materialSourceTypes } from "../../packages/application/src/meeting-material.js";

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
  /** #50: also seed the synthetic meetings (`evt-example-*` calendar events) that enrichment examples name. */
  vault?: "meetings";
  /** #50: partial match on the meeting the draft names, after adoption (e.g. its `enrichment_state`). */
  meeting?: Record<string, unknown>;
  /** #50: partial matches for every create-type Review Item raised for that meeting (e.g. `missed_in_notes`). */
  proposals?: Array<Record<string, unknown>>;
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

/** #50: the synthetic calendar the enrichment examples name, relative to now so adoption's 30-day lookback finds them. */
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const exampleEvent = (externalId: string, title: string, endedHoursAgo: number): CalendarEvent => ({
  externalId, calendarId: "work", calendarName: "Work", title, startsAt: hoursAgo(endedHoursAgo + 1), endsAt: hoursAgo(endedHoursAgo), timezone: "Europe/Paris",
  attendees: ["Joel Martin"], attendeeDetails: [{ email: "joel.martin@example.com", displayName: "Joel Martin" }], clientName: "Example Grocer", projectName: "Spring Promo"
});
const exampleEvents = [
  exampleEvent("evt-example-pilot-review", "Pilot review", 3), // no meeting yet: adoption creates it
  exampleEvent("evt-example-steering", "Spring promo steering", 26), // meeting with Rahul's note
  exampleEvent("evt-example-one-to-one", "One-to-one with Joel", 5) // meeting whose note is restricted
];
class ExampleCalendar implements CalendarConnector {
  readonly provider = "google";
  async listEvents(from: Date, to: Date) { return exampleEvents.filter((event) => Date.parse(event.startsAt) < to.getTime() && Date.parse(event.endsAt) > from.getTime()); }
}
const steeringNote = "# Notes\n\n- Joel confirmed the launch on 3 March.\n- Camille to check the coupon budget.\n";

/** The synthetic vault every example is written against (example.com data only). */
async function seededVault(kind?: Expectation["vault"]) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-skill-fixtures-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new ExampleCalendar(), undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  await application.createEntity("person", { title: "Joel Martin", given_name: "Joel", family_name: "Martin" });
  await application.createEntity("person", { title: "Camille Dubois", given_name: "Camille", family_name: "Dubois" });
  await application.createEntity("client", { title: "Example Grocer" });
  await application.createEntity("project", { title: "Spring Promo" });
  await application.createEntity("task", { title: "Send Joel the sizing deck" });
  await application.createOpenPoint({ title: "Which stores join the pilot?" });
  await application.createDecision({ title: "Pilot runs in 12 stores", decision_text: "The spring pilot runs in 12 stores." });
  if (kind === "meetings") {
    const range = [new Date(Date.now() - 7 * 86_400_000), new Date()] as const;
    await application.createMeetingFromEvent("evt-example-steering", ...range, "work", steeringNote);
    const { note } = await application.createMeetingFromEvent("evt-example-one-to-one", ...range, "work", "# Notes\n\nPrivate.\n");
    await application.setSensitivity(note!.frontmatter.id, "restricted", (await application.object(note!.frontmatter.id)).contentHash);
  }
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
    const { root, application } = await seededVault(want.vault);
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

    // #50: meeting-material examples also say what happens to the meeting and to each proposal.
    if (want.meeting || want.proposals) {
      const reference = String(frontmatterOf(content).meeting);
      const meeting = (await application.listObjects()).find((object) => object.frontmatter.type === "meeting" && (object.frontmatter.id === reference || (object.frontmatter.external_refs as Array<{ external_id?: string }> | undefined)?.some((ref) => ref.external_id === reference)));
      expect(meeting, `meeting ${reference}`).toBeDefined();
      if (want.meeting) expect(meeting!.frontmatter).toMatchObject(want.meeting);
      if (want.proposals) {
        const raised = application.reviews().filter((review) => review.frontmatter.source_meeting_id === meeting!.frontmatter.id && review.frontmatter.review_type === "create").map((review) => review.frontmatter);
        expect(raised).toHaveLength(want.proposals.length);
        expect(raised).toEqual(expect.arrayContaining(want.proposals.map((proposal) => expect.objectContaining(proposal))));
      }
    }
  });
});

describe("skills pack stays in step with the code (#49)", () => {
  const skillFolders = ["lifeos-object-contract", "lifeos-capture", "lifeos-ask", "lifeos-enrichment"];
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

describe("enrichment skill stays in step with the code (#50)", () => {
  const enrichment = () => readFile(path.join(skillsRoot, "lifeos-enrichment/SKILL.md"), "utf8");

  it("names every kind of material and every source type meeting-material adoption accepts", async () => {
    const skill = await enrichment();
    for (const value of [...expectedMaterial, ...materialSourceTypes]) expect(skill, value).toContain(`\`${value}\``);
  });

  it("names every field of the Work Order LifeOS really writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-skill-work-order-"));
    roots.push(root);
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new ExampleCalendar(), undefined, "test", new FilesystemInboxStore(root));
    await application.rebuildIndex();
    await application.createMeetingFromEvent("evt-example-steering", new Date(Date.now() - 7 * 86_400_000), new Date(), "work", steeringNote);
    const { workOrder } = await application.requestEnrichment();
    const order = frontmatterOf(await readFile(path.join(root, workOrder!), "utf8"));
    const entries = order.meetings as Array<Record<string, unknown>>;
    const sourceKeys = entries.flatMap((entry) => (entry.existing_sources as Array<Record<string, unknown>>).flatMap(Object.keys));
    const keys = new Set([...Object.keys(order), ...entries.flatMap(Object.keys), ...sourceKeys]);
    expect(keys).toContain("note_path");
    const skill = await enrichment();
    for (const key of keys) expect(skill, key).toContain(`\`${key}\``);
    expect(skill).toContain("`_inbox/requests/`");
  });

  it("keeps client meetings blocked while the IT/legal sign-off is still TBD", async () => {
    const skill = await enrichment();
    const gate = (frontmatterOf(skill).metadata as Record<string, unknown>).client_meeting_content;
    expect(["blocked", "approved"]).toContain(gate);
    // Opening the gate means recording the sign-off: the TBD line must go in the same change.
    if (skill.includes("[TBD — Eagle Eye IT/legal sign-off on processing client meeting content]")) expect(gate).toBe("blocked");
    expect(skill.indexOf("client_meeting_content")).toBeLessThan(skill.indexOf("## Steps"));
  });

  it("has an example for each outcome the skill teaches", () => {
    const material = skills.fixtures.filter((fixture) => fixture.file.startsWith("lifeos-enrichment/"));
    expect(material.map((fixture) => fixture.expect.meeting?.enrichment_state).filter(Boolean)).toEqual(expect.arrayContaining(["enriched", "partial"]));
    expect(material.some((fixture) => fixture.expect.outcome === "failed" && fixture.expect.error?.includes("restricted"))).toBe(true);
    expect(material.flatMap((fixture) => fixture.expect.proposals ?? []).map((proposal) => proposal.missed_in_notes)).toEqual(expect.arrayContaining([true, false]));
  });
});
