import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #37: meaning-changing Patch Drafts, agent-extracted ones, and patches that would overwrite a newer
// edit become `update` Review Items; accepting one applies the fields with the revision check.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-patch-review-"));
  roots.push(root);
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  return { root, application };
}

async function write(root: string, relativePath: string, content: string, old = false) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  if (old) { const past = new Date(Date.now() - 60_000); await utimes(target, past, past); }
}
const drop = (root: string, name: string, fields: Record<string, unknown>) => write(root, `_inbox/patches/${name}`, `---\n${stringify(fields).trimEnd()}\n---\n`, true);
const patch = (fields: Record<string, unknown>) => ({ lifeos_patch: 1, draft_key: `key-${Math.random()}`, origin: "user-dictated", captured_at: "2026-01-01T09:00:00Z", ...fields });
const fileOf = async (root: string, relativePath: string) => {
  const [, yaml, body] = (await readFile(path.join(root, relativePath), "utf8")).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)!;
  return { frontmatter: parse(yaml!) as Record<string, unknown>, body: body! };
};
const audits = (application: LifeOSApplication, action: string) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action));
const updateReviews = async (application: LifeOSApplication) => (await application.reviews()).filter((review) => review.frontmatter.review_type === "update");
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const openPoint = (id: string) => `---\nid: ${id}\ntype: open-point\nschema_version: 1\nrevision: 1\ntitle: Who owns the pilot budget?\ncreated_at: 2025-12-01T08:00:00Z\nupdated_at: 2025-12-01T08:00:00Z\nupdated_by_device: test\nstatus: open\n---\n# Who owns the pilot budget?\n`;

