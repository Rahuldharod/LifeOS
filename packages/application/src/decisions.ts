import { decisionStatuses, uuidV7, validateFrontmatter, type DecisionStatus, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { markdownFileName, ObjectConflictError, type AppContext } from "./context.js";

/** List filters (#41). `from`/`to` are ISO instants, inclusive, on `decided_at`; the UI turns local days into instants. */
export type DecisionFilters = { projectId?: string; clientId?: string; productId?: string; personId?: string; status?: string; from?: string; to?: string };
export type DecisionEvidence = { field: string; sourceId: string; sourceTitle?: string; fragmentId: string; text?: string; locator?: unknown };
export type PreparedDecision = { relativePath: string; frontmatter: ObjectEnvelope; body: string };

/** Fields a person may set by hand. `status` is edit-only (to `reversed`); `origin` is never accepted (#30). */
const fields = ["title", "decision_text", "rationale", "decided_at", "primary_project_id", "primary_client_id", "primary_product_id", "people_ids", "source_meeting_id", "source_ids", "area", "sensitivity"];
/** Context a successor inherits from the decision it supersedes, unless the user overrides it. */
const inherited = ["primary_project_id", "primary_client_id", "primary_product_id", "people_ids", "area", "sensitivity"];

const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** People a decision concerns: those linked directly, plus the attendees of its source meeting. Shared with roll-ups. */
export function decisionPeopleIds(ctx: AppContext, decision: LifeOSObject) {
  const meeting = typeof decision.frontmatter.source_meeting_id === "string" ? ctx.index.get(decision.frontmatter.source_meeting_id) : undefined;
  return [...new Set([...stringList(decision.frontmatter.people_ids), ...stringList(meeting?.frontmatter.attendee_ids)])];
}

/** Field evidence for an object, read from the accepted Review Item that created it. Shared with Open Points (#42). */
export function reviewEvidence(ctx: AppContext, objectId: string) {
  const { index } = ctx;
  const review = index.all().find((object) => object.frontmatter.type === "review-item" && object.frontmatter.resolved_object_id === objectId);
  const fieldEvidence = (review?.frontmatter.field_evidence ?? {}) as Record<string, Array<{ source_id: string; fragment_id: string }>>;
  const evidence: DecisionEvidence[] = Object.entries(fieldEvidence).flatMap(([field, entries]) => (Array.isArray(entries) ? entries : []).map((entry) => {
    const source = index.get(entry.source_id);
    const fragment = (source?.frontmatter.fragments as Array<{ id: string; text: string; locator?: unknown }> | undefined)?.find((candidate) => candidate.id === entry.fragment_id);
    return { field, sourceId: entry.source_id, sourceTitle: source?.frontmatter.title, fragmentId: entry.fragment_id, text: fragment?.text, locator: fragment?.locator };
  }));
  return { review, evidence };
}

/**
 * Decisions workspace (#41): filtered list, detail read model, manual create/edit and Supersede.
 * Open Points (#42, `open-points.ts`) mirror it: same filters, same detail links, their own lifecycle.
 */
export class DecisionsModule {
  constructor(private readonly ctx: AppContext) {}

  decisions(filters: DecisionFilters = {}) {
    if (filters.status && !decisionStatuses.includes(filters.status as DecisionStatus)) throw new Error(`Decision status must be one of ${decisionStatuses.join(", ")}`);
    const from = filters.from ? Date.parse(filters.from) : -Infinity;
    const to = filters.to ? Date.parse(filters.to) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error("Enter a valid date range");
    const matches = (object: LifeOSObject) => {
      const value = object.frontmatter;
      const decidedAt = Date.parse(String(value.decided_at));
      return (!filters.projectId || value.primary_project_id === filters.projectId)
        && (!filters.clientId || value.primary_client_id === filters.clientId)
        && (!filters.productId || value.primary_product_id === filters.productId)
        && (!filters.status || value.status === filters.status)
        && (!filters.personId || decisionPeopleIds(this.ctx, object).includes(filters.personId))
        && decidedAt >= from && decidedAt <= to;
    };
    return this.all().filter(matches).sort((a, b) => String(b.frontmatter.decided_at).localeCompare(String(a.frontmatter.decided_at)) || String(b.frontmatter.created_at).localeCompare(String(a.frontmatter.created_at)));
  }

  /** Detail read model: the decision with its supersede chain, context, source meeting, sources and field evidence. */
  decision(id: string) {
    const { index } = this.ctx;
    const decision = this.ctx.required(id, "decision");
    const value = decision.frontmatter;
    const get = (key: string) => typeof value[key] === "string" ? index.get(value[key] as string) : undefined;
    const supersededBy = get("superseded_by_decision_id") ?? this.all().find((other) => other.frontmatter.supersedes_decision_id === id);
    const { review, evidence } = reviewEvidence(this.ctx, id);
    const objects = (list: string[]) => list.map((item) => index.get(item)).filter((object): object is LifeOSObject => Boolean(object));
    return {
      decision,
      supersedes: get("supersedes_decision_id"),
      supersededBy,
      meeting: get("source_meeting_id"),
      sources: objects(stringList(value.source_ids)),
      people: objects(decisionPeopleIds(this.ctx, decision)),
      project: get("primary_project_id"),
      client: get("primary_client_id"),
      product: get("primary_product_id"),
      review,
      evidence,
      // #42: open points this decision resolved.
      resolvesOpenPoints: index.all().filter((object) => object.frontmatter.type === "open-point" && object.frontmatter.resolution_decision_id === id && !object.frontmatter.deleted_at)
    };
  }

  /** Manual create: always `origin: app` and `active`, whatever the caller sends. */
  async createDecision(input: Record<string, unknown>) {
    const now = new Date().toISOString();
    const created = await this.writePrepared(this.prepare(input, {}, now), now);
    await this.ctx.rebuildIndex();
    return created;
  }

  /** Writes a decision built by `prepare`, unless a retry already wrote it. Used by "Resolve with decision" (#42). */
  async writePrepared(prepared: PreparedDecision, now: string, metadata: Record<string, unknown> = {}) {
    const existing = this.ctx.index.get(prepared.frontmatter.id);
    if (existing) return existing;
    const created = await this.ctx.objects.write(prepared);
    await this.ctx.writeAudit("decision.created", created.frontmatter.id, now, metadata);
    return created;
  }

  async updateDecision(id: string, input: Record<string, unknown>, expectedHash: string) {
    if (!expectedHash) throw new Error("expectedHash is required to edit a decision");
    const current = this.ctx.required(id, "decision");
    const changes = this.pick(input, [...fields, "status"]);
    if ("title" in changes && !String(changes.title ?? "").trim()) throw new Error("Title is required");
    if (changes.status === "superseded" && current.frontmatter.status !== "superseded") throw new Error("Use Supersede to replace a decision, so the new one is linked");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(current, changes, { expectedHash, now });
    await this.ctx.writeAudit(changes.status === "reversed" && current.frontmatter.status !== "reversed" ? "decision.reversed" : "decision.updated", id, now, { fields: Object.keys(changes) });
    await this.ctx.rebuildIndex();
    return updated;
  }

  /**
   * Supersede: one recoverable operation. The guarded write on the old decision goes first, so a stale
   * hash writes nothing; the new decision follows. A crash between the two is finished by recovery.
   */
  async supersedeDecision(id: string, input: Record<string, unknown>, expectedHash: string) {
    if (!expectedHash) throw new Error("expectedHash is required to supersede a decision");
    const old = this.ctx.required(id, "decision");
    if (old.frontmatter.status === "superseded") throw new Error(`This decision is already superseded${typeof old.frontmatter.superseded_by_decision_id === "string" ? ` by ${old.frontmatter.superseded_by_decision_id}` : ""}`);
    if (old.frontmatter.status !== "active") throw new Error(`Only active decisions can be superseded; this one is ${String(old.frontmatter.status)}`);
    if (old.contentHash !== expectedHash) throw new ObjectConflictError(`Decision changed since it was opened: ${old.relativePath}`);
    const now = new Date().toISOString();
    const defaults = Object.fromEntries(inherited.filter((key) => old.frontmatter[key] !== undefined).map((key) => [key, old.frontmatter[key]]));
    const prepared = this.prepare(input, { ...defaults, supersedes_decision_id: id }, now);
    const operationId = uuidV7();
    await this.ctx.objects.prepareOperation?.("supersede-decision", { oldId: id, decision: prepared }, operationId);
    return this.finishSupersede(operationId, id, prepared, expectedHash, now);
  }

  /** Crash recovery for an incomplete `supersede-decision` operation. */
  async recoverSupersede(operation: { id: string; payload: Record<string, unknown> }) {
    await this.ctx.rebuildIndex();
    const { oldId, decision } = operation.payload as { oldId: string; decision: PreparedDecision };
    const old = this.ctx.index.get(oldId);
    // The old decision moved on some other way: nothing safe to finish, so close the operation.
    if (!old || (old.frontmatter.status !== "active" && old.frontmatter.superseded_by_decision_id !== decision.frontmatter.id)) {
      await this.ctx.objects.completeOperation?.(operation.id);
      return undefined;
    }
    return this.finishSupersede(operation.id, oldId, decision, old.contentHash, new Date().toISOString());
  }

  private async finishSupersede(operationId: string, oldId: string, prepared: PreparedDecision, expectedHash: string, now: string) {
    const newId = prepared.frontmatter.id;
    let old = this.ctx.required(oldId, "decision");
    if (old.frontmatter.status === "active") {
      try {
        old = await this.ctx.update(old, { status: "superseded", superseded_by_decision_id: newId }, { expectedHash, now });
      } catch (error) {
        // Nothing was written: drop the operation so recovery cannot replay it without the user's guard.
        await this.ctx.objects.completeOperation?.(operationId);
        throw error;
      }
    }
    const decision = this.ctx.index.get(newId) ?? await this.ctx.objects.write(prepared);
    await this.ctx.writeAudit("decision.superseded", oldId, now, { superseded_by_decision_id: newId });
    await this.ctx.objects.completeOperation?.(operationId);
    await this.ctx.rebuildIndex();
    return { decision, superseded: old };
  }

  private all() {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "decision" && !object.frontmatter.deleted_at);
  }

  private pick(input: Record<string, unknown>, allowed: string[]) {
    // An empty picker clears the link rather than storing "".
    return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, value === "" || value === null ? undefined : value]));
  }

  /** Builds and validates a new decision before anything is written, so a bad field never leaves half an operation. */
  prepare(input: Record<string, unknown>, defaults: Record<string, unknown>, now: string): PreparedDecision {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new Error("Title is required");
    const chosen = { ...defaults, ...this.pick(input, fields) };
    const text = typeof chosen.decision_text === "string" && chosen.decision_text.trim() ? chosen.decision_text.trim() : title;
    const id = uuidV7();
    const frontmatter = { ...chosen, ...this.ctx.envelope(id, "decision", title, now, "app"), status: "active", decision_text: text, decided_at: chosen.decided_at ?? now } as ObjectEnvelope;
    validateFrontmatter(frontmatter);
    return { relativePath: `decisions/${markdownFileName(title, id, now)}`, frontmatter, body: `# ${title}\n` };
  }
}
