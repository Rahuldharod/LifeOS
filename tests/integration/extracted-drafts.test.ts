import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #34: agent-extracted drafts become create-type Review Items with evidence; dictated decisions and open points are created directly.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-extracted-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, application };
}

async function dropDraft(root: string, name: string, content: string) {
  const target = path.join(root, "_inbox", "drafts", name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const past = new Date(Date.now() - 60_000);
  await utimes(target, past, past);
}

/** Front matter as raw YAML lines, so nested evidence lists can be written as an Agent would. */
const draft = (yaml: string, body = "") => `---\nlifeos_draft: 1\ncaptured_at: 2026-10-04T09:15:00+02:00\n${yaml.trim()}\n---\n${body}`;
const frontmatterOf = async (file: string) => parse((await readFile(file, "utf8")).split("---")[1] ?? "") as Record<string, unknown>;
const ofType = (application: LifeOSApplication, type: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === type));

describe("agent-extracted drafts become Review Items", () => {
  it.each(["task", "decision", "open-point"])("routes an agent-extracted %s to a pending create-type Review Item with evidence and no object", async (kind) => {
    const { root, application } = await vault();
    const source = await application.ingestTextSource("Q3 sync transcript", "Joel: we go with vendor B. Rahul: I will send the deck.");
    const before = (await ofType(application, kind)).length;
    await dropDraft(root, `${kind}.md`, draft(`
kind: ${kind}
draft_key: meet-q3-${kind}
origin: agent-extracted
title: Go with vendor B
confidence: high
evidence:
  - source: ${source.frontmatter.id}
    locator: "00:12:30"
    quote: "we go with vendor B"
  - field: title
    source: Q3 sync transcript
    locator: section Decisions
`, "Joel confirmed vendor B at the end of the call.\n"));

    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "adopted", filedAs: `_inbox/processed/${kind}.md` });
    const reviews = application.reviews().filter((review) => review.frontmatter.target_object_type === kind && review.frontmatter.review_type === "create" && review.frontmatter.origin === "agent-extracted");
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(batch.drafts[0]!.objectIds).toEqual([review.frontmatter.id]);
    expect(review.relativePath.startsWith("review-items/")).toBe(true);
    expect(review.frontmatter).toMatchObject({ status: "pending", confidence_label: "High", agent_run_id: batch.agentRunId, source_ids: [source.frontmatter.id], draft_key: `meet-q3-${kind}` });
    expect(review.frontmatter.proposed_fields).toMatchObject({ title: "Go with vendor B", body: "Joel confirmed vendor B at the end of the call." });
    expect(review.frontmatter.field_evidence).toEqual({ title: [
      { source_ref: source.frontmatter.id, source_id: source.frontmatter.id, locator: "00:12:30", quote: "we go with vendor B" },
      { source_ref: "Q3 sync transcript", source_id: source.frontmatter.id, locator: "section Decisions" }
    ] });
    expect(await ofType(application, kind)).toHaveLength(before);

    const evidence = application.reviewEvidence(review.frontmatter.id);
    expect(evidence.title).toEqual([
      expect.objectContaining({ resolved: true, source_id: source.frontmatter.id, source_title: "Q3 sync transcript", locator: "00:12:30" }),
      expect.objectContaining({ resolved: true, source_title: "Q3 sync transcript", locator: "section Decisions" })
    ]);

    // One audit-event per review item created, and the agent-run lists it.
    const audits = (await ofType(application, "audit-event")).filter((audit) => audit.frontmatter.action === "draft.adopted");
    expect(audits.map((audit) => audit.frontmatter.object_id)).toEqual([review.frontmatter.id]);
    const run = (await ofType(application, "agent-run")).find((candidate) => candidate.frontmatter.id === batch.agentRunId);
    expect(run!.frontmatter.related_object_ids).toEqual([review.frontmatter.id]);
    expect(await frontmatterOf(path.join(root, `_inbox/processed/${kind}.result.md`))).toMatchObject({ outcome: "adopted", object_ids: [review.frontmatter.id] });
  });

  it("generates the Review Item operation_id itself and rejects drafts that carry one (U7)", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "carries-op.md", draft(`
kind: task
draft_key: op-1
origin: agent-extracted
title: Send the deck
confidence: Medium
operation_id: 01928a1e-0000-7000-8000-000000000000
`));
    await dropDraft(root, "dictated-op.md", draft(`
kind: task
draft_key: op-2
origin: user-dictated
title: Send the deck
operation_id: 01928a1e-0000-7000-8000-000000000001
`));
    const batch = await application.adoptDrafts();
    for (const result of batch.drafts) {
      expect(result.outcome).toBe("failed");
      expect(result.reason).toMatch(/operation_id: drafts must not carry an operation_id/);
    }
    expect(application.reviews()).toHaveLength(0);
    expect(await ofType(application, "task")).toHaveLength(0);

    await dropDraft(root, "clean.md", draft("kind: task\ndraft_key: op-3\norigin: agent-extracted\ntitle: Send the deck\nconfidence: Low"));
    await application.adoptDrafts();
    const [review] = application.reviews();
    expect(review!.frontmatter.operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([
    ["", "confidence: missing"],
    ["confidence: certain", 'confidence: unknown confidence "certain"'],
    ["confidence: High\nevidence: not-a-list", "evidence: must be a list"],
    ["confidence: High\nevidence:\n  - locator: \"00:01\"", "evidence[0].source: missing"],
    ["confidence: High\nevidence:\n  - source: Notes\n    field: colour", 'evidence[0].field: "colour" is not a proposed field'],
    ["confidence: High\nevidence:\n  - source: Notes\n    locator:\n      at: 3", "evidence[0].locator: must be text"],
    ["confidence: High\npriority: urgent", 'priority: unknown priority "urgent"']
  ])("fails an extracted draft with %j, path-aware", async (lines, reason) => {
    const { root, application } = await vault();
    await dropDraft(root, "bad.md", draft(`kind: task\ndraft_key: bad-1\norigin: agent-extracted\ntitle: Send the deck\n${lines}`));
    const [result] = (await application.adoptDrafts()).drafts;
    expect(result).toMatchObject({ outcome: "failed", filedAs: "_inbox/failed/bad.md" });
    expect(result!.reason).toContain("_inbox/drafts/bad.md (draft_key bad-1): ");
    expect(result!.reason).toContain(reason);
    expect(application.reviews()).toHaveLength(0);
  });

  it("is idempotent: a re-sent extracted draft points at the same Review Item", async () => {
    const { root, application } = await vault();
    const content = draft("kind: decision\ndraft_key: dup-1\norigin: agent-extracted\ntitle: Go with vendor B\nconfidence: Medium");
    await dropDraft(root, "d.md", content);
    const first = await application.adoptDrafts();
    await dropDraft(root, "d.md", content);
    const again = await application.adoptDrafts();
    expect(again.drafts[0]).toMatchObject({ outcome: "duplicate", objectIds: first.drafts[0]!.objectIds });
    expect(application.reviews()).toHaveLength(1);
  });

  it("shows an evidence reference to a missing source as unresolved instead of crashing", async () => {
    const { root, application } = await vault();
    const source = await application.ingestTextSource("Kick-off notes", "Owner is Rahul.");
    await dropDraft(root, "missing.md", draft(`
kind: open-point
draft_key: missing-1
origin: agent-extracted
title: Who owns the pilot?
confidence: Low
evidence:
  - source: Gong call 4711
    locator: "00:03:10"
  - source: ${source.frontmatter.id}
    locator: section Owners
`));
    expect((await application.adoptDrafts()).drafts[0]!.outcome).toBe("adopted");
    const [review] = application.reviews().filter((item) => item.frontmatter.target_object_type === "open-point");
    expect(review!.frontmatter.source_ids).toEqual([source.frontmatter.id]);
    expect(application.reviewEvidence(review!.frontmatter.id).title).toEqual([
      { field: "title", source_ref: "Gong call 4711", locator: "00:03:10", resolved: false },
      expect.objectContaining({ field: "title", source_id: source.frontmatter.id, resolved: true })
    ]);

    // The source disappears later (or the file names an ID that never existed): still shown, as unresolved.
    const file = path.join(root, review!.relativePath);
    await writeFile(file, (await readFile(file, "utf8")).replaceAll(source.frontmatter.id, "01928a1e-0000-7000-8000-00000000dead"));
    await application.rebuildIndex();
    expect(application.reviewEvidence(review!.frontmatter.id).title![1]).toMatchObject({ source_id: "01928a1e-0000-7000-8000-00000000dead", resolved: false });
    expect(application.reviewEvidence(review!.frontmatter.id).title![1]!.source_title).toBeUndefined();
  });

  it("keeps the source language exactly as written (no translation)", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "fr.md", draft(`
kind: task
draft_key: fr-1
origin: agent-extracted
title: Envoyer la présentation à Joël avant vendredi
confidence: High
evidence:
  - source: Compte rendu réunion
    locator: "§ Prochaines étapes"
    quote: "Rahul enverra la présentation"
`, "Joël a demandé la présentation chiffrée.\n"));
    await application.adoptDrafts();
    const [review] = application.reviews();
    expect(review!.frontmatter.title).toBe("Envoyer la présentation à Joël avant vendredi");
    expect(review!.frontmatter.proposed_fields).toMatchObject({ title: "Envoyer la présentation à Joël avant vendredi", body: "Joël a demandé la présentation chiffrée." });
    expect((review!.frontmatter.field_evidence as Record<string, unknown[]>).title![0]).toMatchObject({ locator: "§ Prochaines étapes", quote: "Rahul enverra la présentation" });
    expect(review!.body).toContain("Joël a demandé la présentation chiffrée.");

    const task = await application.acceptReviewItem(review!.frontmatter.id);
    expect(task.frontmatter.title).toBe("Envoyer la présentation à Joël avant vendredi");
    expect(task.body).toContain("Joël a demandé la présentation chiffrée.");
  });
});

