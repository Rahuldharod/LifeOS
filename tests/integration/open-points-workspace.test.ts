import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { lifecycleWriteProblem, validateFrontmatter } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Issue #42: Open Points workspace — list with the Decisions filters, detail, manual create/edit, resolve or close.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const ids = {
  person: "01995d60-7baf-7c21-9c96-9c5d2f6a3301",
  meeting: "01995d60-7baf-7c21-9c96-9c5d2f6a3302",
  source: "01995d60-7baf-7c21-9c96-9c5d2f6a3303",
  point: "01995d60-7baf-7c21-9c96-9c5d2f6a3304",
  review: "01995d60-7baf-7c21-9c96-9c5d2f6a3305",
  operation: "01995d60-7baf-7c21-9c96-9c5d2f6a3306"
};
const stamp = "created_at: 2026-10-01T08:00:00Z\nupdated_at: 2026-10-01T08:00:00Z\nupdated_by_device: test";

async function setup(files: Record<string, string> = {}, store?: (root: string) => MarkdownObjectStore) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-open-points-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const application = new LifeOSApplication(store ? store(root) : new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "open-points-test");
  await application.rebuildIndex();
  return { root, application };
}

const filesIn = async (root: string, folder: string) => (await readdir(path.join(root, folder)).catch(() => [])).length;
const audited = async (application: LifeOSApplication, action: string, objectId: string) => (await application.listObjects()).some((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === action && object.frontmatter.object_id === objectId);

describe("open points workspace", () => {
  it("creates an open point by hand: origin app, always open, in open-points/", async () => {
    const { root, application } = await setup();
    const point = await application.createOpenPoint({ title: "Who owns the coupon budget?", origin: "agent-extracted", status: "resolved", resolved_at: "2026-10-01T08:00:00.000Z", importance: "High" });
    expect(point.relativePath).toMatch(/^open-points\/.*who-owns-the-coupon-budget--/);
    expect(point.frontmatter).toMatchObject({ type: "open-point", origin: "app", status: "open", importance: "High" });
    expect(point.frontmatter.resolved_at).toBeUndefined();
    expect(await audited(application, "open-point.created", point.frontmatter.id)).toBe(true);
    await expect(application.createOpenPoint({ title: " " })).rejects.toThrow(/Title is required/);
    await expect(application.createOpenPoint({ title: "Bad link", primary_project_id: "not-an-id" })).rejects.toThrow();
    expect(await filesIn(root, "open-points")).toBe(1);
  });

  it("edits through a guarded save, keeps origin, and refuses status changes outside Resolve and Close", async () => {
    const { application } = await setup({ "open-points/p.md": `---\nid: ${ids.point}\ntype: open-point\nschema_version: 1\nrevision: 1\ntitle: From meeting\n${stamp}\norigin: agent-extracted\nstatus: open\n---\n# From meeting\n` });
    const current = application.object(ids.point);
    const edited = await application.updateOpenPoint(ids.point, { title: "Clarified question", origin: "app", importance: "Low" }, current.contentHash);
    expect(edited.frontmatter).toMatchObject({ title: "Clarified question", origin: "agent-extracted", importance: "Low", revision: 2 });
    await expect(application.updateOpenPoint(ids.point, { title: "Stale" }, current.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    await expect(application.updateOpenPoint(ids.point, { title: "No hash" }, "")).rejects.toThrow(/expectedHash/);
    await expect(application.updateOpenPoint(ids.point, { title: "" }, edited.contentHash)).rejects.toThrow(/Title is required/);
    await expect(application.updateOpenPoint(ids.point, { status: "closed" }, edited.contentHash)).rejects.toThrow(/Resolve or Close/);
    expect(application.object(ids.point).frontmatter.revision).toBe(2);
  });

  it("resolves with a summary, sets resolved_at, and makes the resolution final", async () => {
    const { application } = await setup();
    const point = await application.createOpenPoint({ title: "Which stores pilot?" });
    await expect(application.resolveOpenPoint(point.frontmatter.id, {}, point.contentHash)).rejects.toThrow(/resolution_summary or resolution_decision_id/);
    await expect(application.resolveOpenPoint(point.frontmatter.id, { resolution_summary: "   " }, point.contentHash)).rejects.toThrow(/resolution_summary or resolution_decision_id/);
    await expect(application.resolveOpenPoint(point.frontmatter.id, { resolution_summary: "Lyon" }, "")).rejects.toThrow(/expectedHash/);
    const resolved = await application.resolveOpenPoint(point.frontmatter.id, { resolution_summary: "  Lyon and Paris  " }, point.contentHash);
    expect(resolved.frontmatter).toMatchObject({ status: "resolved", resolution_summary: "Lyon and Paris", revision: 2 });
    expect(Date.parse(String(resolved.frontmatter.resolved_at))).not.toBeNaN();
    expect(resolved.frontmatter.closed_at).toBeUndefined();
    expect(await audited(application, "open-point.resolved", point.frontmatter.id)).toBe(true);

    await expect(application.closeOpenPoint(point.frontmatter.id, {}, resolved.contentHash)).rejects.toThrow(/Only open points/);
    await expect(application.resolveOpenPoint(point.frontmatter.id, { resolution_summary: "Again" }, resolved.contentHash)).rejects.toThrow(/Only open points/);
    // The summary can still be reworded, but not removed when it is the only resolution.
    const reworded = await application.updateOpenPoint(point.frontmatter.id, { resolution_summary: "Lyon, then Paris" }, resolved.contentHash);
    expect(reworded.frontmatter.resolution_summary).toBe("Lyon, then Paris");
    await expect(application.updateOpenPoint(point.frontmatter.id, { resolution_summary: "" }, reworded.contentHash)).rejects.toThrow(/resolution_summary or resolution_decision_id/);
  });

  it("resolves by linking an existing decision, which must be a real decision", async () => {
    const { application } = await setup();
    const decision = await application.createDecision({ title: "Pilot in Lyon" });
    const other = await application.createOpenPoint({ title: "Not a decision" });
    const point = await application.createOpenPoint({ title: "Where to pilot?" });
    await expect(application.resolveOpenPoint(point.frontmatter.id, { resolution_decision_id: other.frontmatter.id }, point.contentHash)).rejects.toThrow(/existing decision/);
    await expect(application.resolveOpenPoint(point.frontmatter.id, { resolution_decision_id: "01995d60-7baf-7c21-9c96-9c5d2f6a33ff" }, point.contentHash)).rejects.toThrow(/existing decision/);
    const resolved = await application.resolveOpenPoint(point.frontmatter.id, { resolution_decision_id: decision.frontmatter.id }, point.contentHash);
    expect(resolved.frontmatter).toMatchObject({ status: "resolved", resolution_decision_id: decision.frontmatter.id });
    expect(application.openPoint(point.frontmatter.id).resolutionDecision?.frontmatter.id).toBe(decision.frontmatter.id);
    expect(application.decision(decision.frontmatter.id).resolvesOpenPoints.map((object) => object.frontmatter.id)).toEqual([point.frontmatter.id]);
  });

  it("closes with an optional reason and sets closed_at", async () => {
    const { application } = await setup();
    const a = await application.createOpenPoint({ title: "Old question" });
    const b = await application.createOpenPoint({ title: "Another old question" });
    const closed = await application.closeOpenPoint(a.frontmatter.id, { reason: "Project cancelled" }, a.contentHash);
    expect(closed.frontmatter).toMatchObject({ status: "closed", close_reason: "Project cancelled" });
    expect(Date.parse(String(closed.frontmatter.closed_at))).not.toBeNaN();
    expect(closed.frontmatter.resolved_at).toBeUndefined();
    const silent = await application.closeOpenPoint(b.frontmatter.id, { reason: "  " }, b.contentHash);
    expect(silent.frontmatter.status).toBe("closed");
    expect(silent.frontmatter.close_reason).toBeUndefined();
    expect(await audited(application, "open-point.closed", a.frontmatter.id)).toBe(true);
    await expect(application.closeOpenPoint(a.frontmatter.id, {}, closed.contentHash)).rejects.toThrow(/Only open points/);
    await expect(application.closeOpenPoint(b.frontmatter.id, {}, b.contentHash)).rejects.toThrow(/Only open points|changed/);
  });

  it("resolves with a new decision that inherits the open point's context, as one operation", async () => {
    const { root, application } = await setup();
    const project = await application.createEntity("project", { title: "Pilot" });
    const person = await application.createEntity("person", { title: "Ada Lovelace" });
    const point = await application.createOpenPoint({ title: "Which loyalty tier?", primary_project_id: project.frontmatter.id, people_ids: [person.frontmatter.id] });
    const { decision, openPoint } = await application.resolveOpenPointWithDecision(point.frontmatter.id, { title: "Gold tier only", rationale: "Smaller pilot" }, point.contentHash);
    expect(decision.frontmatter).toMatchObject({ type: "decision", status: "active", origin: "app", title: "Gold tier only", rationale: "Smaller pilot", primary_project_id: project.frontmatter.id, people_ids: [person.frontmatter.id] });
    expect(openPoint.frontmatter).toMatchObject({ status: "resolved", resolution_decision_id: decision.frontmatter.id });
    expect(application.openPoint(point.frontmatter.id).resolutionDecision?.frontmatter.id).toBe(decision.frontmatter.id);
    expect(await filesIn(root, "decisions")).toBe(1);
    expect(await audited(application, "decision.created", decision.frontmatter.id)).toBe(true);
    expect(await audited(application, "open-point.resolved", point.frontmatter.id)).toBe(true);

    // The title defaults to the open point's; already-resolved points are refused.
    const second = await application.createOpenPoint({ title: "Launch date?" });
    expect((await application.resolveOpenPointWithDecision(second.frontmatter.id, {}, second.contentHash)).decision.frontmatter.title).toBe("Launch date?");
    await expect(application.resolveOpenPointWithDecision(point.frontmatter.id, { title: "Again" }, openPoint.contentHash)).rejects.toThrow(/Only open points/);
    expect(await filesIn(root, "decisions")).toBe(2);
  });

  it("writes nothing when resolve-with-decision is stale or the decision is invalid", async () => {
    const { root, application } = await setup();
    const point = await application.createOpenPoint({ title: "Budget?" });
    const edited = await application.updateOpenPoint(point.frontmatter.id, { importance: "High" }, point.contentHash);
    await expect(application.resolveOpenPointWithDecision(point.frontmatter.id, { title: "10k" }, point.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    await expect(application.resolveOpenPointWithDecision(point.frontmatter.id, { title: "10k", decided_at: "soon" }, edited.contentHash)).rejects.toThrow();
    expect(await filesIn(root, "decisions")).toBe(0);
    expect(application.object(point.frontmatter.id).frontmatter.status).toBe("open");
    expect(await application.recoverOperations()).toHaveLength(0);
  });

  it("finishes a resolve-with-decision interrupted between its two writes through operation recovery", async () => {
    let failDecision = true;
    class CrashingStore extends MarkdownObjectStore {
      override async write(input: Parameters<MarkdownObjectStore["write"]>[0]) {
        if (failDecision && input.frontmatter.type === "decision") { failDecision = false; throw new Error("disk full"); }
        return super.write(input);
      }
    }
    const { root, application } = await setup({}, (directory) => new CrashingStore(directory));
    const point = await application.createOpenPoint({ title: "Vendor?" });
    await expect(application.resolveOpenPointWithDecision(point.frontmatter.id, { title: "Use vendor A" }, point.contentHash)).rejects.toThrow(/disk full/);
    // The guarded write landed on disk; only the decision is missing.
    await application.rebuildIndex();
    expect(application.object(point.frontmatter.id).frontmatter).toMatchObject({ status: "resolved" });
    expect(await filesIn(root, "decisions")).toBe(0);

    expect(await application.recoverOperations()).toHaveLength(1);
    expect(await application.recoverOperations()).toHaveLength(0);
    const detail = application.openPoint(point.frontmatter.id);
    expect(detail.resolutionDecision?.frontmatter).toMatchObject({ title: "Use vendor A", status: "active" });
    expect(detail.openPoint.frontmatter.resolution_decision_id).toBe(detail.resolutionDecision?.frontmatter.id);
    expect(await filesIn(root, "decisions")).toBe(1);
  });

  it("filters the list by project, client, product, person, status and date range, newest first", async () => {
    const { application } = await setup({
      "open-points/a.md": `---\nid: ${ids.point}\ntype: open-point\nschema_version: 1\nrevision: 1\ntitle: A\ncreated_at: 2026-09-01T09:00:00Z\nupdated_at: 2026-09-01T09:00:00Z\nupdated_by_device: test\nstatus: open\n---\n`
    });
    const client = await application.createEntity("client", { title: "Carrefour" });
    const product = await application.createEntity("product", { title: "Loyalty" });
    const project = await application.createEntity("project", { title: "Pilot" });
    const person = await application.createEntity("person", { title: "Ada Lovelace" });
    const owner = await application.createEntity("person", { title: "Grace Hopper" });
    const a = application.object(ids.point);
    await application.updateOpenPoint(ids.point, { primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id }, a.contentHash);
    const b = await application.createOpenPoint({ title: "B", raised_at: "2026-09-15T09:00:00.000Z", primary_product_id: product.frontmatter.id, people_ids: [person.frontmatter.id], owner_person_id: owner.frontmatter.id });
    const c = await application.createOpenPoint({ title: "C", raised_at: "2026-09-30T09:00:00.000Z", primary_client_id: client.frontmatter.id });
    await application.closeOpenPoint(c.frontmatter.id, {}, c.contentHash);
    const titles = (filters: Parameters<LifeOSApplication["openPoints"]>[0] = {}) => application.openPoints(filters).map((point) => point.frontmatter.title);

    expect(b.frontmatter.raised_at).toBe("2026-09-15T09:00:00.000Z");
    expect(titles()).toEqual(["C", "B", "A"]);
    expect(titles({ projectId: project.frontmatter.id })).toEqual(["A"]);
    expect(titles({ clientId: client.frontmatter.id })).toEqual(["C", "A"]);
    expect(titles({ productId: product.frontmatter.id })).toEqual(["B"]);
    expect(titles({ personId: person.frontmatter.id })).toEqual(["B"]);
    expect(titles({ personId: owner.frontmatter.id })).toEqual(["B"]);
    expect(titles({ status: "open" })).toEqual(["B", "A"]);
    expect(titles({ status: "closed" })).toEqual(["C"]);
    expect(titles({ from: "2026-09-15T09:00:00.000Z" })).toEqual(["C", "B"]);
    expect(titles({ to: "2026-09-15T09:00:00.000Z" })).toEqual(["B", "A"]);
    expect(titles({ from: "2026-09-10T00:00:00.000Z", to: "2026-09-20T00:00:00.000Z" })).toEqual(["B"]);
    expect(() => application.openPoints({ status: "active" })).toThrow(/status/);
    expect(() => application.openPoints({ from: "not a date" })).toThrow(/date/);
    expect(() => application.openPoints({ from: "2026-09-20T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" })).toThrow(/date/);
  });

  it("detail shows the source meeting, sources and evidence, and the person filter follows meeting attendees", async () => {
    const { application } = await setup({
      "people/ada.md": `---\nid: ${ids.person}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: Ada\n${stamp}\ngiven_name: Ada\n---\n`,
      "meetings/m.md": `---\nid: ${ids.meeting}\ntype: meeting\nschema_version: 1\nrevision: 1\ntitle: Weekly review\n${stamp}\nstatus: scheduled\nstarts_at: 2026-10-01T08:00:00Z\nends_at: 2026-10-01T09:00:00Z\ntimezone: Europe/Paris\nattendee_ids: [${ids.person}]\n---\n`,
      "sources/s.md": `---\nid: ${ids.source}\ntype: source\nschema_version: 1\nrevision: 1\ntitle: Transcript\n${stamp}\nsource_type: meet-transcript\ncaptured_at: 2026-10-01T09:00:00Z\ningestion_status: processed\nfragments: [{id: f1, text: "Nobody knows who signs off", locator: {timestamp: "00:20:00"}}]\n---\n`,
      "open-points/p.md": `---\nid: ${ids.point}\ntype: open-point\nschema_version: 1\nrevision: 1\ntitle: Who signs off?\n${stamp}\norigin: agent-extracted\nstatus: open\nsource_meeting_id: ${ids.meeting}\nsource_ids: [${ids.source}]\n---\n`,
      "review-items/r.md": `---\nid: ${ids.review}\ntype: review-item\nschema_version: 1\nrevision: 2\ntitle: Who signs off?\n${stamp}\nreview_type: create\ntarget_object_type: open-point\nproposed_fields: {title: Who signs off?}\nfield_evidence: {title: [{source_id: ${ids.source}, fragment_id: f1}]}\nconfidence_label: Medium\nstatus: accepted\nresolved_object_id: ${ids.point}\noperation_id: ${ids.operation}\n---\n`
    });
    const detail = application.openPoint(ids.point);
    expect(detail.meeting?.frontmatter.id).toBe(ids.meeting);
    expect(detail.sources.map((source) => source.frontmatter.id)).toEqual([ids.source]);
    expect(detail.people.map((person) => person.frontmatter.id)).toEqual([ids.person]);
    expect(detail.evidence).toEqual([{ field: "title", sourceId: ids.source, sourceTitle: "Transcript", fragmentId: "f1", text: "Nobody knows who signs off", locator: { timestamp: "00:20:00" } }]);
    expect(detail.review?.frontmatter.id).toBe(ids.review);
    expect(application.openPoints({ personId: ids.person }).map((point) => point.frontmatter.id)).toEqual([ids.point]);
    expect(() => application.openPoint(ids.meeting)).toThrow(/not found/);
  });

  it("keeps open points, resolved and closed ones included, in project, client, product and person roll-ups", async () => {
    const { application } = await setup();
    const client = await application.createEntity("client", { title: "Client" });
    const product = await application.createEntity("product", { title: "Product" });
    const project = await application.createEntity("project", { title: "Project" });
    const person = await application.createEntity("person", { title: "Grace Hopper" });
    const context = { primary_project_id: project.frontmatter.id, primary_client_id: client.frontmatter.id, primary_product_id: product.frontmatter.id, people_ids: [person.frontmatter.id] };
    const open = await application.createOpenPoint({ title: "Open", ...context });
    const toResolve = await application.createOpenPoint({ title: "Resolved", ...context });
    const toClose = await application.createOpenPoint({ title: "Closed", ...context });
    await application.resolveOpenPoint(toResolve.frontmatter.id, { resolution_summary: "Done" }, toResolve.contentHash);
    await application.closeOpenPoint(toClose.frontmatter.id, {}, toClose.contentHash);
    const expected = [open.frontmatter.id, toResolve.frontmatter.id, toClose.frontmatter.id].sort();
    const pointIds = (objects: Array<{ frontmatter: { type: string; id: string } }>) => objects.filter((object) => object.frontmatter.type === "open-point").map((object) => object.frontmatter.id).sort();

    expect(pointIds(application.projects().find((rollup) => rollup.project.frontmatter.id === project.frontmatter.id)!.openPoints)).toEqual(expected);
    for (const [type, entity] of [["client", client], ["product", product], ["person", person]] as const) {
      expect(pointIds(application.rollups(type).find((rollup) => rollup.entity.frontmatter.id === entity.frontmatter.id)!.related)).toEqual(expected);
    }
  });

  it("enforces the open-point lifecycle in the domain", () => {
    const base = { id: ids.point, type: "open-point", schema_version: 1, revision: 1, title: "P", created_at: "2026-10-01T08:00:00Z", updated_at: "2026-10-01T08:00:00Z", updated_by_device: "d" };
    const at = "2026-10-02T08:00:00Z";
    expect(() => validateFrontmatter({ ...base, status: "open" })).not.toThrow();
    expect(() => validateFrontmatter({ ...base, status: "resolved", resolved_at: at })).toThrow(/resolution_summary or resolution_decision_id/);
    expect(() => validateFrontmatter({ ...base, status: "resolved", resolution_summary: "Yes" })).toThrow(/resolved_at is required/);
    expect(() => validateFrontmatter({ ...base, status: "resolved", resolved_at: at, resolution_summary: "Yes" })).not.toThrow();
    expect(() => validateFrontmatter({ ...base, status: "resolved", resolved_at: at, resolution_decision_id: ids.review })).not.toThrow();
    expect(() => validateFrontmatter({ ...base, status: "open", resolved_at: at })).toThrow(/resolved_at is allowed only/);
    expect(() => validateFrontmatter({ ...base, status: "closed" })).toThrow(/closed_at is required/);
    expect(() => validateFrontmatter({ ...base, status: "closed", closed_at: at })).not.toThrow();
    expect(() => validateFrontmatter({ ...base, status: "open", closed_at: at })).toThrow(/closed_at is allowed only/);
    expect(() => validateFrontmatter({ ...base, status: "closed", closed_at: at, resolution_summary: "x" })).toThrow(/only for resolved/);
    expect(() => validateFrontmatter({ ...base, status: "open", close_reason: "x" })).toThrow(/only for closed/);

    const resolved = { ...base, status: "resolved", resolved_at: at, resolution_summary: "Yes" };
    expect(lifecycleWriteProblem(resolved)).toMatch(/must be open/);
    expect(lifecycleWriteProblem({ ...base, status: "open" })).toBeUndefined();
    expect(lifecycleWriteProblem(resolved, { ...base, status: "open" })).toBeUndefined();
    expect(lifecycleWriteProblem({ ...base, status: "open" }, resolved)).toMatch(/final/);
    expect(lifecycleWriteProblem({ ...resolved, resolved_at: "2026-10-03T08:00:00Z" }, resolved)).toMatch(/resolved_at/);
    expect(lifecycleWriteProblem({ ...resolved, resolution_decision_id: ids.review }, resolved)).toMatch(/resolution_decision_id/);
    expect(lifecycleWriteProblem({ ...resolved, resolution_summary: "Reworded" }, resolved)).toBeUndefined();
  });
});