describe("patches that always need review", () => {
  it("raises an update Review Item for a dictated title change, files the patch as review, and applies it on accept", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Call the bank");
    const id = task.frontmatter.id;
    await drop(root, "rename.md", patch({ draft_key: "rename", id, set: { title: "Call the bank about the loan" } }));

    const batch = await application.adoptDrafts();
    const [review] = await updateReviews(application);
    expect(batch.drafts).toEqual([expect.objectContaining({ outcome: "review", objectIds: [review!.frontmatter.id], filedAs: "_inbox/processed/rename.md" })]);
    expect((await fileOf(root, "_inbox/processed/rename.result.md")).frontmatter).toMatchObject({ outcome: "review", object_ids: [review!.frontmatter.id], errors: [] });
    expect((await fileOf(root, "_inbox/processed/rename.result.md")).body).toMatch(/Waiting for review/);
    expect(application.object(batch.agentRunId!).frontmatter).toMatchObject({ related_object_ids: [review!.frontmatter.id], output_summary: expect.stringMatching(/1 to review/) });

    // Nothing changed yet; the item shows current vs proposed per field.
    expect((await fileOf(root, task.relativePath)).frontmatter).toMatchObject({ title: "Call the bank", revision: 1 });
    const onDisk = await fileOf(root, review!.relativePath);
    expect(onDisk.frontmatter).toMatchObject({
      review_type: "update", target_object_type: "task", target_object_id: id, status: "pending", origin: "user-dictated", agent_run_id: batch.agentRunId,
      proposed_fields: { changes: [{ field: "title", current: "Call the bank", proposed: "Call the bank about the loan" }], reasons: ["set.title: changes to title need review"], base_revision: 1, base_hash: task.contentHash, draft_key: "rename" }
    });
    expect(onDisk.body).toContain("| title | Call the bank | Call the bank about the loan |");
    expect((await audits(application, "patch.review-raised"))[0]!.frontmatter).toMatchObject({ object_id: review!.frontmatter.id, metadata: expect.objectContaining({ draft_key: "rename", target_object_id: id }) });
    expect(await audits(application, "patch.applied")).toHaveLength(0);
    await expect(application.updateReviewTitle(review!.frontmatter.id, "Other")).rejects.toThrow(/cannot be renamed/);

    const accepted = await application.acceptReviewItem(review!.frontmatter.id);
    expect(accepted.frontmatter).toMatchObject({ id, title: "Call the bank about the loan", revision: 2 });
    expect((await fileOf(root, task.relativePath)).frontmatter).toMatchObject({ title: "Call the bank about the loan", revision: 2 });
    expect(application.object(review!.frontmatter.id).frontmatter).toMatchObject({ status: "accepted", resolved_object_id: id });
    const [audit] = (await audits(application, "review.accepted"));
    expect(audit!.frontmatter).toMatchObject({ object_id: id, metadata: { review_id: review!.frontmatter.id, draft_key: "rename", before: { title: "Call the bank" }, after: { title: "Call the bank about the loan" } } });

    // Accepting twice is a no-op.
    expect((await application.acceptReviewItem(review!.frontmatter.id)).frontmatter.revision).toBe(2);
    expect(await audits(application, "review.accepted")).toHaveLength(1);
  });

  it.each([
    ["owner", async (application: LifeOSApplication) => {
      const task = await application.quickCapture("Draft the pilot plan");
      const joel = await application.createEntity("person", { title: "Joël Martin" });
      const self = application.object(String(task.frontmatter.owner_person_id));
      return { target: task, set: { owner: "joel martin" }, changes: [{ field: "owner_person_id", current: self.frontmatter.id, proposed: joel.frontmatter.id }] };
    }],
    ["decision text", async (application: LifeOSApplication) => {
      const decision = await application.createDecision({ title: "Use Postgres", decision_text: "We use Postgres" });
      return { target: decision, set: { decision_text: "We use Postgres for reporting only" }, changes: [{ field: "decision_text", current: "We use Postgres", proposed: "We use Postgres for reporting only" }] };
    }],
    ["any field on a decision", async (application: LifeOSApplication) => {
      const decision = await application.createDecision({ title: "Use Postgres" });
      return { target: decision, set: { rationale: "The team knows it" }, changes: [{ field: "rationale", current: null, proposed: "The team knows it" }] };
    }],
    ["superseding a decision", async (application: LifeOSApplication) => {
      const old = await application.createDecision({ title: "Use Postgres" });
      const successor = await application.createDecision({ title: "Use DuckDB" });
      return { target: old, set: { superseded_by: "use duckdb" }, changes: [{ field: "status", current: "active", proposed: "superseded" }, { field: "superseded_by_decision_id", current: null, proposed: successor.frontmatter.id }] };
    }],
    ["resolving an open point", async (application: LifeOSApplication, root: string) => {
      const id = uuidV7();
      await write(root, "open-points/budget.md", openPoint(id));
      await application.rebuildIndex();
      return { target: application.object(id), set: { status: "resolved", resolution_summary: "Budget approved" }, changes: [{ field: "status", current: "open", proposed: "resolved" }, { field: "resolution_summary", current: null, proposed: "Budget approved" }, { field: "resolved_at", current: null, proposed: expect.any(String) }] };
    }]
  ])("raises a Review Item for %s even when dictated, and applies it on accept", async (_name, given) => {
    const { root, application } = await vault();
    const { target, set, changes } = await given(application, root);
    await drop(root, "change.md", patch({ id: target.frontmatter.id, set }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
    expect(application.object(target.frontmatter.id).frontmatter.revision).toBe(target.frontmatter.revision);
    const [review] = await updateReviews(application);
    expect(review!.frontmatter.proposed_fields).toMatchObject({ changes });

    await application.acceptReviewItem(review!.frontmatter.id);
    const after = application.object(target.frontmatter.id).frontmatter;
    for (const change of changes) expect(after[change.field]).toEqual(change.proposed);
    expect(after.revision).toBe(target.frontmatter.revision + 1);
  });

  it("routes every agent-extracted patch to review, including status changes and appended notes", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    await drop(root, "agent.md", patch({ origin: "agent-extracted", id: task.frontmatter.id, set: { status: "Done" }, append_note: "Joel confirmed receipt." }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
    const [review] = await updateReviews(application);
    expect(review!.frontmatter).toMatchObject({ origin: "agent-extracted", confidence_label: "Medium", proposed_fields: { append_note: "Joel confirmed receipt.", reasons: ["origin: agent-extracted patches always need review"] } });
    expect((review!.frontmatter.proposed_fields as { changes: Array<{ field: string }> }).changes.map((change) => change.field)).toEqual(["status", "completed_at"]);
    expect(review!.body).toContain("> Joel confirmed receipt.");
    expect(application.object(task.frontmatter.id).frontmatter.status).toBe("Inbox");

    await application.acceptReviewItem(review!.frontmatter.id);
    const onDisk = await fileOf(root, task.relativePath);
    expect(onDisk.frontmatter).toMatchObject({ status: "Done", completed_at: "2026-01-01T09:00:00.000Z", revision: 2, origin: "app" });
    expect(onDisk.body).toBe("# Send Joel the sizing deck\n\nJoel confirmed receipt.\n");
  });

  it("files a re-sent identical review patch as a duplicate without raising a second item", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Call the bank");
    const fields = patch({ draft_key: "same", id: task.frontmatter.id, set: { title: "Renamed" } });
    await drop(root, "p.md", fields);
    await application.adoptDrafts();
    await drop(root, "p.md", fields);
    const [review] = await updateReviews(application);
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "duplicate", objectIds: [review!.frontmatter.id] });
    expect(await updateReviews(application)).toHaveLength(1);
  });
});

