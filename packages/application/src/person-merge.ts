import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { foldForSearch, markdownFileName, type AppContext } from "./context.js";
import { internalDomainsOf, personEmails } from "./people.js";
import { sameValue } from "./support.js";

/**
 * Person merges (#40, PRD "People → Merge"). Likely duplicates become `person-merge` Review Items;
 * nothing is ever merged without the user accepting one.
 *
 * Accepting is a recoverable multi-file operation: the whole change (every reference re-pointed, the
 * kept person's addresses and aliases, the merged person's tombstone) is planned up front as
 * before/after values and stored in the operation record. Recovery replays the plan, or rolls it back
 * when one of the files changed in between, so a crash never leaves references half moved.
 */

export const personMergeReviewType = "person-merge";
export const personMergeOperation = "merge-person";
export type PersonMergeMatch = "email" | "email-local-part" | "name";
export interface PersonMergeProposal { keep_person_id: string; merge_person_id: string; match: PersonMergeMatch; keep_title: string; merge_title: string }

/** One file's change. `null` means "field absent"; `$body` stands for the Markdown body. */
interface PlanEntry { id: string; before: Record<string, unknown>; after: Record<string, unknown> }
const bodyKey = "$body";
/** History and proposals keep pointing at what they described; only live references move. */
const untouchedTypes = new Set(["audit-event", "agent-run", "review-item"]);
/** Fields copied from the merged person only when the kept one has none. */
const fillFields = ["family_name", "organization_name", "job_title", "timezone"];

const valueOf = (object: LifeOSObject, key: string) => key === bodyKey ? object.body : object.frontmatter[key] ?? null;
const isAt = (object: LifeOSObject, side: Record<string, unknown>) => Object.entries(side).every(([key, value]) => sameValue(valueOf(object, key), value));
const live = (object: LifeOSObject | undefined): object is LifeOSObject => Boolean(object && object.frontmatter.type === "person" && !object.frontmatter.deleted_at);
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const nameKey = (value: unknown) => typeof value === "string" ? foldForSearch(value.normalize("NFC")).trim().replace(/\s+/g, " ") : "";
const localPart = (email: string) => email.split("@")[0]!.replace(/\+.*$/, "");

export class PersonMergeConflictError extends Error { override name = "PersonMergeConflictError"; }

/** Serializes suggestion sweeps per application, so two triggers never propose the same pair twice. */
const sweeps = new WeakMap<AppContext, Promise<unknown>>();

export class PersonMergeModule {
  constructor(private readonly ctx: AppContext) {}

  /**
   * Proposes merges for likely duplicates and returns the new Review Item IDs. Pairs need at least one
   * unreviewed person (calendar- or agent-created), so deliberate look-alikes the user made are left alone;
   * `personIds` narrows the sweep to those people. A pair already proposed (in any status) is never re-proposed.
   */
  suggest(options: { now?: string; personIds?: string[]; newId?: () => string } = {}): Promise<string[]> {
    // `newId` (adoption's `run.newId`) makes the Review Item IDs replayable after a crash.
    const run = (sweeps.get(this.ctx) ?? Promise.resolve()).catch(() => undefined).then(() => this.suggestSerialized(options.now ?? new Date().toISOString(), options.personIds, options.newId ?? (() => uuidV7())));
    sweeps.set(this.ctx, run);
    return run;
  }

