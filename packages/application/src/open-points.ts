import { openPointStatuses, uuidV7, type LifeOSObject, type ObjectEnvelope, type OpenPointStatus } from "@lifeos/domain";
import { markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { decisionPeopleIds, reviewEvidence, type DecisionFilters, type DecisionsModule, type PreparedDecision } from "./decisions.js";
import { operationKinds, type Operation } from "./ports.js";
import { contextLinkFields, isLive, stringsIn } from "./support.js";

/** Same filters as Decisions (#41); `from`/`to` apply to `raised_at` (falling back to `created_at` for older files). */
export type OpenPointFilters = DecisionFilters;

/** Fields a person may set by hand on create. Status and resolution move only through Resolve and Close; `origin` is never accepted (#30). */
const fields = ["title", "importance", "owner_person_id", "due_on", "raised_at", ...contextLinkFields, "people_ids", "source_meeting_id", "source_ids", "area", "sensitivity"];
/** After resolving or closing, the wording of the outcome stays editable; the schema refuses it on the wrong status. */
const editable = [...fields, "status", "resolution_summary", "close_reason"];
/** Context a decision created by "Resolve with decision" inherits from the open point, unless the user overrides it. */
const inherited = [...contextLinkFields, "people_ids", "area", "sensitivity"];

const trimmed = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const raisedAt = (object: LifeOSObject) => String(object.frontmatter.raised_at ?? object.frontmatter.created_at);

/** People an open point concerns: as for decisions (linked people, source meeting attendees), plus its owner. */
export function openPointPeopleIds(ctx: AppContext, point: LifeOSObject) {
  const owner = typeof point.frontmatter.owner_person_id === "string" ? [point.frontmatter.owner_person_id] : [];
  return [...new Set([...decisionPeopleIds(ctx, point), ...owner])];
}

/**
 * Open Points workspace (#42): filtered list, detail read model, manual create/edit, Resolve (with a
 * summary or an existing decision), Resolve with a new decision (one recoverable operation) and Close.
 */
export class OpenPointsModule {
  constructor(private readonly ctx: AppContext, private readonly decisions: DecisionsModule) {}

  openPoints(filters: OpenPointFilters = {}) {
    if (filters.status && !openPointStatuses.includes(filters.status as OpenPointStatus)) throw new Error(`Open point status must be one of ${openPointStatuses.join(", ")}`);
    const from = filters.from ? Date.parse(filters.from) : -Infinity;
    const to = filters.to ? Date.parse(filters.to) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error("Enter a valid date range");
    const matches = (object: LifeOSObject) => {
      const value = object.frontmatter;
      const raised = Date.parse(raisedAt(object));
      return (!filters.projectId || value.primary_project_id === filters.projectId)
        && (!filters.clientId || value.primary_client_id === filters.clientId)
        && (!filters.productId || value.primary_product_id === filters.productId)
        && (!filters.status || value.status === filters.status)
        && (!filters.personId || openPointPeopleIds(this.ctx, object).includes(filters.personId))
        && raised >= from && raised <= to;
    };
    return this.all().filter(matches).sort((a, b) => raisedAt(b).localeCompare(raisedAt(a)) || String(b.frontmatter.created_at).localeCompare(String(a.frontmatter.created_at)));
  }

  /** Detail read model: the open point with its context, owner, source meeting, sources, evidence and resolving decision. */
  openPoint(id: string) {
    const { index } = this.ctx;
    const openPoint = this.ctx.required(id, "open-point");
    const value = openPoint.frontmatter;
    const get = (key: string) => typeof value[key] === "string" ? index.get(value[key] as string) : undefined;
    const objects = (list: string[]) => list.map((item) => index.get(item)).filter((object): object is LifeOSObject => Boolean(object));
    return {
      openPoint,
      resolutionDecision: get("resolution_decision_id"),
      meeting: get("source_meeting_id"),
      sources: objects(stringsIn(value.source_ids)),
      people: objects(openPointPeopleIds(this.ctx, openPoint)),
      owner: get("owner_person_id"),
      project: get("primary_project_id"),
      client: get("primary_client_id"),
      product: get("primary_product_id"),
      ...reviewEvidence(this.ctx, id)
    };
  }

  /** Manual create: always `origin: app` and `open`, whatever the caller sends. */
  async createOpenPoint(input: Record<string, unknown>) {
    const title = trimmed(input.title);
    if (!title) throw new Error("Title is required");
    const now = new Date().toISOString();
    const id = uuidV7();
    const chosen = this.pick(input, fields);
    const frontmatter = { ...chosen, ...this.ctx.envelope(id, "open-point", title, now, "app"), status: "open", raised_at: chosen.raised_at ?? now } as ObjectEnvelope;
    const created = await this.ctx.objects.write({ relativePath: `open-points/${markdownFileName(title, id, now)}`, frontmatter, body: `# ${title}\n` });
    await this.ctx.writeAudit("open-point.created", id, now, {});
    await this.ctx.rebuildIndex();
    return created;
  }

  async updateOpenPoint(id: string, input: Record<string, unknown>, expectedHash: string) {
    if (!expectedHash) throw new Error("expectedHash is required to edit an open point");
    const current = this.ctx.required(id, "open-point");
    const changes = this.pick(input, editable);
    if ("title" in changes && !trimmed(changes.title)) throw new Error("Title is required");
    if ("status" in changes && changes.status !== current.frontmatter.status) throw new Error("Use Resolve or Close to change an open point's status");
    for (const key of ["resolution_summary", "close_reason"]) if (key in changes) changes[key] = trimmed(changes[key]);
    if (current.frontmatter.status === "resolved" && "resolution_summary" in changes && !changes.resolution_summary && !current.frontmatter.resolution_decision_id) throw new Error("A resolved open point needs a resolution_summary or resolution_decision_id");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, changes, { expectedHash, now });
    await this.ctx.writeAudit("open-point.updated", id, now, { fields: Object.keys(changes) });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /** `open` → `resolved` with a summary, a link to an existing decision, or both. */
  async resolveOpenPoint(id: string, input: { resolution_summary?: unknown; resolution_decision_id?: unknown }, expectedHash: string) {
    if (!expectedHash) throw new Error("expectedHash is required to resolve an open point");
    const current = this.open(id, "resolved");
    const summary = trimmed(input.resolution_summary);
    const decisionId = trimmed(input.resolution_decision_id);
    if (!summary && !decisionId) throw new Error("Resolving needs a resolution_summary or resolution_decision_id");
    if (decisionId) {
      const decision = this.ctx.index.get(decisionId);
      if (!decision || decision.frontmatter.type !== "decision" || decision.frontmatter.deleted_at) throw new Error("Choose an existing decision to link");
    }
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, { status: "resolved", resolved_at: now, resolution_summary: summary, resolution_decision_id: decisionId }, { expectedHash, now });
    await this.ctx.writeAudit("open-point.resolved", id, now, decisionId ? { resolution_decision_id: decisionId } : {});
    await this.ctx.rebuildIndex();
    return updated;
  }

  /** `open` → `closed`: no longer relevant. The reason is optional; a blank one is not stored. */
  async closeOpenPoint(id: string, input: { reason?: unknown }, expectedHash: string) {
    if (!expectedHash) throw new Error("expectedHash is required to close an open point");
    const current = this.open(id, "closed");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, { status: "closed", closed_at: now, close_reason: trimmed(input.reason) }, { expectedHash, now });
    await this.ctx.writeAudit("open-point.closed", id, now, {});
    await this.ctx.rebuildIndex();
    return updated;
  }

  /**
   * "Resolve with decision": one recoverable operation, like Supersede. The new decision is built and
   * validated first; then the guarded write resolves the open point (a stale hash writes nothing), and
   * the decision follows. A crash between the two is finished by recovery.
   */
  async resolveOpenPointWithDecision(id: string, input: Record<string, unknown>, expectedHash: string) {
    if (!expectedHash) throw new Error("expectedHash is required to resolve an open point");
    const point = this.open(id, "resolved");
    if (point.contentHash !== expectedHash) throw new ObjectConflictError(`Open point changed since it was opened: ${point.relativePath}`);
    const now = new Date().toISOString();
    const defaults = Object.fromEntries(inherited.filter((key) => point.frontmatter[key] !== undefined).map((key) => [key, point.frontmatter[key]]));
    const prepared = this.decisions.prepare({ ...input, title: trimmed(input.title) ?? point.frontmatter.title }, defaults, now);
    const operationId = uuidV7();
    await this.ctx.objects.prepareOperation?.(operationKinds.resolveOpenPoint, { openPointId: id, decision: prepared }, operationId);
    return this.finishResolve(operationId, id, prepared, expectedHash, now);
  }

  /** Crash recovery for an incomplete `resolve-open-point` operation. */
  async recoverResolve(operation: Operation) {
    await this.ctx.rebuildIndex();
    const { openPointId, decision } = operation.payload as { openPointId: string; decision: PreparedDecision };
    const point = this.ctx.index.get(openPointId);
    // The open point moved on some other way: nothing safe to finish, so close the operation.
    if (!point || (point.frontmatter.status !== "open" && point.frontmatter.resolution_decision_id !== decision.frontmatter.id)) {
      await this.ctx.objects.completeOperation?.(operation.id);
      return undefined;
    }
    return this.finishResolve(operation.id, openPointId, decision, point.contentHash, new Date().toISOString());
  }

  private async finishResolve(operationId: string, pointId: string, prepared: PreparedDecision, expectedHash: string, now: string) {
    const decisionId = prepared.frontmatter.id;
    let openPoint = this.ctx.required(pointId, "open-point");
    if (openPoint.frontmatter.status === "open") {
      try {
        openPoint = await this.ctx.update(openPoint, { status: "resolved", resolved_at: now, resolution_decision_id: decisionId }, { expectedHash, now });
      } catch (error) {
        // Nothing was written: drop the operation so recovery cannot replay it without the user's guard.
        await this.ctx.objects.completeOperation?.(operationId);
        throw error;
      }
    }
    const decision = await this.decisions.writePrepared(prepared, now, { resolves_open_point_id: pointId });
    await this.ctx.writeAuditOnce("open-point.resolved", pointId, now, { operation_id: operationId, resolution_decision_id: decisionId }, { matchOn: ["operation_id"] });
    await this.ctx.objects.completeOperation?.(operationId);
    await this.ctx.rebuildIndex();
    return { decision, openPoint };
  }

  private open(id: string, target: "resolved" | "closed") {
    const current = this.ctx.required(id, "open-point");
    if (current.frontmatter.status !== "open") throw new Error(`Only open points can be ${target}; this one is ${String(current.frontmatter.status)}`);
    return current;
  }

  private all() {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "open-point" && isLive(object));
  }

  private pick(input: Record<string, unknown>, allowed: string[]) {
    // An empty picker clears the link rather than storing "".
    return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, value === "" || value === null ? undefined : value]));
  }
}
