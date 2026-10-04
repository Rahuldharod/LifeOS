import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import type { LifeOSObject } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #65: pending Review Items written before a person merge still name the merged person. Accepting one
// after the merge follows `merged_into_person_id` to the surviving person; resolved items keep their history.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-merge-pending-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, application };
}

async function dropDraft(root: string, name: string, fields: Record<string, unknown>) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  const yaml = Object.entries({ lifeos_draft: 1, captured_at: "2026-10-04T09:15:00+02:00", ...fields }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(target, `---\n${yaml}\n---\n`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

/** Marie Curie (kept, made by the user) and a drafted duplicate (merged), plus the pending merge suggestion. */
async function duplicates() {
  const context = await setup();
  const { root, application } = context;
  const keep = await application.createEntity("person", { title: "Marie Curie" });
  await dropDraft(root, "marie.md", { kind: "person", draft_key: "marie", origin: "user-dictated", title: "Marie Curie", email: "marie@example.com" });
  await application.adoptDrafts();
  const people = (await application.listObjects()).filter((object) => object.frontmatter.type === "person" && object.frontmatter.is_self !== true);
  const dup = people.find((person) => person.frontmatter.id !== keep.frontmatter.id)!;
  const merge = application.reviews().find((review) => review.frontmatter.review_type === "person-merge")!;
  expect(merge.frontmatter.proposed_fields).toMatchObject({ keep_person_id: keep.frontmatter.id, merge_person_id: dup.frontmatter.id });
  return { ...context, keep: keep.frontmatter.id, dup: dup.frontmatter.id, mergeId: merge.frontmatter.id };
}

const reviewOf = (application: LifeOSApplication, id: string) => application.reviews().find((review) => review.frontmatter.id === id)!;
const newest = (application: LifeOSApplication, type: string, before: Set<string>) => application.reviews().find((review) => review.frontmatter.review_type === type && !before.has(review.frontmatter.id))!;

describe("pending task proposals after a person merge (#65)", () => {
  it("GIVEN a pending proposal naming the merged person WHEN accepted after the merge THEN the task references the survivor", async () => {
    const { root, application, keep, dup, mergeId } = await duplicates();
    const before = new Set(application.reviews().map((review) => review.frontmatter.id));
    await dropDraft(root, "task.md", { kind: "task", draft_key: "task", origin: "agent-extracted", confidence: "High", title: "Send Marie the deck", status: "Waiting", owner: dup, waiting_for: dup, people: [keep, dup] });
    await application.adoptDrafts();
    const proposal = newest(application, "create", before);
    expect(proposal.frontmatter.proposed_fields).toMatchObject({ owner_person_id: dup, waiting_for_person_id: dup, people_ids: [keep, dup] });

    await application.acceptReviewItem(mergeId);
    const task = await application.acceptReviewItem(proposal.frontmatter.id);
    expect(task.frontmatter).toMatchObject({ type: "task", owner_person_id: keep, waiting_for_person_id: keep, people_ids: [keep] });
    expect((await application.health()).diagnostics).toEqual([]);
    // The proposal itself still records what was proposed.
    expect(reviewOf(application, proposal.frontmatter.id).frontmatter.proposed_fields).toMatchObject({ owner_person_id: dup, people_ids: [keep, dup] });
  });
});

describe("pending link-resolution items after a person merge (#65)", () => {
  async function linkScenario() {
    const s = await duplicates();
    const before = new Set(s.application.reviews().map((review) => review.frontmatter.id));
    await dropDraft(s.root, "link.md", { kind: "task", draft_key: "link", origin: "user-dictated", title: "Send the sizing deck", status: "Waiting", waiting_for: "Marie Curie" });
    await s.application.adoptDrafts();
    const review = newest(s.application, "link-resolution", before);
    const task = (await s.application.listObjects()).find((object) => object.frontmatter.type === "task")!;
    expect((review.frontmatter.proposed_fields as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id).sort()).toEqual([s.keep, s.dup].sort());
    return { ...s, reviewId: review.frontmatter.id, taskId: task.frontmatter.id };
  }

  it("lists the survivor once and accepts the single remaining candidate without a choice", async () => {
    const { application, keep, mergeId, reviewId, taskId } = await linkScenario();
    await application.acceptReviewItem(mergeId);
    const listed = reviewOf(application, reviewId).frontmatter.proposed_fields as { candidates: Array<{ id: string; title: string }> };
    expect(listed.candidates).toEqual([{ id: keep, title: "Marie Curie" }]);

    const linked = await application.acceptReviewItem(reviewId);
    expect(linked.frontmatter.id).toBe(taskId);
    expect(application.object(taskId).frontmatter.waiting_for_person_id).toBe(keep);
    expect(reviewOf(application, reviewId).frontmatter).toMatchObject({ status: "accepted", chosen_object_id: keep });
  });

  it("links the survivor when the merged person is chosen explicitly", async () => {
    const { application, keep, dup, mergeId, reviewId, taskId } = await linkScenario();
    await application.acceptReviewItem(mergeId);
    await application.acceptReviewItem(reviewId, { linkTo: dup });
    expect(application.object(taskId).frontmatter.waiting_for_person_id).toBe(keep);
  });

  it("leaves resolved items' history unchanged", async () => {
    const { root, application, dup, mergeId, reviewId } = await linkScenario();
    await application.acceptReviewItem(reviewId, { linkTo: dup });
    const accepted = reviewOf(application, reviewId);
    const onDisk = await readFile(path.join(root, accepted.relativePath), "utf8");
    await application.acceptReviewItem(mergeId);
    const after = reviewOf(application, reviewId) as LifeOSObject;
    expect(after.frontmatter).toEqual(accepted.frontmatter);
    expect(await readFile(path.join(root, after.relativePath), "utf8")).toBe(onDisk);
    expect(after.frontmatter.chosen_object_id).toBe(dup);
  });
});
