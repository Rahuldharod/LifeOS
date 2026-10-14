import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { emailNameMatch, isUnreviewedPerson, type NameCandidate } from "@lifeos/shared";
import { foldForSearch, type AppContext } from "./context.js";
import { internalDomainsOf, personEmails } from "./people.js";
import { operationKinds, type Operation } from "./ports.js";
import { proposeReviewItem } from "./review-items.js";
import { isLive, OneAtATime, replayRoles, sameValue, type ReplayRole } from "./support.js";

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
export type PersonMergeMatch = "email" | "email-local-part" | "name" | "name-email" | "manual";
/** `name_from_person_id` (manual merges, #213) says whose name the kept person ends up with; absent means the kept person's own. */
export interface PersonMergeProposal { keep_person_id: string; merge_person_id: string; match: PersonMergeMatch; keep_title: string; merge_title: string; name_from_person_id?: string }
/** A likely duplicate pair and why it was found (#215). `keep` is the person who would survive. */
export interface PersonMergeCandidate { keepPersonId: string; mergePersonId: string; keepTitle: string; mergeTitle: string; match: PersonMergeMatch }
/** A Manual merge (#213): the two people and, optionally, who survives and whose name is kept. */
export interface ManualMergeOptions { personId: string; otherPersonId: string; keepPersonId?: string; nameFromPersonId?: string }
/** What a Manual merge would do, worked out without writing anything. */
export interface PersonMergePreview {
  keepPersonId: string; nameFromPersonId: string;
  /** True when one of the two is the Self person: it always survives, so who survives is fixed. */
  keepLocked: boolean;
  keep: { id: string; title: string }; merge: { id: string; title: string };
  keptName: string; aliases: string[]; emails: string[]; referenceCount: number;
}

/** One file's change. `null` means "field absent"; `$body` stands for the Markdown body. */
interface PlanEntry { id: string; before: Record<string, unknown>; after: Record<string, unknown> }
const bodyKey = "$body";
/** History and proposals keep pointing at what they described; only live references move. */
const untouchedTypes = new Set(["audit-event", "agent-run", "review-item"]);
/** Fields copied from the merged person only when the kept one has none. */
const fillFields = ["family_name", "organization_name", "job_title", "timezone"];

const valueOf = (object: LifeOSObject, key: string) => key === bodyKey ? object.body : object.frontmatter[key] ?? null;
const isAt = (object: LifeOSObject, side: Record<string, unknown>) => Object.entries(side).every(([key, value]) => sameValue(valueOf(object, key), value));
// A merge names both people by ID, so like any explicit ID it reaches an archived person; only a deleted (or already merged) one is refused.
const mergeable = (object: LifeOSObject | undefined): object is LifeOSObject => Boolean(object && object.frontmatter.type === "person" && !object.frontmatter.deleted_at);
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const nameKey = (value: unknown) => typeof value === "string" ? foldForSearch(value.normalize("NFC")).trim().replace(/\s+/g, " ") : "";
/** Every name a person is known by, for matching an email address against: title, given + family name, aliases. */
const namesOf = (person: LifeOSObject) => [person.frontmatter.title, `${String(person.frontmatter.given_name ?? "")} ${String(person.frontmatter.family_name ?? "")}`, ...(Array.isArray(person.frontmatter.aliases) ? person.frontmatter.aliases : [])].filter((name): name is string => typeof name === "string" && name.trim() !== "");
const candidateOf = (person: LifeOSObject): NameCandidate => ({ id: person.frontmatter.id, names: namesOf(person) });
const localPart = (email: string) => email.split("@")[0]!.replace(/\+.*$/, "");

const matchReasons: Record<PersonMergeMatch, string> = { email: "Both have the same email address.", "email-local-part": "Their email addresses match on two internal domains.", "name-email": "An email address of one fits the name of the other.", name: "Their names match.", manual: "You asked for this merge." };

export class PersonMergeConflictError extends Error { override name = "PersonMergeConflictError"; }

/**
 * #65: merges leave pending Review Items naming the merged person (they are history, so never rewritten).
 * Accepting one follows `merged_into_person_id`, through chains of merges, to the person who survives.
 * Any other ID (not a person, unknown, or a person deleted without a merge) comes back unchanged.
 */
