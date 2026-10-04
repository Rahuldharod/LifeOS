import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { lifecycleWriteProblem, validateFrontmatter } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #41: Decisions workspace — list with filters, detail with links, manual create/edit, supersede.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const ids = {
  person: "01995d60-7baf-7c21-9c96-9c5d2f6a3201",
  meeting: "01995d60-7baf-7c21-9c96-9c5d2f6a3202",
  source: "01995d60-7baf-7c21-9c96-9c5d2f6a3203",
  decision: "01995d60-7baf-7c21-9c96-9c5d2f6a3204",
  review: "01995d60-7baf-7c21-9c96-9c5d2f6a3205",
  operation: "01995d60-7baf-7c21-9c96-9c5d2f6a3206"
};
const stamp = "created_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test";

async function setup(files: Record<string, string> = {}, store?: (root: string) => MarkdownObjectStore) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-decisions-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const application = new LifeOSApplication(store ? store(root) : new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "decisions-test");
  await application.rebuildIndex();
  return { root, application };
}

const decisionsOnDisk = async (root: string) => (await readdir(path.join(root, "decisions")).catch(() => [])).length;

describe("decisions workspace", () => {
  it("creates a decision by hand with origin app, active status and a decided_at default", async () => {
    const { root, application } = await setup();
    const decision = await application.createDecision({ title: "Use Postgres", decision_text: "We will use Postgres for reporting", rationale: "Team knows it", origin: "agent-extracted", status: "superseded" });
    expect(decision.relativePath).toMatch(/^decisions\/.*use-postgres--/);
    expect(decision.frontmatter).toMatchObject({ type: "decision", origin: "app", status: "active", decision_text: "We will use Postgres for reporting", rationale: "Team knows it" });
    expect(Date.parse(String(decision.frontmatter.decided_at))).not.toBeNaN();
    expect((await application.listObjects()).some((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "decision.created" && object.frontmatter.object_id === decision.frontmatter.id)).toBe(true);

    const short = await application.createDecision({ title: "Ship Friday", decided_at: "2026-09-30T10:00:00.000Z" });
    expect(short.frontmatter).toMatchObject({ decision_text: "Ship Friday", decided_at: "2026-09-30T10:00:00.000Z" });
    await expect(application.createDecision({ title: "  " })).rejects.toThrow(/Title is required/);
    await expect(application.createDecision({ title: "Bad date", decided_at: "yesterday" })).rejects.toThrow();
    expect(await decisionsOnDisk(root)).toBe(2);
  });

  it("edits a decision through a guarded save and keeps the origin it was created with", async () => {
    const { application } = await setup({ "decisions/agent.md": `---\nid: ${ids.decision}\ntype: decision\nschema_version: 1\nrevision: 1\ntitle: From meeting\n${stamp}\norigin: agent-extracted\nstatus: active\ndecision_text: From meeting\ndecided_at: 2026-10-01T08:00:00Z\n---\n# From meeting\n` });
    const current = application.object(ids.decision);
    const edited = await application.updateDecision(ids.decision, { decision_text: "Clarified text", rationale: "Because", origin: "app" }, current.contentHash);
    expect(edited.frontmatter).toMatchObject({ decision_text: "Clarified text", rationale: "Because", origin: "agent-extracted", revision: 2 });

    await expect(application.updateDecision(ids.decision, { title: "Stale" }, current.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    await expect(application.updateDecision(ids.decision, { title: "No hash" }, "")).rejects.toThrow(/expectedHash/);
    await expect(application.updateDecision(ids.decision, { decision_text: "" }, edited.contentHash)).rejects.toThrow();
    await expect(application.updateDecision(ids.decision, { status: "superseded" }, edited.contentHash)).rejects.toThrow(/Supersede/);
    expect(application.object(ids.decision).frontmatter.revision).toBe(2);
  });

  it("allows active to reversed by edit, and refuses any change out of a final status", async () => {
    const { application } = await setup();
    const decision = await application.createDecision({ title: "Pilot in Lyon" });
    const reversed = await application.updateDecision(decision.frontmatter.id, { status: "reversed" }, decision.contentHash);
    expect(reversed.frontmatter.status).toBe("reversed");
    await expect(application.updateDecision(decision.frontmatter.id, { status: "active" }, reversed.contentHash)).rejects.toThrow(/reversed/);
    await expect(application.supersedeDecision(decision.frontmatter.id, { title: "Pilot in Paris" }, reversed.contentHash)).rejects.toThrow(/Only active decisions/);
  });

  it("supersedes atomically: new decision links back, old one is marked superseded, both directions resolve", async () => {
    const { root, application } = await setup();
    const project = await application.createEntity("project", { title: "Launch" });
    const old = await application.createDecision({ title: "Launch in March", primary_project_id: project.frontmatter.id });
    const { decision: next, superseded } = await application.supersedeDecision(old.frontmatter.id, { title: "Launch in April", rationale: "Supplier delay" }, old.contentHash);

    expect(next.frontmatter).toMatchObject({ status: "active", origin: "app", supersedes_decision_id: old.frontmatter.id, primary_project_id: project.frontmatter.id, decision_text: "Launch in April", rationale: "Supplier delay" });
    expect(superseded.frontmatter).toMatchObject({ status: "superseded", superseded_by_decision_id: next.frontmatter.id, revision: 2 });
    expect(application.decision(next.frontmatter.id).supersedes?.frontmatter.id).toBe(old.frontmatter.id);
    expect(application.decision(old.frontmatter.id).supersededBy?.frontmatter.id).toBe(next.frontmatter.id);
    expect(await decisionsOnDisk(root)).toBe(2);
    expect((await application.listObjects()).some((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "decision.superseded" && object.frontmatter.object_id === old.frontmatter.id)).toBe(true);

    // Edge: an already-superseded decision cannot be superseded again, even with its fresh hash.
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "Launch in May" }, superseded.contentHash)).rejects.toThrow(/already superseded/);
    expect(await decisionsOnDisk(root)).toBe(2);
  });

  it("writes nothing when the supersede is stale or the new decision is invalid", async () => {
    const { root, application } = await setup();
    const old = await application.createDecision({ title: "Weekly sync on Monday" });
    const edited = await application.updateDecision(old.frontmatter.id, { rationale: "Changed elsewhere" }, old.contentHash);
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "Weekly sync on Tuesday" }, old.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "" }, edited.contentHash)).rejects.toThrow(/Title is required/);
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "Bad", decided_at: "soon" }, edited.contentHash)).rejects.toThrow();
    expect(await decisionsOnDisk(root)).toBe(1);
    expect(application.object(old.frontmatter.id).frontmatter.status).toBe("active");
  });

  it("finishes a supersede interrupted between its two writes through operation recovery", async () => {
    let failNewDecision = true;
    class CrashingStore extends MarkdownObjectStore {
      override async write(input: Parameters<MarkdownObjectStore["write"]>[0]) {
        if (failNewDecision && input.frontmatter.type === "decision" && input.frontmatter.supersedes_decision_id) { failNewDecision = false; throw new Error("disk full"); }
        return super.write(input);
      }
    }
    const { root, application } = await setup({}, (directory) => new CrashingStore(directory));
    const old = await application.createDecision({ title: "Budget is 10k" });
    await expect(application.supersedeDecision(old.frontmatter.id, { title: "Budget is 12k" }, old.contentHash)).rejects.toThrow(/disk full/);

    const recovered = await application.recoverOperations();
    expect(recovered).toHaveLength(1);
    expect(await application.recoverOperations()).toHaveLength(0);
    const after = application.decision(old.frontmatter.id);
    expect(after.decision.frontmatter.status).toBe("superseded");
    expect(after.supersededBy?.frontmatter).toMatchObject({ title: "Budget is 12k", status: "active", supersedes_decision_id: old.frontmatter.id });
    expect(await decisionsOnDisk(root)).toBe(2);
  });

  it("filters the list by project, client, product, person, status and date range, newest first", async () => {
    const { application } = await setup();
    const client = await application.createEntity("client", { title: "Carrefour" });
    const product = await application.createEntity("product", { title: "Loyalty" });
    const project = await application.createEntity("project", { title: "Pilot" });
    const person = await application.createEntity("person", { title: "Ada Lovelace" });
    const a = await application.createDecision({ title: "A", decided_at: "2026-09-01T09:00:00.000Z", primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id });
    const b = await application.createDecision({ title: "B", decided_at: "2026-09-15T09:00:00.000Z", primary_product_id: product.frontmatter.id, people_ids: [person.frontmatter.id] });
    const c = await application.createDecision({ title: "C", decided_at: "2026-09-30T09:00:00.000Z", primary_client_id: client.frontmatter.id });
    await application.updateDecision(c.frontmatter.id, { status: "reversed" }, c.contentHash);
    const titles = (filters: Parameters<LifeOSApplication["decisions"]>[0] = {}) => application.decisions(filters).map((decision) => decision.frontmatter.title);

    expect(titles()).toEqual(["C", "B", "A"]);
    expect(titles({ projectId: project.frontmatter.id })).toEqual(["A"]);
    expect(titles({ clientId: client.frontmatter.id })).toEqual(["C", "A"]);
    expect(titles({ productId: product.frontmatter.id })).toEqual(["B"]);
    expect(titles({ personId: person.frontmatter.id })).toEqual(["B"]);
    expect(titles({ status: "active" })).toEqual(["B", "A"]);
    expect(titles({ status: "reversed" })).toEqual(["C"]);
    expect(titles({ from: "2026-09-15T09:00:00.000Z" })).toEqual(["C", "B"]);
    expect(titles({ to: "2026-09-15T09:00:00.000Z" })).toEqual(["B", "A"]);
    expect(titles({ from: "2026-09-10T00:00:00.000Z", to: "2026-09-20T00:00:00.000Z" })).toEqual(["B"]);
    expect(titles({ clientId: client.frontmatter.id, status: "active" })).toEqual(["A"]);
    expect(() => application.decisions({ status: "maybe" })).toThrow(/status/);
    expect(() => application.decisions({ from: "not a date" })).toThrow(/date/);
    expect(() => application.decisions({ from: "2026-09-20T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" })).toThrow(/date/);
    expect(a.frontmatter.status).toBe("active");
  });

  it("detail shows the source meeting, sources and evidence, and the person filter follows meeting attendees", async () => {
    const { application } = await setup({
      "people/ada.md": `---\nid: ${ids.person}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: Ada\n${stamp}\ngiven_name: Ada\n---\n`,
      "meetings/m.md": `---\nid: ${ids.meeting}\ntype: meeting\nschema_version: 1\nrevision: 1\ntitle: Weekly review\n${stamp}\nstatus: scheduled\nstarts_at: 2026-10-01T08:00:00Z\nends_at: 2026-10-01T09:00:00Z\ntimezone: Europe/Paris\nattendee_ids: [${ids.person}]\n---\n`,
      "sources/s.md": `---\nid: ${ids.source}\ntype: source\nschema_version: 1\nrevision: 1\ntitle: Transcript\n${stamp}\nsource_type: meet-transcript\ncaptured_at: 2026-10-01T09:00:00Z\ningestion_status: processed\nfragments: [{id: f1, text: "We agreed to pilot in Lyon", locator: {timestamp: "00:12:30"}}]\n---\n`,
      "decisions/d.md": `---\nid: ${ids.decision}\ntype: decision\nschema_version: 1\nrevision: 1\ntitle: Pilot in Lyon\n${stamp}\norigin: agent-extracted\nstatus: active\ndecision_text: Pilot in Lyon\ndecided_at: 2026-10-01T08:30:00Z\nsource_meeting_id: ${ids.meeting}\nsource_ids: [${ids.source}]\n---\n`,
      "review-items/r.md": `---\nid: ${ids.review}\ntype: review-item\nschema_version: 1\nrevision: 2\ntitle: Pilot in Lyon\n${stamp}\nreview_type: create\ntarget_object_type: decision\nproposed_fields: {title: Pilot in Lyon}\nfield_evidence: {decision_text: [{source_id: ${ids.source}, fragment_id: f1}]}\nconfidence_label: High\nstatus: accepted\nresolved_object_id: ${ids.decision}\noperation_id: ${ids.operation}\n---\n`
    });
    const detail = application.decision(ids.decision);
    expect(detail.meeting?.frontmatter.id).toBe(ids.meeting);
    expect(detail.sources.map((source) => source.frontmatter.id)).toEqual([ids.source]);
    expect(detail.people.map((person) => person.frontmatter.id)).toEqual([ids.person]);
    expect(detail.evidence).toEqual([{ field: "decision_text", sourceId: ids.source, sourceTitle: "Transcript", fragmentId: "f1", text: "We agreed to pilot in Lyon", locator: { timestamp: "00:12:30" } }]);
    expect(detail.review?.frontmatter.id).toBe(ids.review);
    expect(application.decisions({ personId: ids.person }).map((decision) => decision.frontmatter.id)).toEqual([ids.decision]);
    expect(() => application.decision(ids.meeting)).toThrow(/not found/);
  });

  it("keeps decisions, superseded ones included, in project, client, product and person roll-ups", async () => {
    const { application } = await setup();
    const client = await application.createEntity("client", { title: "Client" });
    const product = await application.createEntity("product", { title: "Product" });
    const project = await application.createEntity("project", { title: "Project" });
    const person = await application.createEntity("person", { title: "Grace Hopper" });
    const old = await application.createDecision({ title: "Old", primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id, people_ids: [person.frontmatter.id] });
    const { decision: next } = await application.supersedeDecision(old.frontmatter.id, { title: "New" }, old.contentHash);
    const expected = [old.frontmatter.id, next.frontmatter.id].sort();
    const decisionIds = (objects: Array<{ frontmatter: { type: string; id: string } }>) => objects.filter((object) => object.frontmatter.type === "decision").map((object) => object.frontmatter.id).sort();

    expect(decisionIds(application.projects().find((rollup) => rollup.project.frontmatter.id === project.frontmatter.id)!.decisions)).toEqual(expected);
    for (const [type, entity] of [["client", client], ["product", product], ["person", person]] as const) {
      expect(decisionIds(application.rollups(type).find((rollup) => rollup.entity.frontmatter.id === entity.frontmatter.id)!.related)).toEqual(expected);
    }
  });

  it("enforces the decision lifecycle in the domain", () => {
    const base = { id: ids.decision, type: "decision", schema_version: 1, revision: 1, title: "D", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", updated_by_device: "d", decision_text: "D", decided_at: "2026-10-01T08:00:00Z" };
    expect(() => validateFrontmatter({ ...base, status: "active", superseded_by_decision_id: ids.review })).toThrow(/superseded_by_decision_id/);
    expect(() => validateFrontmatter({ ...base, status: "superseded", superseded_by_decision_id: ids.decision })).toThrow(/itself/);
    expect(lifecycleWriteProblem({ ...base, status: "superseded" })).toMatch(/active/);
    expect(lifecycleWriteProblem({ ...base, status: "active" })).toBeUndefined();
    expect(lifecycleWriteProblem({ ...base, status: "superseded" }, { ...base, status: "active" })).toBeUndefined();
    expect(lifecycleWriteProblem({ ...base, status: "active" }, { ...base, status: "superseded" })).toMatch(/superseded/);
    expect(lifecycleWriteProblem({ ...base, status: "active", supersedes_decision_id: ids.review }, { ...base, status: "active" })).toMatch(/supersedes_decision_id/);
  });
});
