import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent, type ObjectStore } from "@lifeos/application";
import type { LifeOSObject } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { CrashingStore } from "./crash-store.js";

// Issue #59: replayable adoption IDs are keyed by role (main object, source, summary, proposal, merge pair), not by
// a call counter, so a replay that skips a step it already did never shifts a later ID onto an existing object.
// Each multi-object handler is crashed after every change it makes (shared helper, #160), then replayed: nothing is duplicated.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const startedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
const endedAt = new Date(Date.now() - 4 * 3_600_000).toISOString();
const calendarEvent: CalendarEvent = {
  externalId: "evt-1", calendarId: "work", calendarName: "Work", title: "Q3 sync", startsAt: startedAt, endsAt: endedAt, timezone: "Europe/Paris",
  attendees: ["Joel Martin"], attendeeDetails: [{ email: "joel@client.example", displayName: "Joel Martin" }]
};
class FakeCalendar implements CalendarConnector {
  readonly provider = "google";
  async listEvents(from: Date, to: Date) { return [calendarEvent].filter((event) => Date.parse(event.startsAt) < to.getTime() && Date.parse(event.endsAt) > from.getTime()); }
}

const open = async (root: string, objects: ObjectStore = new MarkdownObjectStore(root)) => {
  const application = new LifeOSApplication(objects, new MemoryIndex(), new FakeCalendar(), undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return application;
};

async function dropDraft(root: string, name: string, fields: Record<string, unknown>, body = "") {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `---\n${stringify({ lifeos_draft: 1, captured_at: "2026-10-04T09:15:00+02:00", ...fields })}---\n${body}`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

interface Scenario {
  name: string;
  /** Objects that exist before the draft lands (adopted through a clean application). */
  setup?: (root: string) => Promise<void>;
  draft: (root: string) => Promise<void>;
  check?: (objects: LifeOSObject[]) => void;
}

const scenarios: Scenario[] = [
  {
    name: "a dictated knowledge note citing a new URL (Source, then note)",
    draft: (root) => dropDraft(root, "idea.md", { kind: "knowledge-note", origin: "user-dictated", draft_key: "idea-1", title: "Loyalty tiers lift basket size", sources: ["https://example.com/tiers", "https://example.com/basket"] }, "Tiers work.\n")
  },
  {
    name: "an extracted knowledge note citing a new URL (Source, then proposal)",
    draft: (root) => dropDraft(root, "idea.md", { kind: "knowledge-note", origin: "agent-extracted", draft_key: "idea-2", title: "Coupons fade after week two", confidence: "High", sources: ["https://example.com/coupons"] }, "Seen in the study.\n")
  },
  {
    name: "a person draft with a merge candidate (person, merge suggestion)",
    setup: (root) => dropDraft(root, "kim.md", { kind: "person", origin: "user-dictated", draft_key: "kim-1", title: "Kim Lee", email: "kim.lee@acme.example.com" }),
    draft: (root) => dropDraft(root, "kim-again.md", { kind: "person", origin: "agent-extracted", draft_key: "kim-2", title: "Kim Lee", email: "k.lee@other.example.com" }),
    check: (objects) => expect(objects.filter((object) => object.frontmatter.review_type === "person-merge")).toHaveLength(1)
  },
  {
    name: "meeting material that creates the meeting (meeting, sources, summary, proposals, state)",
    draft: (root) => dropDraft(root, "material.md", {
      kind: "meeting-material", origin: "agent-extracted", draft_key: "material-1", title: "Material for Q3 sync", meeting: "evt-1",
      sources: [
        { source_type: "meet-transcript", url: "https://example.com/transcript/1", external_id: "transcript-1", occurred_at: startedAt },
        { source_type: "gong-call", url: "https://example.com/gong/1", external_id: "gong-1", occurred_at: startedAt }
      ],
      proposals: [
        { kind: "task", title: "Send the deck to Joel", confidence: "high", missed_in_notes: true, evidence: [{ source: "transcript-1", locator: "00:12:30" }] },
        { kind: "decision", title: "Go with vendor B", confidence: "medium", missed_in_notes: false, evidence: [{ source: "gong-1", locator: "14:02" }] }
      ]
    }, "Joel confirmed vendor B. Rahul owes the deck.\n"),
    check: (objects) => {
      const audits = (action: string) => objects.filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action);
      expect(audits("meeting.enrichment-adopted")).toHaveLength(1);
      expect(audits("meeting.created").length).toBeLessThanOrEqual(1);
      expect(objects.filter((object) => object.frontmatter.type === "meeting")).toHaveLength(1);
    }
  }
];

const countByType = (objects: LifeOSObject[]) => {
  const counts: Record<string, number> = {};
  for (const object of objects) if (object.frontmatter.type !== "audit-event") counts[object.frontmatter.type] = (counts[object.frontmatter.type] ?? 0) + 1;
  return counts;
};

async function fresh(scenario: Scenario) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-replay-ids-"));
  roots.push(root);
  if (scenario.setup) { await scenario.setup(root); await (await open(root)).adoptDrafts(); }
  await scenario.draft(root);
  return root;
}