export function survivingPersonId(index: { get(id: string): LifeOSObject | undefined }, id: string) {
  const seen = new Set<string>();
  let current = id;
  for (let person = index.get(current); person?.frontmatter.type === "person" && typeof person.frontmatter.merged_into_person_id === "string" && !seen.has(current); person = index.get(current)) {
    seen.add(current);
    current = person.frontmatter.merged_into_person_id;
  }
  return current;
}

/** Person references in a create proposal, each moved to its surviving person; lists lose the repeats this makes. */
export function followMergesInProposal(index: { get(id: string): LifeOSObject | undefined }, proposed: Record<string, unknown>) {
  const result = { ...proposed };
  for (const key of ["owner_person_id", "waiting_for_person_id"]) if (typeof result[key] === "string") result[key] = survivingPersonId(index, result[key]);
  if (Array.isArray(result.people_ids)) result.people_ids = [...new Set(result.people_ids.map((id) => typeof id === "string" ? survivingPersonId(index, id) : id))];
  return result;
}

/** Link-resolution person candidates moved to their surviving person (current title), each listed once. */
export function followMergesInCandidates(index: { get(id: string): LifeOSObject | undefined }, candidates: Array<{ id: string; title: string }>) {
  const byId = new Map<string, { id: string; title: string }>();
  for (const candidate of candidates) {
    const id = survivingPersonId(index, candidate.id);
    if (!byId.has(id)) byId.set(id, id === candidate.id ? candidate : { id, title: index.get(id)?.frontmatter.title ?? candidate.title });
  }
  return [...byId.values()];
}

/** Suggestion sweeps run one at a time per application, so two triggers never propose the same pair twice. */
const sweeps = new WeakMap<AppContext, OneAtATime>();

export class PersonMergeModule {
  constructor(private readonly ctx: AppContext) {}

  /**
   * Proposes merges for likely duplicates and returns the new Review Item IDs. Pairs need at least one
   * unreviewed person (calendar- or agent-created and never confirmed, including attendees known by name alone), so deliberate look-alikes the user made are left alone;
   * `personIds` narrows the sweep to those people. A pair already proposed (in any status) is never re-proposed.
   */
  suggest(options: { now?: string; personIds?: string[]; newId?: (role: ReplayRole) => string } = {}): Promise<string[]> {
    // `newId` (adoption's `run.newId`) makes the Review Item IDs replayable after a crash, keyed by the pair (#59).
    const queue = sweeps.get(this.ctx) ?? new OneAtATime();
    sweeps.set(this.ctx, queue);
    return queue.run("sweep", () => this.suggestSerialized(options.now ?? new Date().toISOString(), options.personIds, options.newId ?? (() => uuidV7())));
  }

  /** The likely duplicate pairs a sweep would propose right now, with why; nothing is written (#215). */
  async candidates(options: { personIds?: string[] } = {}): Promise<PersonMergeCandidate[]> {
    await this.ctx.rebuildIndex();
    return this.scan(options.personIds).flatMap(({ match, keep, merge }) => match ? [{ keepPersonId: keep.frontmatter.id, mergePersonId: merge.frontmatter.id, keepTitle: String(keep.frontmatter.title), mergeTitle: String(merge.frontmatter.title), match }] : []);
  }

