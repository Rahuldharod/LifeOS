import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #33: draft references by name or ID resolve to links; anything ambiguous or unknown becomes a
// `link-resolution` Review Item instead of a guess.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-resolution-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, store, application };
}

/** Seeds an object file directly (synthetic records on a temp root), as if it already existed in the vault. */
async function seed(store: MarkdownObjectStore, type: string, title: string, extra: Record<string, unknown> = {}) {
  const id = uuidV7();
  const now = "2026-09-01T08:00:00.000Z";
  const base = { id, type, schema_version: 1, revision: 1, title, created_at: now, updated_at: now, updated_by_device: "test" };
  const typeFields: Record<string, Record<string, unknown>> = {
    person: { given_name: title.split(" ")[0] },
    project: { status: "Active" }, client: { status: "Active" }, product: { status: "Active" },
    meeting: { status: "scheduled", starts_at: "2026-10-03T09:00:00.000Z", ends_at: "2026-10-03T10:00:00.000Z", timezone: "Europe/Paris", attendee_ids: [] },
    "knowledge-note": { source_ids: [uuidV7()] }
  };
  const folder = { person: "people", project: "projects", client: "clients", product: "products", meeting: "meetings", "knowledge-note": "knowledge" }[type] ?? type;
  return store.write({ relativePath: `${folder}/${id}.md`, frontmatter: { ...base, ...typeFields[type], ...extra } as LifeOSObject["frontmatter"], body: `# ${title}\n` });
}

async function dropDraft(root: string, name: string, fields: Record<string, unknown>, body = "") {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  const yaml = Object.entries({ lifeos_draft: 1, kind: "task", draft_key: name, origin: "user-dictated", title: "Send the sizing deck", captured_at: "2026-10-04T09:15:00+02:00", ...fields })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(target, `---\n${yaml}\n---\n${body}`);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

const ofType = (application: LifeOSApplication, type: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === type));
const linkReviews = async (application: LifeOSApplication) => (await application.reviews()).filter((review) => review.frontmatter.review_type === "link-resolution");
const frontmatterOnDisk = async (root: string, object: { relativePath: string }) => parse((await readFile(path.join(root, object.relativePath), "utf8")).split("---")[1] ?? "") as Record<string, unknown>;

async function adoptOne(application: LifeOSApplication) {
  const batch = await application.adoptDrafts();
  expect(batch.drafts).toHaveLength(1);
  expect(batch.drafts[0]!.outcome).toBe("adopted");
  const [task] = await ofType(application, "task");
  return { batch, result: batch.drafts[0]!, task: task! };
}

describe("resolving draft references by name", () => {
  it("links project, client and product by title, case- and accent-insensitively", async () => {
    const { root, store, application } = await vault();
    const project = await seed(store, "project", "Café Loyalty Relaunch");
    const client = await seed(store, "client", "Carrefour");
    const product = await seed(store, "product", "AIR");
    await application.rebuildIndex();
    await dropDraft(root, "links.md", { project: "cafe loyalty RELAUNCH", client: "carrefour", product: "air" });

    const { task, result } = await adoptOne(application);
    expect(task.frontmatter).toMatchObject({ primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id });
    expect(await frontmatterOnDisk(root, task)).toMatchObject({ primary_project_id: project.frontmatter.id });
    expect(result.objectIds).toEqual([task.frontmatter.id]);
    expect(await linkReviews(application)).toEqual([]);
  });

  it("falls back to recorded aliases when no title matches", async () => {
    const { root, store, application } = await vault();
    const project = await seed(store, "project", "Retail Media Network", { aliases: ["RMN", "Réseau Média"] });
    await application.rebuildIndex();
    await dropDraft(root, "alias.md", { project: "reseau media" });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.primary_project_id).toBe(project.frontmatter.id);
  });

  it("prefers a title match over an alias match on another object", async () => {
    const { root, store, application } = await vault();
    const titled = await seed(store, "project", "Atlas");
    await seed(store, "project", "Atlas Migration", { aliases: ["Atlas"] });
    await application.rebuildIndex();
    await dropDraft(root, "title-first.md", { project: "Atlas" });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.primary_project_id).toBe(titled.frontmatter.id);
    expect(await linkReviews(application)).toEqual([]);
  });

  it("matches people by email first, then by name; owner, waiting_for and people all resolve", async () => {
    const { root, store, application } = await vault();
    const joel = await seed(store, "person", "Joel Martin", { identifiers: [{ kind: "email", value: "Joel.Martin@EagleEye.com" }] });
    // Another person titled with the email text would win a name match, but email matching comes first.
    await seed(store, "person", "joel.martin@eagleeye.com");
    const anna = await seed(store, "person", "Anna Kowalska", { aliases: ["Ania"] });
    const marc = await seed(store, "person", "Marc Dubois");
    await application.rebuildIndex();
    await dropDraft(root, "people.md", { owner: "joel.martin@eagleeye.com", status: "Waiting", waiting_for: "ania", people: ["Marc Dubois", "JOEL.MARTIN@eagleeye.com"] });

    const { task } = await adoptOne(application);
    expect(task.frontmatter).toMatchObject({ owner_person_id: joel.frontmatter.id, waiting_for_person_id: anna.frontmatter.id, people_ids: [marc.frontmatter.id, joel.frontmatter.id] });
    expect(await linkReviews(application)).toEqual([]);
  });

  it("matches a person by first name when that is the only person with it", async () => {
    const { root, store, application } = await vault();
    const joel = await seed(store, "person", "Joel Martin");
    await application.rebuildIndex();
    await dropDraft(root, "first-name.md", { people: ["joel"] });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.people_ids).toEqual([joel.frontmatter.id]);
  });

  it("accepts an object ID for any reference", async () => {
    const { root, store, application } = await vault();
    const project = await seed(store, "project", "Atlas");
    const owner = await seed(store, "person", "Joel Martin");
    await application.rebuildIndex();
    await dropDraft(root, "ids.md", { project: project.frontmatter.id, owner: owner.frontmatter.id });
    const { task } = await adoptOne(application);
    expect(task.frontmatter).toMatchObject({ primary_project_id: project.frontmatter.id, owner_person_id: owner.frontmatter.id });
  });
});