/** Every write the clean run makes, and what it leaves on disk. */
async function baseline(scenario: Scenario) {
  const root = await fresh(scenario);
  const store = new CrashingStore(root);
  store.arm();
  const batch = await (await open(root, store)).adoptDrafts();
  expect(batch.drafts.map((draft) => draft.outcome)).toEqual(["adopted"]);
  return { changes: store.log, counts: countByType(await new MarkdownObjectStore(root).list()) };
}

describe("role-keyed replayable IDs: crash after every change, then replay", () => {
  for (const scenario of scenarios) {
    it(`${scenario.name}: no duplicate IDs, objects, Review Items or audits`, async () => {
      const clean = await baseline(scenario);
      expect(clean.changes.length).toBeGreaterThan(2);
      for (let crashAfter = 1; crashAfter <= clean.changes.length; crashAfter += 1) {
        const root = await fresh(scenario);
        const store = new CrashingStore(root);
        store.arm(crashAfter);
        // A crash inside a handler is reported as "will retry"; anywhere else it rejects the batch. Either way the process dies here.
        await (await open(root, store)).adoptDrafts().catch(() => undefined);

        const restarted = await open(root);
        const batch = await restarted.adoptDrafts();
        expect(batch.drafts.filter((draft) => draft.outcome !== "adopted"), `crash after change ${crashAfter}: ${JSON.stringify(batch.drafts)}`).toEqual([]);
        expect(await readdir(path.join(root, "_inbox/drafts")), `crash after change ${crashAfter}`).toEqual([]);

        const objects = await new MarkdownObjectStore(root).list();
        const ids = objects.map((object) => object.frontmatter.id);
        expect(ids.length - new Set(ids).size, `duplicate IDs after crash at change ${crashAfter}`).toBe(0);
        expect(countByType(objects), `objects after crash at change ${crashAfter}`).toEqual(clean.counts);
        // Audits are never doubled: one per action, object and draft.
        const audits = objects.filter((object) => object.frontmatter.type === "audit-event").map((audit) => {
          const metadata = audit.frontmatter.metadata as Record<string, unknown> | undefined;
          return `${String(audit.frontmatter.action)} ${String(audit.frontmatter.object_id)} ${String(metadata?.draft_key ?? "")}`;
        });
        expect(audits.length - new Set(audits).size, `duplicate audits after crash at change ${crashAfter}: ${audits.join("\n")}`).toBe(0);
        // Every object the draft created is recorded against it, so a re-send is recognised.
        const adopted = new Set(objects.filter((object) => object.frontmatter.action === "draft.adopted").map((audit) => String(audit.frontmatter.object_id)));
        for (const id of batch.drafts.flatMap((draft) => draft.objectIds)) expect(adopted.has(id), `${id} audited after crash at change ${crashAfter}`).toBe(true);
        scenario.check?.(objects);
      }
    }, 60_000);
  }

  it("GIVEN a person draft replayed after a crash before the merge suggestion THEN the merge Review Item is raised exactly once", async () => {
    const scenario = scenarios.find((candidate) => candidate.name.startsWith("a person draft"))!;
    const root = await fresh(scenario);
    // The crash comes right after the new person lands, before the suggestion is written.
    const personLands = (await baseline(scenario)).changes.indexOf('write person "Kim Lee"') + 1;
    expect(personLands).toBeGreaterThan(0);
    const crashing = new CrashingStore(root);
    crashing.arm(personLands);
    await (await open(root, crashing)).adoptDrafts().catch(() => undefined);
    const restarted = await open(root);
    const batch = await restarted.adoptDrafts();
    const merges = (await restarted.listObjects()).filter((object) => object.frontmatter.review_type === "person-merge");
    expect(merges).toHaveLength(1);
    expect(batch.drafts[0]!.objectIds).toContain(merges[0]!.frontmatter.id);
    expect((await (await open(root)).adoptDrafts()).drafts).toEqual([]);
    expect((await restarted.listObjects()).filter((object) => object.frontmatter.review_type === "person-merge")).toHaveLength(1);
  });

  it("recovery's replay window finds every object a moved draft wrote in its first attempt, whatever their roles", async () => {
    const scenario = scenarios[0]!;
    const root = await fresh(scenario);
    const inbox = new FilesystemInboxStore(root);
    const dying = new Proxy(inbox, { get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (property === "writeDocument") return () => Promise.reject(new Error("simulated crash before the sidecar"));
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    } });
    const crashed = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), new FakeCalendar(), undefined, "test", dying);
    await crashed.rebuildIndex();
    await expect(crashed.adoptDrafts()).rejects.toThrow(/simulated crash/);

    const restarted = await open(root);
    const batch = await restarted.adoptDrafts();
    const objects = await restarted.listObjects();
    const created = objects.filter((object) => ["knowledge-note", "source"].includes(object.frontmatter.type)).map((object) => object.frontmatter.id).sort();
    expect(created).toHaveLength(3);
    expect(batch.drafts[0]).toMatchObject({ outcome: "adopted" });
    expect([...batch.drafts[0]!.objectIds].sort()).toEqual(created);
    expect(objects.filter((object) => object.frontmatter.action === "draft.adopted")).toHaveLength(3);
  });
});