describe("patches refused before review", () => {
  it.each([
    ["bad value on the review route", "task", { origin: "agent-extracted", set: { status: "Finished" } }, /status: unknown status "Finished"/],
    ["unknown owner", "task", { set: { owner: "Nobody" } }, /owner: no person called "Nobody"/],
    ["protected field", "task", { set: { origin: "app", created_at: "2026-01-01T00:00:00Z" } }, /set\.origin: cannot be changed by a patch.*set\.created_at: cannot be changed/],
    ["empty title", "task", { set: { title: null } }, /set\.title: /],
    ["non-decision field on a decision", "decision", { set: { owner: "You" } }, /set\.owner: not a decision field/],
    ["superseded without a successor", "decision", { set: { status: "superseded" } }, /set\.status: to supersede a decision, give superseded_by/],
    ["superseded by itself", "decision", { set: { superseded_by: "Use Postgres" } }, /superseded_by: a decision cannot supersede itself/],
    ["unknown successor", "decision", { set: { superseded_by: "Use Oracle" } }, /superseded_by: no decision called "Use Oracle"/],
    ["supersede link set directly", "decision", { set: { superseded_by_decision_id: "01890000-0000-7000-8000-000000000000" } }, /set\.superseded_by_decision_id: cannot be changed by a patch; use superseded_by/],
    ["unknown decision status", "decision", { set: { status: "paused" } }, /set\.status: /]
  ])("fails a patch with %s and raises nothing", async (_name, type, fields, reason) => {
    const { root, application } = await vault();
    const target = type === "task" ? await application.quickCapture("Call the bank") : await application.createDecision({ title: "Use Postgres" });
    await drop(root, "bad.md", patch({ id: target.frontmatter.id, ...fields }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "failed", filedAs: "_inbox/failed/bad.md" });
    expect(batch.drafts[0]!.reason).toMatch(reason);
    expect(await updateReviews(application)).toHaveLength(0);
    expect(application.object(target.frontmatter.id).frontmatter.revision).toBe(1);
  });

  it("refuses to reopen a reversed decision: final lifecycle states hold for patches", async () => {
    const { root, application } = await vault();
    const decision = await application.createDecision({ title: "Use Postgres" });
    await application.updateDecision(decision.frontmatter.id, { status: "reversed" }, decision.contentHash);
    await drop(root, "reopen.md", patch({ id: decision.frontmatter.id, set: { status: "active" } }));
    const batch = await application.adoptDrafts();
    expect(batch.drafts[0]).toMatchObject({ outcome: "failed" });
    expect(batch.drafts[0]!.reason).toMatch(/A reversed decision is final and cannot become active/);
  });
});