describe("meeting references", () => {
  it("accept a meeting ID and inherit the meeting's context", async () => {
    const { root, store, application } = await vault();
    const client = await seed(store, "client", "Carrefour");
    const meeting = await seed(store, "meeting", "Weekly sync", { primary_client_id: client.frontmatter.id, external_refs: [{ provider: "google", external_id: "evt-123", calendar_id: "primary" }] });
    await application.rebuildIndex();
    await dropDraft(root, "meeting-id.md", { meeting: meeting.frontmatter.id });
    const { task } = await adoptOne(application);
    expect(task.frontmatter).toMatchObject({ source_meeting_id: meeting.frontmatter.id, primary_client_id: client.frontmatter.id });
  });

  it("accept a calendar event ID; an explicit reference wins over the inherited one", async () => {
    const { root, store, application } = await vault();
    const inherited = await seed(store, "client", "Carrefour");
    const named = await seed(store, "client", "Tesco");
    const meeting = await seed(store, "meeting", "Weekly sync", { primary_client_id: inherited.frontmatter.id, external_refs: [{ provider: "google", external_id: "evt-123", calendar_id: "primary" }] });
    await application.rebuildIndex();
    await dropDraft(root, "meeting-event.md", { meeting: "evt-123", client: "Tesco" });
    const { task } = await adoptOne(application);
    expect(task.frontmatter).toMatchObject({ source_meeting_id: meeting.frontmatter.id, primary_client_id: named.frontmatter.id });
  });

  it("raise a link-resolution item for an unknown meeting", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "meeting-unknown.md", { meeting: "evt-missing" });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.source_meeting_id).toBeUndefined();
    const [review] = await linkReviews(application);
    expect(review!.frontmatter.proposed_fields).toMatchObject({ reference_field: "meeting", reference: "evt-missing", link_field: "source_meeting_id", candidate_type: "meeting", candidates: [] });
  });
});