  /**
   * The one place that decides which pairs are considered: live people only, at least one unreviewed, never two Self
   * people, `personIds` narrowing. `match` is undefined for a pair that matches nothing or was already proposed (any status);
   * `existing` is that earlier suggestion. Used by the live sweep and by `candidates`, so both always agree.
   */
  private scan(only: string[] | undefined) {
    const { ctx } = this;
    // Suggestions match by name, so they consider live people only.
    const people = ctx.index.all().filter((object) => mergeable(object) && isLive(object));
    const suggestions = new Map(ctx.index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.review_type === personMergeReviewType).map((review) => {
      const fields = review.frontmatter.proposed_fields as Partial<PersonMergeProposal>;
      return [pairKey(String(fields.keep_person_id), String(fields.merge_person_id)), review] as const;
    }));
    const candidates = people.map(candidateOf);
    const seen = new Set<string>();
    const pairs: Array<{ key: string; existing?: LifeOSObject; match?: PersonMergeMatch; keep: LifeOSObject; merge: LifeOSObject }> = [];
    for (const [index, left] of people.entries()) {
      for (const right of people.slice(index + 1)) {
        if (!isUnreviewedPerson(left.frontmatter) && !isUnreviewedPerson(right.frontmatter)) continue;
        if (only && !only.includes(left.frontmatter.id) && !only.includes(right.frontmatter.id)) continue;
        if (left.frontmatter.is_self === true && right.frontmatter.is_self === true) continue;
        const key = pairKey(left.frontmatter.id, right.frontmatter.id);
        const existing = suggestions.get(key);
        const match = existing || seen.has(key) ? undefined : this.match(left, right, candidates);
        if (match) seen.add(key);
        const [keep, merge] = this.order(left, right);
        pairs.push({ key, existing, match, keep, merge });
      }
    }
    return pairs;
  }

  private async suggestSerialized(now: string, only: string[] | undefined, newId: (role: ReplayRole) => string) {
    const { ctx } = this;
    await ctx.rebuildIndex();
    const created: string[] = [];
    for (const { key, existing, match, keep, merge } of this.scan(only)) {
      // #74: a crash replay finds the suggestion its first attempt wrote (same replayable ID); its audit may be missing.
      if (existing && existing.frontmatter.id === newId(replayRoles.merge(key))) await this.auditSuggestion(existing.frontmatter.id, existing.frontmatter.proposed_fields as PersonMergeProposal, now);
      if (!match) continue;
      created.push(await this.writeSuggestion(keep, merge, match, now, newId));
    }
    if (created.length) await ctx.rebuildIndex();
    return created;
  }

  /**
   * Manual merge (#213), step one: the Review Item that carries the merge, so the crash-safe accept of ADR 0013 does the work.
   * A pending suggestion for the same pair is rewritten to the user's choice instead of leaving a stale twin behind; a retry
   * after a crash finds the item (and its stored plan) the first attempt wrote.
   */
  proposeManual(options: ManualMergeOptions): Promise<LifeOSObject> {
    const queue = sweeps.get(this.ctx) ?? new OneAtATime();
    sweeps.set(this.ctx, queue);
    return queue.run("sweep", async () => {
      const { ctx } = this;
      await ctx.rebuildIndex();
      const choice = this.manualChoice(options);
      const now = new Date().toISOString();
      const key = pairKey(choice.keep.frontmatter.id, choice.merge.frontmatter.id);
      const pending = ctx.index.all().find((review) => review.frontmatter.type === "review-item" && review.frontmatter.review_type === personMergeReviewType && review.frontmatter.status === "pending"
        && pairKey(String((review.frontmatter.proposed_fields as Partial<PersonMergeProposal>).keep_person_id), String((review.frontmatter.proposed_fields as Partial<PersonMergeProposal>).merge_person_id)) === key);
      if (!pending) {
        const id = await this.writeSuggestion(choice.keep, choice.merge, "manual", now, () => uuidV7(), choice.nameFrom.frontmatter.id);
        await ctx.rebuildIndex();
        return ctx.required(id);
      }
      // A merge already under way keeps its stored plan: accepting finishes that one.
      if ((await ctx.objects.incompleteOperations?.())?.some((operation) => operation.id === pending.frontmatter.operation_id)) return pending;
      const proposal = this.manualProposal(choice);
      const updated = await ctx.update(pending, { title: this.suggestionTitle(choice.keep, choice.merge), proposed_fields: { ...proposal }, confidence_label: "High" }, { expectedHash: pending.contentHash, now, body: this.suggestionBody(choice.keep, choice.merge, "manual") });
      await ctx.rebuildIndex();
      return updated;
    });
  }

  /** What a Manual merge would do, worked out from the same plan the merge itself uses; nothing is written. */
  async previewManual(options: ManualMergeOptions): Promise<PersonMergePreview> {
    await this.ctx.rebuildIndex();
    const choice = this.manualChoice(options);
    const plan = this.plan(this.manualProposal(choice));
    const { keep, merge, nameFrom } = choice;
    const afterKeep = plan.find((entry) => entry.id === keep.frontmatter.id)?.after ?? {};
    const emails = Array.isArray(afterKeep.identifiers) ? afterKeep.identifiers.flatMap((identifier: { kind?: string; value?: string }) => identifier.kind === "email" && identifier.value ? [identifier.value] : []) : personEmails(keep);
    const aliases = Array.isArray(afterKeep.aliases) ? afterKeep.aliases as string[] : Array.isArray(keep.frontmatter.aliases) ? keep.frontmatter.aliases as string[] : [];
    return {
      keepPersonId: keep.frontmatter.id, nameFromPersonId: nameFrom.frontmatter.id, keepLocked: keep.frontmatter.is_self === true || merge.frontmatter.is_self === true,
      keep: { id: keep.frontmatter.id, title: keep.frontmatter.title }, merge: { id: merge.frontmatter.id, title: merge.frontmatter.title },
      keptName: String(afterKeep.title ?? keep.frontmatter.title), aliases, emails,
      referenceCount: plan.filter((entry) => entry.id !== keep.frontmatter.id && entry.id !== merge.frontmatter.id).length
    };
  }

  private manualProposal({ keep, merge, nameFrom }: { keep: LifeOSObject; merge: LifeOSObject; nameFrom: LifeOSObject }): PersonMergeProposal {
    return { keep_person_id: keep.frontmatter.id, merge_person_id: merge.frontmatter.id, match: "manual", keep_title: keep.frontmatter.title, merge_title: merge.frontmatter.title, name_from_person_id: nameFrom.frontmatter.id };
  }

  /**
   * Validates a Manual merge and fills the defaults: the existing survivor rule (Self, reviewed, older) and the name that has a
   * family name. The Self person always survives, whatever was asked (enforced here, not only in the screen).
   */
  private manualChoice(options: ManualMergeOptions) {
    const { ctx } = this;
    if (options.personId === options.otherPersonId) throw new Error("A person cannot be merged into itself");
    const left = ctx.index.get(options.personId), right = ctx.index.get(options.otherPersonId);
    if (!mergeable(left) || !mergeable(right)) throw new Error(`${mergeable(left) ? options.otherPersonId : options.personId} no longer exists or was already merged`);
    const both = [left, right];
    const pick = (id: string | undefined, field: string) => {
      if (id === undefined) return undefined;
      const person = both.find((candidate) => candidate.frontmatter.id === id);
      if (!person) throw new Error(`${field} must be one of the two people`);
      return person;
    };
    const self = both.find((person) => person.frontmatter.is_self === true);
    const asked = pick(options.keepPersonId, "keepPersonId");
    if (self && asked && asked !== self) throw new Error("The Self person always survives; it cannot be merged into someone else");
    const keep = self ?? asked ?? this.order(left, right)[0];
    const merge = keep === left ? right : left;
    const hasFamilyName = (person: LifeOSObject) => (typeof person.frontmatter.family_name === "string" && person.frontmatter.family_name.trim() !== "") || String(person.frontmatter.title).trim().split(/\s+/).length > 1;
    const nameFrom = pick(options.nameFromPersonId, "nameFromPersonId") ?? (keep !== self && !hasFamilyName(keep) && hasFamilyName(merge) ? merge : keep);
    return { keep, merge, nameFrom };
  }

  /** Same address; same local part on two internal domains; the same full name; or an address that fits the other's name (case and accents ignored). */
  private match(left: LifeOSObject, right: LifeOSObject, candidates: readonly NameCandidate[]): PersonMergeMatch | undefined {
    const leftEmails = personEmails(left), rightEmails = personEmails(right);
    if (leftEmails.some((email) => rightEmails.includes(email))) return "email";
    const internal = (emails: string[]) => emails.filter((email) => internalDomainsOf(this.ctx.index).includes(email.split("@")[1]!));
    const rightInternal = internal(rightEmails);
    if (internal(leftEmails).some((email) => rightInternal.some((other) => other.split("@")[1] !== email.split("@")[1] && localPart(other) === localPart(email)))) return "email-local-part";
    const names = (person: LifeOSObject) => [nameKey(person.frontmatter.title), nameKey(`${String(person.frontmatter.given_name ?? "")} ${String(person.frontmatter.family_name ?? "")}`)].filter(Boolean);
    const rightNames = names(right);
    if (names(left).some((name) => rightNames.includes(name))) return "name";
    const fits = (emails: string[], person: LifeOSObject) => emails.some((email) => emailNameMatch(email, candidateOf(person), candidates));
    return fits(leftEmails, right) || fits(rightEmails, left) ? "name-email" : undefined;
  }

  /** Which one survives: the self person, then a reviewed (user-known) person, then the older one. */
  private order(left: LifeOSObject, right: LifeOSObject): [LifeOSObject, LifeOSObject] {
    const rank = (person: LifeOSObject) => person.frontmatter.is_self === true ? 0 : isUnreviewedPerson(person.frontmatter) ? 2 : 1;
    const byRank = rank(left) - rank(right);
    if (byRank) return byRank < 0 ? [left, right] : [right, left];
    return left.frontmatter.created_at <= right.frontmatter.created_at ? [left, right] : [right, left];
  }

  private suggestionTitle(keep: LifeOSObject, merge: LifeOSObject) { return `Merge ${merge.frontmatter.title} into ${keep.frontmatter.title}`; }

  private suggestionBody(keep: LifeOSObject, merge: LifeOSObject, match: PersonMergeMatch) {
    return `# Possible duplicate person\n\n${matchReasons[match]} Accepting moves every reference from ${merge.frontmatter.title} to ${keep.frontmatter.title} and deletes ${merge.frontmatter.title}. Nothing changes until you accept.\n`;
  }

  private async writeSuggestion(keep: LifeOSObject, merge: LifeOSObject, match: PersonMergeMatch, now: string, newId: (role: ReplayRole) => string, nameFromId?: string) {
    const role = replayRoles.merge(pairKey(keep.frontmatter.id, merge.frontmatter.id));
    const proposal: PersonMergeProposal = { keep_person_id: keep.frontmatter.id, merge_person_id: merge.frontmatter.id, match, keep_title: keep.frontmatter.title, merge_title: merge.frontmatter.title, ...(nameFromId ? { name_from_person_id: nameFromId } : {}) };
    const { frontmatter: { id } } = await proposeReviewItem(this.ctx, { now, newId }, {
      role, reviewType: personMergeReviewType, title: this.suggestionTitle(keep, merge), target: { type: "person" }, proposed: { ...proposal }, confidence: match === "name" || match === "name-email" ? "Medium" : "High",
      readsFrom: [keep.frontmatter.id, merge.frontmatter.id], body: this.suggestionBody(keep, merge, match)
    });
    await this.auditSuggestion(id, proposal, now);
    return id;
  }

  /** The suggestion's `review.proposed` audit, written once per Review Item (ADR 0013). */
  private auditSuggestion(reviewId: string, proposal: PersonMergeProposal, now: string) {
    return this.ctx.writeAuditOnce("review.proposed", reviewId, now, { review_type: personMergeReviewType, keep_person_id: proposal.keep_person_id, merge_person_id: proposal.merge_person_id, match: proposal.match }, { matchOn: [], actor: { type: "system" } });
  }

  /** Accept a `person-merge` Review Item. Safe to call again after a crash: it finishes, or rolls back, the stored plan. */
  async accept(review: LifeOSObject) {
    const { ctx } = this;
    const proposal = review.frontmatter.proposed_fields as PersonMergeProposal;
    const operationId = String(review.frontmatter.operation_id);
    if (review.frontmatter.status === "accepted") {
      const open = (await ctx.objects.incompleteOperations?.())?.find((operation) => operation.id === operationId);
      if (open) {
        // #160: the crash came after the item was marked accepted and before its audit.
        const plan = open.payload.plan as PlanEntry[] | undefined ?? [];
        await ctx.writeAuditOnce("person.merged", proposal.keep_person_id, String(review.frontmatter.reviewed_at ?? new Date().toISOString()), { operation_id: operationId, review_id: review.frontmatter.id, merged_person_id: proposal.merge_person_id, changed_object_ids: plan.map((entry) => entry.id) }, { matchOn: ["operation_id"] });
        await ctx.objects.completeOperation?.(operationId);
      }
      return ctx.required(proposal.keep_person_id);
    }
    if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");

    const existing = (await ctx.objects.incompleteOperations?.())?.find((operation) => operation.id === operationId);
    let plan = existing?.payload.plan as PlanEntry[] | undefined;
    if (!plan) {
      plan = this.plan(proposal);
      plan = (await ctx.objects.prepareOperation?.(operationKinds.mergePerson, { reviewId: review.frontmatter.id, keepId: proposal.keep_person_id, mergeId: proposal.merge_person_id, plan }, operationId))?.payload.plan as PlanEntry[] ?? plan;
    }
    const now = new Date().toISOString();
    const objects = plan.map((entry) => ctx.index.get(entry.id));
    const changed = plan.findIndex((entry, index) => !objects[index] || (!isAt(objects[index]!, entry.before) && !isAt(objects[index]!, entry.after)));
    if (changed >= 0) return this.rollBack(review, plan, operationId, objects[changed]?.relativePath ?? plan[changed]!.id, now);

    for (const [index, entry] of plan.entries()) await this.apply(objects[index]!, entry.after, now);
    await ctx.rebuildIndex();
    const latest = ctx.required(review.frontmatter.id);
    await ctx.update(latest, { status: "accepted", reviewed_at: now, resolved_object_id: proposal.keep_person_id, merge_problem: undefined }, { expectedHash: latest.contentHash, now });
    await ctx.writeAuditOnce("person.merged", proposal.keep_person_id, now, { operation_id: operationId, review_id: review.frontmatter.id, merged_person_id: proposal.merge_person_id, changed_object_ids: plan.map((entry) => entry.id) }, { matchOn: ["operation_id"] });
    await ctx.objects.completeOperation?.(operationId);
    await ctx.rebuildIndex();
    return ctx.required(proposal.keep_person_id);
  }

  /** Startup recovery of an interrupted merge: finish it, or roll it back if a file it touches changed meanwhile. */
  async recover(operation: Operation): Promise<"completed" | "rolled-back"> {
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
    if (!mergeable(keep) || !mergeable(merge)) throw new Error(`${mergeable(keep) ? proposal.merge_title : proposal.keep_title} no longer exists or was already merged; reject this suggestion`);
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
    // #213: the kept name is the kept person's own unless the user chose the merged person's; either way the name set aside becomes an alias.
    const takesMergedName = proposal.name_from_person_id === merge.frontmatter.id && merge.frontmatter.title !== keep.frontmatter.title;
    const finalTitle = takesMergedName ? merge.frontmatter.title : keep.frontmatter.title;
    if (takesMergedName) {
      keepBefore.title = keep.frontmatter.title; keepAfter.title = merge.frontmatter.title;
      for (const field of ["given_name", "family_name"]) if (merge.frontmatter[field] !== keep.frontmatter[field]) { keepBefore[field] = keep.frontmatter[field] ?? null; keepAfter[field] = merge.frontmatter[field] ?? null; }
    }
    const aliases = Array.isArray(keep.frontmatter.aliases) ? keep.frontmatter.aliases as unknown[] : [];
    const known: unknown[] = [finalTitle, ...aliases];
    const newAliases: string[] = [];
    for (const alias of [keep.frontmatter.title, merge.frontmatter.title, ...(Array.isArray(merge.frontmatter.aliases) ? merge.frontmatter.aliases : [])]) {
      if (typeof alias !== "string" || known.some((existing) => nameKey(existing) === nameKey(alias))) continue;
      known.push(alias); newAliases.push(alias);
    }
    if (newAliases.length) { keepBefore.aliases = keep.frontmatter.aliases ?? null; keepAfter.aliases = [...aliases, ...newAliases]; }
    for (const field of fillFields) if (!(field in keepAfter) && keep.frontmatter[field] === undefined && merge.frontmatter[field] !== undefined) { keepBefore[field] = null; keepAfter[field] = merge.frontmatter[field]; }
    // #213: a merge is the user's call (their own, or accepting a suggestion), so the person who stays counts as reviewed.
    if (keep.frontmatter.is_self !== true && keep.frontmatter.review_state !== "reviewed") { keepBefore.review_state = keep.frontmatter.review_state ?? null; keepAfter.review_state = "reviewed"; }
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
  async abandon(review: LifeOSObject, operation: Operation) {
    const { ctx } = this;
    await ctx.rebuildIndex();
    const now = new Date().toISOString();
    await this.undo(operation.payload.plan as PlanEntry[] | undefined ?? [], now);
    await ctx.writeAuditOnce("person.merge-rolled-back", review.frontmatter.id, now, { operation_id: operation.id, reason: "rejected" }, { matchOn: ["operation_id"] });
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
    await ctx.writeAuditOnce("person.merge-rolled-back", review.frontmatter.id, now, { operation_id: operationId, changed: changedPath }, { matchOn: ["operation_id"] });
    await ctx.objects.completeOperation?.(operationId);
    await ctx.rebuildIndex();
    throw new PersonMergeConflictError(message);
  }
}