describe("editing and accepting an extracted Review Item", () => {
  async function extractedTask() {
    const { root, application } = await vault();
    await dropDraft(root, "task.md", draft(`
kind: task
draft_key: edit-1
origin: agent-extracted
title: Send Joel the deck
confidence: Medium
priority: Low
due_on: 2026-10-09
expected_output: Deck sent
area: work
`, "From the Q3 sync.\n"));
    await application.adoptDrafts();
    const [review] = application.reviews();
    return { root, application, review: review! };
  }

  it("lets the user edit title, owner, due, priority and context links, then accepts as agent-extracted", async () => {
    const { application, review } = await extractedTask();
    const joel = await application.createEntity("person", { title: "Joel" });
    const project = await application.createEntity("project", { title: "Retail media pilot" });
    const client = await application.createEntity("client", { title: "Carrefour" });
    const product = await application.createEntity("product", { title: "AIR" });

    const edited = await application.updateReviewFields(review.frontmatter.id, {
      title: "Send Joel the sizing deck", owner_person_id: joel.frontmatter.id, due_at: "2026-10-09T17:00:00+02:00", due_timezone: "Europe/Paris", priority: "High",
      primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id
    });
    expect(edited.frontmatter.title).toBe("Send Joel the sizing deck");
    expect(edited.frontmatter.proposed_fields).toMatchObject({ title: "Send Joel the sizing deck", owner_person_id: joel.frontmatter.id, due_at: "2026-10-09T15:00:00.000Z", due_timezone: "Europe/Paris", priority: "High" });
    expect((edited.frontmatter.proposed_fields as Record<string, unknown>).due_on).toBeUndefined();
    expect(edited.frontmatter).toMatchObject({ primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id });

    const task = await application.acceptReviewItem(review.frontmatter.id);
    expect(task.frontmatter).toMatchObject({
      type: "task", origin: "agent-extracted", title: "Send Joel the sizing deck", status: "Inbox", owner_person_id: joel.frontmatter.id,
      due_at: "2026-10-09T15:00:00.000Z", due_timezone: "Europe/Paris", priority: "High", expected_output: "Deck sent", area: "work",
      primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id
    });
    expect(task.frontmatter.due_on).toBeUndefined();
    expect(task.body).toContain("From the Q3 sync.");
    expect(application.object(review.frontmatter.id).frontmatter).toMatchObject({ status: "accepted", resolved_object_id: task.frontmatter.id });

    // Accepting again is a no-op that returns the same object.
    expect((await application.acceptReviewItem(review.frontmatter.id)).frontmatter.id).toBe(task.frontmatter.id);
    expect(await ofType(application, "task")).toHaveLength(1);
  });

  it("defaults the owner to self and keeps the proposed due date and priority when not edited", async () => {
    const { application, review } = await extractedTask();
    const task = await application.acceptReviewItem(review.frontmatter.id);
    const self = (await ofType(application, "person")).find((person) => person.frontmatter.is_self === true);
    expect(task.frontmatter).toMatchObject({ origin: "agent-extracted", owner_person_id: self!.frontmatter.id, due_on: "2026-10-09", priority: "Low" });
  });

  it("clears a proposed field with null and refuses invalid edits", async () => {
    const { application, review } = await extractedTask();
    const project = await application.createEntity("project", { title: "Pilot" });
    const cleared = await application.updateReviewFields(review.frontmatter.id, { due_on: null, priority: null });
    expect(cleared.frontmatter.proposed_fields).not.toHaveProperty("due_on");
    expect(cleared.frontmatter.proposed_fields).not.toHaveProperty("priority");

    const id = review.frontmatter.id;
    await expect(application.updateReviewFields(id, { owner_person_id: project.frontmatter.id })).rejects.toThrow(/owner_person_id: .* is not a person/);
    await expect(application.updateReviewFields(id, { primary_client_id: project.frontmatter.id })).rejects.toThrow(/primary_client_id: .* is not a client/);
    await expect(application.updateReviewFields(id, { priority: "Urgent" })).rejects.toThrow(/priority: /);
    await expect(application.updateReviewFields(id, { due_on: "2026-02-30" })).rejects.toThrow(/due_on: /);
    await expect(application.updateReviewFields(id, { due_at: "tomorrow" })).rejects.toThrow(/due_at: /);
    await expect(application.updateReviewFields(id, { title: "  " })).rejects.toThrow(/title/i);
    await expect(application.updateReviewFields(id, { colour: "red" } as never)).rejects.toThrow(/colour: cannot be edited/);

    await application.rejectReviewItem(id);
    await expect(application.updateReviewFields(id, { priority: "High" })).rejects.toThrow(/pending/);
  });

  it("accepts an extracted decision and open point with agent-extracted origin", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "decision.md", draft("kind: decision\ndraft_key: dec-1\norigin: agent-extracted\ntitle: Go with vendor B\nconfidence: High\ndecided_at: 2026-10-03T16:00:00+02:00"));
    await dropDraft(root, "open.md", draft("kind: open-point\ndraft_key: op-1\norigin: agent-extracted\ntitle: Who owns the pilot?\nconfidence: Low"));
    await application.adoptDrafts();
    const decisionReview = application.reviews().find((item) => item.frontmatter.target_object_type === "decision")!;
    const openReview = application.reviews().find((item) => item.frontmatter.target_object_type === "open-point")!;
    await expect(application.updateReviewFields(decisionReview.frontmatter.id, { priority: "High" })).rejects.toThrow(/priority: cannot be edited on a decision/);

    const decision = await application.acceptReviewItem(decisionReview.frontmatter.id);
    expect(decision.frontmatter).toMatchObject({ type: "decision", origin: "agent-extracted", status: "active", decision_text: "Go with vendor B", decided_at: "2026-10-03T14:00:00.000Z" });
    const open = await application.acceptReviewItem(openReview.frontmatter.id);
    expect(open.frontmatter).toMatchObject({ type: "open-point", origin: "agent-extracted", status: "open" });
  });
});