describe("link-resolution Review Items", () => {
  it("GIVEN 'Joel' with two matching people THEN lists both candidates and sets no link", async () => {
    const { root, store, application } = await vault();
    const one = await seed(store, "person", "Joel Martin");
    const two = await seed(store, "person", "Joël Durand");
    await application.rebuildIndex();
    await dropDraft(root, "joel.md", { status: "Waiting", waiting_for: "Joel" });

    const { task, result } = await adoptOne(application);
    expect(task.frontmatter.waiting_for_person_id).toBeUndefined();
    const reviews = await linkReviews(application);
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.frontmatter).toMatchObject({ review_type: "link-resolution", target_object_type: "task", target_object_id: task.frontmatter.id, status: "pending", origin: "user-dictated" });
    expect(review.frontmatter.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    const proposed = review.frontmatter.proposed_fields as { candidates: Array<{ id: string; title: string }> };
    expect(proposed).toMatchObject({ reference_field: "waiting_for", reference: "Joel", link_field: "waiting_for_person_id", candidate_type: "person", problem: "ambiguous" });
    expect(proposed.candidates.map((candidate) => candidate.id).sort()).toEqual([one.frontmatter.id, two.frontmatter.id].sort());
    expect(result.objectIds).toEqual([task.frontmatter.id, review.frontmatter.id]);
    // One audit event per object or review item created.
    const audits = (await ofType(application, "audit-event")).filter((audit) => audit.frontmatter.action === "draft.adopted");
    expect(audits.map((audit) => audit.frontmatter.object_id).sort()).toEqual([task.frontmatter.id, review.frontmatter.id].sort());
  });

  it("GIVEN an unknown project on a dictated task THEN the task keeps resolved links only, plus a review item", async () => {
    const { root, store, application } = await vault();
    const client = await seed(store, "client", "Carrefour");
    await application.rebuildIndex();
    await dropDraft(root, "unknown.md", { project: "Moonshot", client: "Carrefour" });

    const { task } = await adoptOne(application);
    expect(task.frontmatter.primary_client_id).toBe(client.frontmatter.id);
    expect(task.frontmatter.primary_project_id).toBeUndefined();
    const [review] = await linkReviews(application);
    expect(review!.frontmatter.proposed_fields).toMatchObject({ reference_field: "project", reference: "Moonshot", problem: "unknown", candidates: [] });
    const processed = await readFile(path.join(root, "_inbox", "processed", "unknown.result.md"), "utf8");
    expect(processed).toContain(review!.frontmatter.id);
  });

  it("an unresolved owner falls back to self and asks for review", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "owner.md", { owner: "Nobody Known" });
    const { task } = await adoptOne(application);
    const self = (await ofType(application, "person")).find((person) => person.frontmatter.is_self === true);
    expect(task.frontmatter.owner_person_id).toBe(self!.frontmatter.id);
    const [review] = await linkReviews(application);
    expect(review!.frontmatter.proposed_fields).toMatchObject({ reference_field: "owner", link_field: "owner_person_id" });
  });

  it("accepting sets the chosen link via a guarded write and is idempotent", async () => {
    const { root, store, application } = await vault();
    const one = await seed(store, "person", "Joel Martin");
    await seed(store, "person", "Joel Durand");
    await application.rebuildIndex();
    await dropDraft(root, "accept.md", { status: "Waiting", waiting_for: "Joel" });
    const { task } = await adoptOne(application);
    const [review] = await linkReviews(application);

    await expect(application.acceptReviewItem(review!.frontmatter.id)).rejects.toThrow(/choose/i);
    const updated = await application.acceptReviewItem(review!.frontmatter.id, { linkTo: one.frontmatter.id });
    expect(updated.frontmatter).toMatchObject({ id: task.frontmatter.id, waiting_for_person_id: one.frontmatter.id, revision: 2 });
    expect(await frontmatterOnDisk(root, task)).toMatchObject({ waiting_for_person_id: one.frontmatter.id, revision: 2 });
    const accepted = (await application.reviews()).find((item) => item.frontmatter.id === review!.frontmatter.id)!;
    expect(accepted.frontmatter).toMatchObject({ status: "accepted", resolved_object_id: task.frontmatter.id, chosen_object_id: one.frontmatter.id });
    // A retry does not write again.
    const again = await application.acceptReviewItem(review!.frontmatter.id, { linkTo: one.frontmatter.id });
    expect(again.frontmatter.revision).toBe(2);
  });

  it("accepting a list reference appends to the list; an unknown reference can be linked to any object of the right type", async () => {
    const { root, store, application } = await vault();
    const marc = await seed(store, "person", "Marc Dubois");
    await application.rebuildIndex();
    await dropDraft(root, "list.md", { people: ["Marc", "Zed"] });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.people_ids).toEqual([marc.frontmatter.id]);
    const zed = await seed(store, "person", "Zed Alpha");
    const project = await seed(store, "project", "Atlas");
    await application.rebuildIndex();
    const [review] = await linkReviews(application);
    await expect(application.acceptReviewItem(review!.frontmatter.id, { linkTo: project.frontmatter.id })).rejects.toThrow(/person/);
    const updated = await application.acceptReviewItem(review!.frontmatter.id, { linkTo: zed.frontmatter.id });
    expect(updated.frontmatter.people_ids).toEqual([marc.frontmatter.id, zed.frontmatter.id]);
  });

  it("accepting refuses a stale target (guarded write) when the task changed in between", async () => {
    const { root, store, application } = await vault();
    await application.rebuildIndex();
    await dropDraft(root, "stale.md", { project: "Atlas" });
    const { task } = await adoptOne(application);
    const project = await seed(store, "project", "Atlas");
    await application.rebuildIndex();
    // The task is edited elsewhere: the accept reads the new version, so nothing is lost.
    await application.updateTask(task.frontmatter.id, { priority: "High" }, task.contentHash);
    const [review] = await linkReviews(application);
    const updated = await application.acceptReviewItem(review!.frontmatter.id, { linkTo: project.frontmatter.id });
    expect(updated.frontmatter).toMatchObject({ priority: "High", primary_project_id: project.frontmatter.id, revision: 3 });
  });

  it("a re-sent draft does not create a second review item", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "resend.md", { project: "Moonshot" });
    const first = await adoptOne(application);
    await dropDraft(root, "resend.md", { project: "Moonshot" });
    const second = await application.adoptDrafts();
    expect(second.drafts[0]).toMatchObject({ outcome: "duplicate", objectIds: first.result.objectIds });
    expect(await linkReviews(application)).toHaveLength(1);
  });
});