describe("the conflict rule", () => {
  /** A task, then `captured_at`, then the user's own edit: the edit is newer than the dictation. */
  async function editedAfterCapture(edit: Record<string, unknown>) {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    await tick();
    const capturedAt = new Date().toISOString();
    await tick();
    await application.updateTask(task.frontmatter.id, { status: "Inbox", ...edit }, application.object(task.frontmatter.id).contentHash);
    return { root, application, task: application.object(task.frontmatter.id), capturedAt };
  }

  it("raises a Review Item when a patched field was edited after the patch was captured", async () => {
    const { root, application, task, capturedAt } = await editedAfterCapture({ priority: "Low" });
    await drop(root, "late.md", patch({ id: task.frontmatter.id, captured_at: capturedAt, set: { priority: "High" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
    expect(application.object(task.frontmatter.id).frontmatter).toMatchObject({ priority: "Low", revision: 2 });
    const [review] = await updateReviews(application);
    expect(review!.frontmatter.proposed_fields).toMatchObject({
      changes: [{ field: "priority", current: "Low", proposed: "High" }], base_revision: 2,
      reasons: [expect.stringMatching(/^conflict: priority changed after this patch was captured/)]
    });
    expect(review!.body).toContain("| priority | Low | High |");
  });

  it("applies when the newer edit touched other fields only", async () => {
    const { root, application, task, capturedAt } = await editedAfterCapture({ due_on: "2026-12-01" });
    await drop(root, "late.md", patch({ id: task.frontmatter.id, captured_at: capturedAt, set: { priority: "High" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied" });
    expect(application.object(task.frontmatter.id).frontmatter).toMatchObject({ priority: "High", due_on: "2026-12-01" });
  });

  it("orders patches by when they were dictated: an older patch does not overwrite a newer one adopted first", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    await drop(root, "a-newer.md", patch({ id: task.frontmatter.id, captured_at: "2020-01-01T10:00:00Z", set: { priority: "High" } }));
    await drop(root, "b-older.md", patch({ id: task.frontmatter.id, captured_at: "2020-01-01T09:00:00Z", set: { priority: "Low" } }));
    expect((await application.adoptDrafts()).drafts.map((result) => result.outcome)).toEqual(["applied", "review"]);
    expect(application.object(task.frontmatter.id).frontmatter.priority).toBe("High");
  });

  it("lets a later-dictated patch apply over an earlier-dictated one adopted after its capture (dictation order, #81 base check)", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    await tick();
    const first = new Date().toISOString();
    await tick();
    const second = new Date().toISOString();
    await tick();
    await drop(root, "a-first.md", patch({ id: task.frontmatter.id, captured_at: first, set: { priority: "High" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied" });
    await drop(root, "b-second.md", patch({ id: task.frontmatter.id, captured_at: second, set: { priority: "Low" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied" });
    expect(application.object(task.frontmatter.id).frontmatter.priority).toBe("Low");
  });

  it("treats an edit with unknown fields (another device, no audit) as touching every field", async () => {
    const { root, application } = await vault();
    const task = await application.quickCapture("Send Joel the sizing deck");
    const later = new Date(Date.now() + 60_000).toISOString();
    const raw = await readFile(path.join(root, task.relativePath), "utf8");
    await write(root, task.relativePath, raw.replace("revision: 1", "revision: 2").replace(/updated_at: .*/, `updated_at: ${later}`).replace(/updated_by_device: .*/, "updated_by_device: other-mac"));
    await application.rebuildIndex();
    await drop(root, "p.md", patch({ id: task.frontmatter.id, captured_at: new Date(Date.now() + 30_000).toISOString(), set: { priority: "High" } }));
    expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
  });

  // #81: the rule compares the target with its version at capture, so an edit no audit describes is still caught.
  describe("an Obsidian edit to a patched field after capture", () => {
    /** Sets `priority: Low` in the task file by hand, as Obsidian would: same revision, no audit. */
    async function obsidianEdit(root: string, application: LifeOSApplication, id: string) {
      const file = path.join(root, application.object(id).relativePath);
      const raw = await readFile(file, "utf8");
      await writeFile(file, raw.replace(/\nstatus: (.*)\n/, "\nstatus: $1\npriority: Low\n"));
      await application.rebuildIndex();
    }
    const unrelatedEdit = (application: LifeOSApplication, id: string) => application.setSensitivity(id, "restricted", application.object(id).contentHash);

    it.each([
      ["before an unrelated audited edit", true, false],
      ["after an unrelated audited edit", false, true],
      ["with no other edit at all", false, false]
    ] as const)("routes the patch to review when the Obsidian edit came %s", async (_label, editFirst, editAfter) => {
      const { root, application } = await vault();
      const task = await application.quickCapture("Send Joel the sizing deck");
      const id = task.frontmatter.id;
      await tick();
      const capturedAt = new Date().toISOString();
      await tick();
      if (editFirst) await obsidianEdit(root, application, id);
      if (editFirst || editAfter) await unrelatedEdit(application, id);
      if (!editFirst) await obsidianEdit(root, application, id);
      await drop(root, "late.md", patch({ id, captured_at: capturedAt, set: { priority: "High" } }));

      expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "review" });
      expect(application.object(id).frontmatter.priority).toBe("Low");
      expect(await audits(application, "patch.applied")).toEqual([]);
      const [review] = await updateReviews(application);
      expect(review!.frontmatter.proposed_fields).toMatchObject({ reasons: [expect.stringMatching(/^conflict: priority changed after this patch was captured/)] });
    });

    it("still applies when the Obsidian edit touched another field only", async () => {
      const { root, application } = await vault();
      const task = await application.quickCapture("Send Joel the sizing deck");
      const id = task.frontmatter.id;
      await tick();
      const capturedAt = new Date().toISOString();
      await tick();
      await obsidianEdit(root, application, id);
      await unrelatedEdit(application, id);
      await drop(root, "late.md", patch({ id, captured_at: capturedAt, set: { due_on: "2026-12-01" } }));
      expect((await application.adoptDrafts()).drafts[0]).toMatchObject({ outcome: "applied" });
      expect(application.object(id).frontmatter).toMatchObject({ due_on: "2026-12-01", priority: "Low", sensitivity: "restricted" });
    });
  });
});

describe("accepting an update Review Item", () => {
  async function raised() {
    const { root, application } = await vault();
    const task = await application.quickCapture("Call the bank");
    await drop(root, "rename.md", patch({ id: task.frontmatter.id, set: { title: "Renamed" } }));
    await application.adoptDrafts();
    const [review] = await updateReviews(application);
    return { root, application, task, review: review! };
  }

  it("fails as a conflict when the target changed again since the item was raised, and writes nothing", async () => {
    const { root, application, task, review } = await raised();
    await application.updateTask(task.frontmatter.id, { status: "Next" }, application.object(task.frontmatter.id).contentHash);
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toMatchObject({ name: "ObjectConflictError", message: expect.stringMatching(/changed since this review item was raised/) });
    expect((await fileOf(root, task.relativePath)).frontmatter).toMatchObject({ title: "Call the bank", status: "Next", revision: 2 });
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("pending");
    expect((await application.rejectReviewItem(review.frontmatter.id)).frontmatter.status).toBe("rejected");
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toThrow(/not pending/);
  });

  it("fails as a conflict after an external edit that kept the revision", async () => {
    const { root, application, task, review } = await raised();
    const raw = await readFile(path.join(root, task.relativePath), "utf8");
    await write(root, task.relativePath, `${raw}\nEdited in Obsidian.\n`);
    await application.rebuildIndex();
    await expect(application.acceptReviewItem(review.frontmatter.id)).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect((await fileOf(root, task.relativePath)).frontmatter.title).toBe("Call the bank");
  });

  it("finishes an accept interrupted after the target write, without writing it twice", async () => {
    const { application, task, review } = await raised();
    // The target already holds exactly the proposed change, one revision on: as if the review update had crashed.
    await application.updateTask(task.frontmatter.id, { title: "Renamed", status: "Inbox" }, application.object(task.frontmatter.id).contentHash);
    const accepted = await application.acceptReviewItem(review.frontmatter.id);
    expect(accepted.frontmatter).toMatchObject({ title: "Renamed", revision: 2 });
    expect(application.object(review.frontmatter.id).frontmatter.status).toBe("accepted");
  });

  it("enforces the decision lifecycle on accept through the guarded write", async () => {
    const { root, application } = await vault();
    const decision = await application.createDecision({ title: "Use Postgres" });
    const reversed = await application.updateDecision(decision.frontmatter.id, { status: "reversed" }, decision.contentHash);
    // A hand-made item proposing an illegal move against the current version: the write rules still refuse it.
    const id = uuidV7();
    await write(root, `review-items/${id}.md`, `---\n${stringify({
      id, type: "review-item", schema_version: 1, revision: 1, title: "Reopen", created_at: "2026-01-01T09:00:00Z", updated_at: "2026-01-01T09:00:00Z", updated_by_device: "test",
      review_type: "update", target_object_type: "decision", target_object_id: decision.frontmatter.id, confidence_label: "High", status: "pending", operation_id: uuidV7(), field_evidence: {},
      proposed_fields: { changes: [{ field: "status", current: "reversed", proposed: "active" }], reasons: [], base_revision: reversed.frontmatter.revision, base_hash: reversed.contentHash, draft_key: "x", captured_at: "2026-01-01T09:00:00Z" }
    }).trimEnd()}\n---\n# Reopen\n`);
    await application.rebuildIndex();
    await expect(application.acceptReviewItem(id)).rejects.toThrow(/A reversed decision is final/);
    expect(application.object(decision.frontmatter.id).frontmatter.status).toBe("reversed");
    expect(application.object(id).frontmatter.status).toBe("pending");
  });
});