  private async suggestSerialized(now: string, only: string[] | undefined, newId: () => string) {
    const { ctx } = this;
    await ctx.rebuildIndex();
    const people = ctx.index.all().filter(live);
    const proposed = new Set(ctx.index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.review_type === personMergeReviewType).map((review) => {
      const fields = review.frontmatter.proposed_fields as Partial<PersonMergeProposal>;
      return pairKey(String(fields.keep_person_id), String(fields.merge_person_id));
    }));
    const created: string[] = [];
    for (const [index, left] of people.entries()) {
      for (const right of people.slice(index + 1)) {
        if (left.frontmatter.review_state !== "unreviewed" && right.frontmatter.review_state !== "unreviewed") continue;
        if (only && !only.includes(left.frontmatter.id) && !only.includes(right.frontmatter.id)) continue;
        if (left.frontmatter.is_self === true && right.frontmatter.is_self === true) continue;
        const key = pairKey(left.frontmatter.id, right.frontmatter.id);
        const match = proposed.has(key) ? undefined : this.match(left, right);
        if (!match) continue;
        proposed.add(key);
        const [keep, merge] = this.order(left, right);
        created.push(await this.writeSuggestion(keep, merge, match, now, newId));
      }
    }
    if (created.length) await ctx.rebuildIndex();
    return created;
  }

  /** Same address; same local part on two internal domains; or the same full name (case and accents ignored). */
  private match(left: LifeOSObject, right: LifeOSObject): PersonMergeMatch | undefined {
    const leftEmails = personEmails(left), rightEmails = personEmails(right);
    if (leftEmails.some((email) => rightEmails.includes(email))) return "email";
    const internal = (emails: string[]) => emails.filter((email) => internalDomainsOf(this.ctx.index).includes(email.split("@")[1]!));
    const rightInternal = internal(rightEmails);
    if (internal(leftEmails).some((email) => rightInternal.some((other) => other.split("@")[1] !== email.split("@")[1] && localPart(other) === localPart(email)))) return "email-local-part";
    const names = (person: LifeOSObject) => [nameKey(person.frontmatter.title), nameKey(`${String(person.frontmatter.given_name ?? "")} ${String(person.frontmatter.family_name ?? "")}`)].filter(Boolean);
    const rightNames = names(right);
    return names(left).some((name) => rightNames.includes(name)) ? "name" : undefined;
  }

  /** Which one survives: the self person, then a reviewed (user-known) person, then the older one. */
  private order(left: LifeOSObject, right: LifeOSObject): [LifeOSObject, LifeOSObject] {
    const rank = (person: LifeOSObject) => person.frontmatter.is_self === true ? 0 : person.frontmatter.review_state === "unreviewed" ? 2 : 1;
    const byRank = rank(left) - rank(right);
    if (byRank) return byRank < 0 ? [left, right] : [right, left];
    return left.frontmatter.created_at <= right.frontmatter.created_at ? [left, right] : [right, left];
  }

  private async writeSuggestion(keep: LifeOSObject, merge: LifeOSObject, match: PersonMergeMatch, now: string, newId: () => string) {
    const id = newId();
    const title = `Merge ${merge.frontmatter.title} into ${keep.frontmatter.title}`;
    const reason = match === "email" ? "Both have the same email address." : match === "email-local-part" ? "Their email addresses match on two internal domains." : "Their names match.";
    const proposal: PersonMergeProposal = { keep_person_id: keep.frontmatter.id, merge_person_id: merge.frontmatter.id, match, keep_title: keep.frontmatter.title, merge_title: merge.frontmatter.title };
    await this.ctx.objects.write({
      relativePath: `review-items/${markdownFileName(title, id, now)}`,
      frontmatter: { ...this.ctx.envelope(id, "review-item", title, now), review_type: personMergeReviewType, target_object_type: "person", proposed_fields: { ...proposal }, confidence_label: match === "name" ? "Medium" : "High", field_evidence: {}, status: "pending", operation_id: newId() },
      body: `# Possible duplicate person\n\n${reason} Accepting moves every reference from ${merge.frontmatter.title} to ${keep.frontmatter.title} and deletes ${merge.frontmatter.title}. Nothing changes until you accept.\n`
    });
    await this.ctx.writeAudit("review.proposed", id, now, { review_type: personMergeReviewType, keep_person_id: keep.frontmatter.id, merge_person_id: merge.frontmatter.id, match }, { type: "system" });
    return id;
  }

  /** Accept a `person-merge` Review Item. Safe to call again after a crash: it finishes, or rolls back, the stored plan. */
  async accept(review: LifeOSObject) {
    const { ctx } = this;
    const proposal = review.frontmatter.proposed_fields as PersonMergeProposal;
    const operationId = String(review.frontmatter.operation_id);
    if (review.frontmatter.status === "accepted") {
      await ctx.objects.completeOperation?.(operationId);
      return ctx.required(proposal.keep_person_id);
    }
    if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");

    const existing = (await ctx.objects.incompleteOperations?.())?.find((operation) => operation.id === operationId);
    let plan = existing?.payload.plan as PlanEntry[] | undefined;
    if (!plan) {
      plan = this.plan(proposal);
      plan = (await ctx.objects.prepareOperation?.(personMergeOperation, { reviewId: review.frontmatter.id, keepId: proposal.keep_person_id, mergeId: proposal.merge_person_id, plan }, operationId))?.payload.plan as PlanEntry[] ?? plan;
    }
    const now = new Date().toISOString();
    const objects = plan.map((entry) => ctx.index.get(entry.id));
    const changed = plan.findIndex((entry, index) => !objects[index] || (!isAt(objects[index]!, entry.before) && !isAt(objects[index]!, entry.after)));
    if (changed >= 0) return this.rollBack(review, plan, operationId, objects[changed]?.relativePath ?? plan[changed]!.id, now);

    for (const [index, entry] of plan.entries()) await this.apply(objects[index]!, entry.after, now);
    await ctx.rebuildIndex();
    const latest = ctx.required(review.frontmatter.id);
    await ctx.update(latest, { status: "accepted", reviewed_at: now, resolved_object_id: proposal.keep_person_id, merge_problem: undefined }, { expectedHash: latest.contentHash, now });
    await ctx.writeAudit("person.merged", proposal.keep_person_id, now, { review_id: review.frontmatter.id, merged_person_id: proposal.merge_person_id, changed_object_ids: plan.map((entry) => entry.id) });
    await ctx.objects.completeOperation?.(operationId);
    await ctx.rebuildIndex();
    return ctx.required(proposal.keep_person_id);
  }

  /** Startup recovery of an interrupted merge: finish it, or roll it back if a file it touches changed meanwhile. */
  async recover(operation: { id: string; payload: Record<string, unknown> }): Promise<"completed" | "rolled-back"> {
    const review = this.ctx.index.get(String(operation.payload.reviewId));
    // The review already moved on (rolled back with a new operation, or deleted): nothing left to do.
    if (!review || review.frontmatter.operation_id !== operation.id) { await this.ctx.objects.completeOperation?.(operation.id); return "rolled-back"; }
    // #56: the user rejected the suggestion after the merge started: undo it rather than finish it.
    if (review.frontmatter.status !== "pending" && review.frontmatter.status !== "accepted") { await this.abandon(review, operation); return "rolled-back"; }
    try { await this.accept(review); return "completed"; }
    catch (error) { if (error instanceof PersonMergeConflictError) return "rolled-back"; throw error; }
  }

  /** The full before/after change set. References are listed first and the tombstone last. */
  private plan(proposal: PersonMergeProposal): PlanEntry[] {
    const { ctx } = this;
    const keep = ctx.index.get(proposal.keep_person_id), merge = ctx.index.get(proposal.merge_person_id);
    if (proposal.keep_person_id === proposal.merge_person_id) throw new Error("A person cannot be merged into itself");
    if (!live(keep) || !live(merge)) throw new Error(`${live(keep) ? proposal.merge_title : proposal.keep_title} no longer exists or was already merged; reject this suggestion`);
    if (merge.frontmatter.is_self === true) throw new Error("The self person cannot be merged into someone else");
    const from = merge.frontmatter.id, to = keep.frontmatter.id;
    const link = new RegExp(`(lifeos://object/)${from}`, "gi");
    const entries: PlanEntry[] = [];
    for (const object of ctx.index.all()) {
      if (untouchedTypes.has(object.frontmatter.type) || object.frontmatter.id === from || object.frontmatter.id === to) continue;
      const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(object.frontmatter)) {
        if (key === "id") continue;
        if (value === from) { before[key] = value; after[key] = to; }
        else if (Array.isArray(value) && value.includes(from)) { before[key] = value; after[key] = [...new Set(value.map((item) => item === from ? to : item))]; }
      }
      if (link.test(object.body)) { before[bodyKey] = object.body; after[bodyKey] = object.body.replace(link, `$1${to}`); }
      link.lastIndex = 0;
      if (Object.keys(before).length) entries.push({ id: object.frontmatter.id, before, after });
    }

    // The kept person learns the merged one's addresses (so calendar matching finds it) and name.
    const keepBefore: Record<string, unknown> = {}, keepAfter: Record<string, unknown> = {};
    const identifiers = Array.isArray(keep.frontmatter.identifiers) ? keep.frontmatter.identifiers : [];
    const missing = personEmails(merge).filter((email) => !personEmails(keep).includes(email));
    if (missing.length) { keepBefore.identifiers = keep.frontmatter.identifiers ?? null; keepAfter.identifiers = [...identifiers, ...missing.map((value) => ({ kind: "email", value }))]; }
    const aliases = Array.isArray(keep.frontmatter.aliases) ? keep.frontmatter.aliases as unknown[] : [];
    const newAliases = [merge.frontmatter.title, ...(Array.isArray(merge.frontmatter.aliases) ? merge.frontmatter.aliases : [])].filter((alias) => typeof alias === "string" && nameKey(alias) !== nameKey(keep.frontmatter.title) && !aliases.some((existing) => nameKey(existing) === nameKey(alias)));
    if (newAliases.length) { keepBefore.aliases = keep.frontmatter.aliases ?? null; keepAfter.aliases = [...aliases, ...new Set(newAliases)]; }
    for (const field of fillFields) if (keep.frontmatter[field] === undefined && merge.frontmatter[field] !== undefined) { keepBefore[field] = null; keepAfter[field] = merge.frontmatter[field]; }
    if (Object.keys(keepBefore).length) entries.push({ id: to, before: keepBefore, after: keepAfter });

    entries.push({ id: from, before: { deleted_at: null, merged_into_person_id: merge.frontmatter.merged_into_person_id ?? null }, after: { deleted_at: new Date().toISOString(), merged_into_person_id: to } });
    return entries;
  }

  private apply(current: LifeOSObject, side: Record<string, unknown>, now: string) {
    if (isAt(current, side)) return Promise.resolve(current);
    const changes = Object.fromEntries(Object.entries(side).filter(([key]) => key !== bodyKey).map(([key, value]) => [key, value ?? undefined]));
    const body = bodyKey in side ? String(side[bodyKey]) : undefined;
    return this.ctx.update(current, changes, { expectedHash: current.contentHash, now, body });
  }

  /**
   * #56: rejecting an item whose merge started but did not finish. Every step of a merge can be undone,
   * so the whole plan is rolled back and the operation closed; the caller then marks the item rejected.
   */
  async abandon(review: LifeOSObject, operation: { id: string; payload: Record<string, unknown> }) {
    const { ctx } = this;
    await ctx.rebuildIndex();
    const now = new Date().toISOString();
    await this.undo(operation.payload.plan as PlanEntry[] | undefined ?? [], now);
    await ctx.writeAudit("person.merge-rolled-back", review.frontmatter.id, now, { operation_id: operation.id, reason: "rejected" });
    await ctx.objects.completeOperation?.(operation.id);
    await ctx.rebuildIndex();
  }

  /** Puts back every file of the plan that is still at its merged value; files changed since are left alone. */
  private async undo(plan: PlanEntry[], now: string) {
    for (const entry of [...plan].reverse()) {
      const current = this.ctx.index.get(entry.id);
      if (current && !sameValue(entry.before, entry.after) && isAt(current, entry.after)) await this.apply(current, entry.before, now);
    }
    await this.ctx.rebuildIndex();
  }

  /** Puts back every file the plan already changed, gives the review a fresh operation and leaves it pending. */
  private async rollBack(review: LifeOSObject, plan: PlanEntry[], operationId: string, changedPath: string, now: string): Promise<never> {
    const { ctx } = this;
    await this.undo(plan, now);
    const message = `${changedPath} changed while the merge was in progress, so the merge was undone; review the suggestion again`;
    const latest = ctx.required(review.frontmatter.id);
    await ctx.update(latest, { operation_id: uuidV7(), merge_problem: message }, { expectedHash: latest.contentHash, now });
    await ctx.writeAudit("person.merge-rolled-back", review.frontmatter.id, now, { operation_id: operationId, changed: changedPath });
    await ctx.objects.completeOperation?.(operationId);
    await ctx.rebuildIndex();
    throw new PersonMergeConflictError(message);
  }
}