describe("subjects and edge cases", () => {
  it("normalises subjects to an existing subject after case/accent/separator normalisation", async () => {
    const { root, store, application } = await vault();
    await seed(store, "knowledge-note", "Notes", { subjects: ["Retail Media", "Fidélité"] });
    await application.rebuildIndex();
    await dropDraft(root, "subjects.md", { subjects: ["retail-media", "FIDELITE", "retail_media", "New Topic"] });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.subjects).toEqual(["Retail Media", "Fidélité", "New Topic"]);
  });

  it("restricted objects match by ID but not by name", async () => {
    const { root, store, application } = await vault();
    const secret = await seed(store, "project", "Secret Project", { sensitivity: "restricted" });
    await application.rebuildIndex();
    await dropDraft(root, "by-name.md", { project: "Secret Project" });
    const { task: byName } = await adoptOne(application);
    expect(byName.frontmatter.primary_project_id).toBeUndefined();
    const [review] = await linkReviews(application);
    expect(review!.frontmatter.proposed_fields).toMatchObject({ problem: "unknown", candidates: [] });

    await dropDraft(root, "by-id.md", { project: secret.frontmatter.id, title: "Second task" });
    await application.adoptDrafts();
    const second = (await ofType(application, "task")).find((task) => task.frontmatter.title === "Second task")!;
    expect(second.frontmatter.primary_project_id).toBe(secret.frontmatter.id);
  });

  it("a name or ID that matches a tombstoned object is not used", async () => {
    const { root, store, application } = await vault();
    const gone = await seed(store, "project", "Atlas", { deleted_at: "2026-09-02T08:00:00.000Z" });
    const live = await seed(store, "project", "Atlas Two", { aliases: ["Atlas"] });
    const goneClient = await seed(store, "client", "Ghost", { deleted_at: "2026-09-02T08:00:00.000Z" });
    await application.rebuildIndex();
    await dropDraft(root, "tombstone.md", { project: "Atlas", client: goneClient.frontmatter.id });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.primary_project_id).toBe(live.frontmatter.id);
    expect(task.frontmatter.primary_project_id).not.toBe(gone.frontmatter.id);
    expect(task.frontmatter.primary_client_id).toBeUndefined();
    const [review] = await linkReviews(application);
    expect(review!.frontmatter.proposed_fields).toMatchObject({ reference_field: "client", problem: "unknown" });
  });

  it("fails the draft for malformed references and for waiting_for without Waiting status", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "bad.md", { project: ["a", "b"], people: "Marc", waiting_for: "Joel" });
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]!.outcome).toBe("failed");
    expect(batch.drafts[0]!.reason).toContain("project: must be a name or ID");
    expect(batch.drafts[0]!.reason).toContain("people: must be a list of names, emails or IDs");
    expect(batch.drafts[0]!.reason).toContain("waiting_for: needs status Waiting");
    expect(await ofType(application, "task")).toEqual([]);
  });

  it("an object ID of the wrong type is unknown, not linked", async () => {
    const { root, store, application } = await vault();
    const client = await seed(store, "client", "Carrefour");
    await application.rebuildIndex();
    await dropDraft(root, "wrong-type.md", { project: client.frontmatter.id });
    const { task } = await adoptOne(application);
    expect(task.frontmatter.primary_project_id).toBeUndefined();
    expect(await linkReviews(application)).toHaveLength(1);
  });
});