describe("dictated decisions and open points", () => {
  it("creates a user-dictated decision and open point directly, without a Review Item", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "decision.md", draft("kind: decision\ndraft_key: dd-1\norigin: user-dictated\ntitle: Pause the loyalty pilot\narea: work\ntags:\n  - pilot", "Budget moved to Q1.\n"));
    await dropDraft(root, "open.md", draft("kind: open-point\ndraft_key: do-1\norigin: user-dictated\ntitle: Do we need legal sign-off?", "Check with Anne.\n"));
    const batch = await application.adoptDrafts();
    expect(batch.drafts.map((result) => result.outcome)).toEqual(["adopted", "adopted"]);
    expect(application.reviews()).toHaveLength(0);

    const [decision] = await ofType(application, "decision");
    expect(decision!.relativePath.startsWith("decisions/")).toBe(true);
    expect(decision!.frontmatter).toMatchObject({ origin: "user-dictated", status: "active", title: "Pause the loyalty pilot", decision_text: "Pause the loyalty pilot", decided_at: "2026-10-04T07:15:00.000Z", captured_at: "2026-10-04T07:15:00.000Z", area: "work", tags: ["pilot"], source_ids: [] });
    expect(application.object(decision!.frontmatter.id).body).toContain("Budget moved to Q1.");

    const [open] = await ofType(application, "open-point");
    const self = (await ofType(application, "person")).find((person) => person.frontmatter.is_self === true);
    expect(open!.relativePath.startsWith("open-points/")).toBe(true);
    expect(open!.frontmatter).toMatchObject({ origin: "user-dictated", status: "open", owner_person_id: self!.frontmatter.id, title: "Do we need legal sign-off?" });
    expect(application.object(open!.frontmatter.id).body).toContain("Check with Anne.");
  });

  it("fails a dictated decision with an unreadable decided_at", async () => {
    const { root, application } = await vault();
    await dropDraft(root, "decision.md", draft("kind: decision\ndraft_key: dd-2\norigin: user-dictated\ntitle: Pause\ndecided_at: last week"));
    const [result] = (await application.adoptDrafts()).drafts;
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result!.reason).toMatch(/decided_at: not an ISO 8601 date-time/);
    expect(await ofType(application, "decision")).toHaveLength(0);
  });
});
