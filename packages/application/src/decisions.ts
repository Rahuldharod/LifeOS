import { decisionStatuses, uuidV7, validateFrontmatter, type DecisionStatus, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { operationKinds, type Operation } from "./ports.js";
import { contextLinkFields, stringsIn } from "./support.js";

/** List filters (#41). `from`/`to` are ISO instants, inclusive, on `decided_at`; the UI turns local days into instants. */
export type DecisionFilters = { projectId?: string; clientId?: string; productId?: string; personId?: string; status?: string; from?: string; to?: string };
export type DecisionEvidence = { field: string; sourceId: string; sourceTitle?: string; fragmentId: string; text?: string; locator?: unknown };
export type PreparedDecision = { relativePath: string; frontmatter: ObjectEnvelope; body: string };
/** Other changes written to the old decision with the supersede (an update Review Item's other fields and note). */
export type SupersededWrite = { changes?: Record<string, unknown>; body?: string };

/** Fields a person may set by hand. `status` is edit-only (to `reversed`); `origin` is never accepted (#30). */
export const decisionFields = ["title", "decision_text", "rationale", "decided_at", ...contextLinkFields, "people_ids", "source_meeting_id", "source_ids", "area", "sensitivity"];
/** Context a successor inherits from the decision it supersedes, unless the user overrides it. */
const inherited = [...contextLinkFields, "people_ids", "area", "sensitivity"];


/** Why `successor` cannot replace decision `oldId` now (#67); `undefined` when it can. */
function successorProblem(oldId: string, successorId: string, successor: LifeOSObject | undefined) {
  if (successorId === oldId) return "A decision cannot supersede itself";
  if (!successor || successor.frontmatter.type !== "decision") return `The replacing decision ${successorId} no longer exists; nothing was changed`;
  const name = `"${successor.frontmatter.title}"`;
  if (successor.frontmatter.deleted_at) return `The replacing decision ${name} was deleted; nothing was changed`;
  if (successor.frontmatter.archived_at) return `The replacing decision ${name} was archived; nothing was changed`;
  if (successor.frontmatter.status !== "active") return `The replacing decision ${name} is ${String(successor.frontmatter.status)}; only an active decision can replace another. Nothing was changed`;
  if (successor.frontmatter.supersedes_decision_id !== undefined && successor.frontmatter.supersedes_decision_id !== oldId) return `The replacing decision ${name} already replaces another decision; nothing was changed`;
  return undefined;
}

/** People a decision concerns: those linked directly, plus the attendees of its source meeting. Shared with roll-ups. */
export function decisionPeopleIds(ctx: AppContext, decision: LifeOSObject) {
  const meeting = typeof decision.frontmatter.source_meeting_id === "string" ? ctx.index.get(decision.frontmatter.source_meeting_id) : undefined;
  return [...new Set([...stringsIn(decision.frontmatter.people_ids), ...stringsIn(meeting?.frontmatter.attendee_ids)])];
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
      sources: objects(stringsIn(value.source_ids)),
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
    const changes = this.pick(input, [...decisionFields, "status"]);
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
    const old = this.supersedable(id, expectedHash);
    const now = new Date().toISOString();
    const defaults = Object.fromEntries(inherited.filter((key) => old.frontmatter[key] !== undefined).map((key) => [key, old.frontmatter[key]]));
    const prepared = this.prepare(input, { ...defaults, supersedes_decision_id: id }, now);
    const operationId = uuidV7();
    // #70: the old decision's hash at prepare time, so recovery never writes over a later edit.
    await this.ctx.objects.prepareOperation?.(operationKinds.supersedeDecision, { oldId: id, baseHash: expectedHash, decision: prepared }, operationId);
    return this.finishSupersede(operationId, id, { decision: prepared }, expectedHash, now);
  }

  /**
   * #67: supersede with a decision that already exists (an accepted update Review Item), through the same
   * recoverable operation. Both links are set: the old decision first (guarded, with any other proposed
   * `changes` and `body`), then the successor's `supersedes_decision_id`. The successor is checked first, so a
   * deleted, archived or no-longer-active one writes nothing. Idempotent once both links are in place.
   */
  async supersedeWith(id: string, successorId: string, expectedHash: string, old: SupersededWrite = {}) {
    const current = this.ctx.required(id, "decision");
    const successor = this.ctx.index.get(successorId);
    const linked = current.frontmatter.superseded_by_decision_id === successorId;
    if (linked && successor?.frontmatter.supersedes_decision_id === id) return { decision: successor, superseded: current };
    if (!linked) this.supersedable(id, expectedHash);
    const problem = successorProblem(id, successorId, successor);
    // #70: the old decision already points at a successor that can no longer take the link (e.g. deleted after a crash).
    if (problem && linked) throw new Error(`"${current.frontmatter.title}" was already marked as replaced by ${successorId}, but ${problem.replace(/; nothing was changed$|\. Nothing was changed$/, "").replace(/^The replacing decision/, "that decision")}. Reject this review item; the decision cannot be un-superseded`);
    if (problem) throw new Error(problem);
    const now = new Date().toISOString();
    const operationId = uuidV7();
    await this.ctx.objects.prepareOperation?.(operationKinds.supersedeDecision, { oldId: id, baseHash: expectedHash, successorId, ...old }, operationId);
    return this.finishSupersede(operationId, id, { successorId, ...old }, expectedHash, now);
  }

  /** The old decision, if it may be superseded with this hash; throws the reason otherwise. */
  private supersedable(id: string, expectedHash: string) {
    const old = this.ctx.required(id, "decision");
    if (old.frontmatter.status === "superseded") throw new Error(`This decision is already superseded${typeof old.frontmatter.superseded_by_decision_id === "string" ? ` by ${old.frontmatter.superseded_by_decision_id}` : ""}`);
    if (old.frontmatter.status !== "active") throw new Error(`Only active decisions can be superseded; this one is ${String(old.frontmatter.status)}`);
    if (old.contentHash !== expectedHash) throw new ObjectConflictError(`Decision changed since it was opened: ${old.relativePath}`);
    return old;
  }

  /**
   * Crash recovery for an incomplete `supersede-decision` operation (a new successor, or an existing one, #67).
   * #70: the old decision is written only if its hash still matches the one recorded at prepare time, and an
   * existing successor is linked back only while it is still a valid one. Otherwise nothing is written: the
   * operation is closed and audited, and an update Review Item stays pending, so accepting it reports the
   * conflict and rejecting it resolves it.
   */
  async recoverSupersede(operation: Operation) {
    await this.ctx.rebuildIndex();
    const { oldId, baseHash, decision, successorId, changes, body } = operation.payload as { oldId: string; baseHash?: string; decision?: PreparedDecision; successorId?: string } & SupersededWrite;
    const newId = successorId ?? decision!.frontmatter.id;
    const old = this.ctx.index.get(oldId);
    const written = old?.frontmatter.superseded_by_decision_id === newId;
    const successor = successorId ? this.ctx.index.get(successorId) : undefined;
    const reason = !old ? "The decision to supersede no longer exists"
      : !written && old.frontmatter.status !== "active" ? `The decision is now ${String(old.frontmatter.status)}`
      // Operations prepared before #70 carry no base hash: the edit cannot be ruled out, so nothing is written.
      : !written && old.contentHash !== baseHash ? "The decision was edited after the supersede started"
      : successorId && successor?.frontmatter.supersedes_decision_id !== oldId ? successorProblem(oldId, successorId, successor)
      : undefined;
    if (reason) {
      const now = new Date().toISOString();
      await this.ctx.writeAudit("decision.supersede-abandoned", oldId, now, { operation_id: operation.id, superseded_by_decision_id: newId, reason });
      await this.ctx.objects.completeOperation?.(operation.id);
      await this.ctx.rebuildIndex();
      return undefined;
    }
    const next = successorId ? { successorId, changes, body } : { decision: decision! };
    return this.finishSupersede(operation.id, oldId, next, old!.contentHash, new Date().toISOString());
  }

  private async finishSupersede(operationId: string, oldId: string, next: { decision: PreparedDecision } | ({ successorId: string } & SupersededWrite), expectedHash: string, now: string) {
    const newId = "decision" in next ? next.decision.frontmatter.id : next.successorId;
    let old = this.ctx.required(oldId, "decision");
    if (old.frontmatter.status === "active") {
      const extra: SupersededWrite = "decision" in next ? {} : next;
      try {
        old = await this.ctx.update(old, { ...extra.changes, status: "superseded", superseded_by_decision_id: newId }, { expectedHash, now, ...(extra.body !== undefined ? { body: extra.body } : {}) });
      } catch (error) {
        // Nothing was written: drop the operation so recovery cannot replay it without the user's guard.
        await this.ctx.objects.completeOperation?.(operationId);
        throw error;
      }
    }
    const decision = "decision" in next ? this.ctx.index.get(newId) ?? await this.ctx.objects.write(next.decision) : await this.linkBack(newId, oldId, now);
    await this.ctx.writeAudit("decision.superseded", oldId, now, { superseded_by_decision_id: newId });
    await this.ctx.objects.completeOperation?.(operationId);
    await this.ctx.rebuildIndex();
    return { decision, superseded: old };
  }

  /** Points an existing successor back at the decision it replaces, unless it already does. */
  private async linkBack(successorId: string, oldId: string, now: string) {
    const successor = this.ctx.required(successorId, "decision");
    if (successor.frontmatter.supersedes_decision_id === oldId) return successor;
    return this.ctx.update(successor, { supersedes_decision_id: oldId }, { expectedHash: successor.contentHash, now });
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
    const chosen = { ...defaults, ...this.pick(input, decisionFields) };
    const text = typeof chosen.decision_text === "string" && chosen.decision_text.trim() ? chosen.decision_text.trim() : title;
    const id = uuidV7();
    const frontmatter = { ...chosen, ...this.ctx.envelope(id, "decision", title, now, "app"), status: "active", decision_text: text, decided_at: chosen.decided_at ?? now } as ObjectEnvelope;
    validateFrontmatter(frontmatter);
    return { relativePath: `decisions/${markdownFileName(title, id, now)}`, frontmatter, body: `# ${title}\n` };
  }
}
