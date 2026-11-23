import { originOf, uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { isReviewActionUndoable, notYetUndoable } from "@lifeos/shared";
import { isCalendarDate, proposalBody, toUtc } from "./adoption.js";
import { markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { acceptSummary, summaryReviewType } from "./meeting-material.js";
import type { DecisionsModule } from "./decisions.js";
import type { MeetingsModule } from "./meetings.js";
import { appendedText, type UpdateProposal } from "./patches.js";
import { applyRevert, planLinkRevert, planUpdateRevert, rebasedProposal, type LinkUndo } from "./review-undo.js";
import { followMergesInCandidates, followMergesInProposal, PersonMergeModule, personMergeReviewType, survivingPersonId } from "./person-merge.js";
import { operationKinds, type Operation } from "./ports.js";
import { proposeReviewItem, recordAgentRun, seededRun } from "./review-items.js";
import { contextLinkFields, inheritContextLinks, isLive, isRestricted, OneAtATime, replayRoles, sameValue, validTimeZone } from "./support.js";


/**
 * #243: an item that is accepted, undone and accepted again must leave one `review.accepted` audit per accept, or the Inbox
 * History would miss the second one (a link or update accept audits the same target both times). Undo gives the item a fresh
 * `operation_id`, so the audit is matched on it; an item never undone has none, and a crash replay shares it.
 */
const acceptRound = (review: LifeOSObject) => typeof review.frontmatter.operation_id === "string" ? { operation_id: review.frontmatter.operation_id } : {};

/** Review Items: proposing them from a meeting, editing, accepting and rejecting. */
export class ReviewModule {
  /** `person-merge` Review Items (#40): suggesting, accepting and recovering merges. */
  readonly merges: PersonMergeModule;
  /** #62: accept, reject and recover calls run one at a time per Review Item (ADR 0013). */
  private readonly queues = new OneAtATime();
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule, private readonly decisions: DecisionsModule) { this.merges = new PersonMergeModule(ctx); }

  /**
   * #62: runs `work` after every earlier accept, reject or recovery of the same Review Item has settled, so a
   * double-click or two tabs resolve to one outcome: the later call sees the first one's result.
   */
  private serialise<T>(reviewId: string, work: () => Promise<T>): Promise<T> {
    return this.queues.run(reviewId, work);
  }

  /** #65: pending link-resolution items list person candidates as they stand after merges (read-time only; files unchanged). */
  reviews() {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "review-item").map((review) => {
      const proposed = review.frontmatter.proposed_fields as { candidate_type?: unknown; candidates?: unknown } | undefined;
      if (review.frontmatter.review_type !== "link-resolution" || review.frontmatter.status !== "pending" || proposed?.candidate_type !== "person" || !Array.isArray(proposed.candidates)) return review;
      return { ...review, frontmatter: { ...review.frontmatter, proposed_fields: { ...proposed, candidates: followMergesInCandidates(this.ctx.index, proposed.candidates as Array<{ id: string; title: string }>) } } };
    });
  }

  async processMeeting(meetingId: string) {
    const { ctx } = this;
    if (!ctx.ai) throw new Error("AI provider is not configured");
    const workspace = await this.meetings.meetingWorkspace(meetingId);
    if (!workspace.note) throw new Error("Meeting has no canonical note");
    const note = workspace.note;
    // #122: IDs (and file names) come from this version of the note (ADR 0013), so a retry after a crash finds what
    // the first attempt wrote; what is written records when it actually ran.
    const seeded = seededRun(ctx, `meeting-outputs:${note.frontmatter.id}:${note.contentHash}`, note.frontmatter.updated_at);
    const pending = workspace.reviews.filter((review) => review.frontmatter.status === "pending");
    // Proposals still waiting from an earlier version of the note (or from adoption) are returned, not added to.
    if (pending.some((review) => !seeded.owns(review.frontmatter.id))) return pending;
    const proposals = await ctx.ai.proposeMeetingOutputs(note.body);
    const run = await recordAgentRun(ctx, seeded, {
      operation: "meeting-extraction", title: "Process meeting", inputSummary: note.frontmatter.title, outputSummary: `${proposals.length} proposals`,
      relatedObjectIds: [meetingId, note.frontmatter.id], body: `# Agent run\n\nProcessed ${note.frontmatter.title}.\n`
    });
    const created = new Map<string, LifeOSObject>();
    for (const proposal of proposals) {
      // The role comes from what is proposed, not where it sits in the answer: a retry whose answer is reordered
      // finds each item the first attempt wrote. The same proposal twice in one answer is one item.
      const role = replayRoles.meetingOutput(proposal.type, proposal.title);
      if (created.has(role)) continue;
      created.set(role, await proposeReviewItem(ctx, run, {
        role, reviewType: "create", title: proposal.title, target: { type: proposal.type },
        proposed: { title: proposal.title, status: "Inbox" }, confidence: proposal.confidence, sourceIds: [note.frontmatter.id],
        fields: { source_meeting_id: meetingId, ...inheritContextLinks(workspace.meeting) },
        body: `# Proposal\n\n${proposal.title}\n`
      }));
    }
    await ctx.rebuildIndex();
    // A retry returns only what still waits: an item accepted or rejected since is not proposed again.
    return [...created.values()].filter((review) => review.frontmatter.status === "pending");
  }

  /** `linkTo` is the object chosen for a `link-resolution` item; other review types ignore it. */
  acceptReviewItem(reviewId: string, options: { linkTo?: string } = {}) {
    return this.serialise(reviewId, async () => {
      // #82: a reject the user started (and a crash interrupted) wins over a later accept: it is finished instead.
      const rejecting = await this.openReject(reviewId);
      if (rejecting) {
        await this.finishReject(rejecting);
        throw new Error("This review item was rejected; its unfinished accept was undone");
      }
      return this.accept(reviewId, options);
    });
  }

  private async accept(reviewId: string, options: { linkTo?: string } = {}) {
    const { ctx } = this;
    const review = ctx.required(reviewId, "review-item");
    if (review.frontmatter.review_type === personMergeReviewType) return this.merges.accept(review);
    if (review.frontmatter.review_type === "link-resolution") return this.acceptLinkResolution(review, options.linkTo);
    if (review.frontmatter.review_type === "update") return this.acceptUpdate(review);
    if (review.frontmatter.review_type === summaryReviewType) return acceptSummary(ctx, review);
    if (review.frontmatter.status === "accepted" && typeof review.frontmatter.resolved_object_id === "string") {
      const operationId = review.frontmatter.operation_id;
      if (typeof operationId === "string" && (await ctx.objects.incompleteOperations?.())?.some((operation) => operation.id === operationId)) {
        // #160: the crash came after the item was marked accepted and before its audit.
        await ctx.writeAuditOnce("review.accepted", review.frontmatter.resolved_object_id, String(review.frontmatter.reviewed_at ?? new Date().toISOString()), { review_id: reviewId }, { matchOn: ["review_id"] });
        await ctx.objects.completeOperation?.(operationId);
      }
      return ctx.required(review.frontmatter.resolved_object_id);
    }
    if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");
    const now = new Date().toISOString();
    const owner = await ctx.ensureSelfPerson(now);
    const requestedOperationId = typeof review.frontmatter.operation_id === "string" ? review.frontmatter.operation_id : uuidV7();
    const operation = await ctx.objects.prepareOperation?.(operationKinds.acceptReview, { reviewId, objectId: uuidV7() }, requestedOperationId);
    const objectId = typeof operation?.payload.objectId === "string" ? operation.payload.objectId : uuidV7();
    // #65: people merged since the proposal was written are replaced by the person they were merged into.
    const proposed = followMergesInProposal(ctx.index, review.frontmatter.proposed_fields as Record<string, unknown>);
    const title = typeof proposed.title === "string" ? proposed.title : review.frontmatter.title;
    const targetType = String(review.frontmatter.target_object_type);
    const folder = targetType === "task" ? "tasks" : targetType === "decision" ? "decisions" : targetType === "open-point" ? "open-points" : targetType === "knowledge-note" ? "knowledge" : undefined;
    if (!folder) throw new Error(`Unsupported review target: ${targetType}`);
    // Proposed fields carried over as they stand after the user's edits.
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((key) => proposed[key] !== undefined).map((key) => [key, proposed[key]]));
    // #122: a proposal drawn from something restricted makes a restricted object (ADR 0010), whatever its fields say.
    const extras = { ...pick(["area", "sensitivity", "subjects", "tags", "captured_at", "people_ids"]), ...(isRestricted(review) ? { sensitivity: "restricted" as const } : {}) };
    const ownerId = typeof proposed.owner_person_id === "string" ? proposed.owner_person_id : owner.frontmatter.id;
    const common = { source_meeting_id: review.frontmatter.source_meeting_id, source_ids: review.frontmatter.source_ids ?? [], ...Object.fromEntries(contextLinkFields.map((key) => [key, review.frontmatter[key]])) };
    const fields = targetType === "task"
      ? { status: proposed.status ?? "Inbox", owner_person_id: ownerId, ...pick(["priority", "due_on", "due_at", "due_timezone", "expected_output", "completed_at", "cancelled_at", "waiting_for_person_id"]), ...extras, ...common }
      : targetType === "decision"
        ? { status: "active", decision_text: proposed.decision_text ?? title, decided_at: proposed.decided_at ?? now, ...extras, ...common }
        : targetType === "open-point"
          ? { status: proposed.status ?? "open", owner_person_id: ownerId, ...extras, ...common }
          : { ...extras, source_ids: review.frontmatter.source_ids ?? [], related_object_ids: [] };
    const narrative = typeof proposed.body === "string" ? proposed.body.trim() : "";
    const body = targetType === "knowledge-note" && typeof proposed.body === "string" ? proposed.body : `# ${title}\n${narrative ? `\n${narrative}\n` : ""}`;
    // The created object keeps where the proposal came from: agent-extracted proposals stay agent-extracted (ADR 0010).
    const created = ctx.index.get(objectId) ?? await ctx.objects.write({ relativePath: `${folder}/${markdownFileName(title, objectId, now)}`, frontmatter: { ...ctx.envelope(objectId, targetType as ObjectEnvelope["type"], title, now, originOf(review.frontmatter)), ...fields }, body });
    await ctx.update(review, { status: "accepted", reviewed_at: now, resolved_object_id: objectId }, { expectedHash: review.contentHash, now });
    await ctx.rebuildIndex();
    await ctx.writeAuditOnce("review.accepted", objectId, now, { review_id: reviewId }, { matchOn: ["review_id"] });
    await ctx.objects.completeOperation?.(requestedOperationId);
    await ctx.rebuildIndex();
    return created;
  }

  /**
   * Sets the chosen link on the target through a guarded write (revision + content hash of the version
   * just read), appending for list fields. Idempotent: an accepted item returns the target unchanged.
   */
  private async acceptLinkResolution(review: LifeOSObject, linkTo: string | undefined) {
    const { ctx } = this;
    const targetId = String(review.frontmatter.target_object_id);
    if (review.frontmatter.status === "accepted") return ctx.required(targetId);
    if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");
    const proposed = review.frontmatter.proposed_fields as { link_field: string; list?: boolean; candidate_type: ObjectEnvelope["type"]; candidates?: Array<{ id: string }> };
    // #65: merged people stand for the person they were merged into, so a merged pair is one candidate.
    const candidates = proposed.candidate_type === "person" ? followMergesInCandidates(ctx.index, (proposed.candidates ?? []) as Array<{ id: string; title: string }>) : proposed.candidates ?? [];
    const picked = linkTo ?? (candidates.length === 1 ? candidates[0]!.id : undefined);
    const chosenId = picked && proposed.candidate_type === "person" ? survivingPersonId(ctx.index, picked) : picked;
    if (!chosenId) throw new Error(`Choose the ${proposed.candidate_type} to link`);
    const chosen = ctx.index.get(chosenId);
    // Not isLive on purpose: the user picks the object by ID, and an explicit ID reaches an archived object (#118).
    if (!chosen || chosen.frontmatter.type !== proposed.candidate_type || chosen.frontmatter.deleted_at) throw new Error(`Choose an existing ${proposed.candidate_type} to link`);
    const target = ctx.required(targetId);
    if (target.frontmatter.deleted_at) throw new Error("The object to link was deleted");
    const current = target.frontmatter[proposed.link_field];
    const value = proposed.list ? [...(Array.isArray(current) ? current as string[] : []).filter((id) => id !== chosenId), chosenId] : chosenId;
    const now = new Date().toISOString();
    const unchanged = proposed.list ? Array.isArray(current) && current.includes(chosenId) : current === chosenId;
    // #242: what the link replaces is recorded on the item before the link is written, so a crash between the two writes cannot
    // lose it (a retry finds the link already in place and reuses this record instead of reading it as "was already linked").
    const held = (review.frontmatter.link_undo ?? {}) as Partial<LinkUndo>;
    const record: LinkUndo = unchanged && held.changed === true && held.linked === chosenId && held.field === proposed.link_field && held.target_id === targetId
      ? held as LinkUndo
      : { target_id: targetId, field: proposed.link_field, list: Boolean(proposed.list), previous: current ?? null, linked: chosenId, changed: !unchanged };
    const recorded = sameValue(held, record) ? review : await ctx.update(review, { link_undo: record }, { expectedHash: review.contentHash, now });
    const updated = unchanged ? target : await ctx.update(target, { [proposed.link_field]: value }, { expectedHash: target.contentHash, now });
    await ctx.update(recorded, { status: "accepted", reviewed_at: now, resolved_object_id: targetId, chosen_object_id: chosenId }, { expectedHash: recorded.contentHash, now });
    await ctx.writeAuditOnce("review.accepted", targetId, now, { review_id: review.frontmatter.id, ...acceptRound(review), link_field: proposed.link_field, linked_object_id: chosenId }, { matchOn: ["review_id", "operation_id"] });
    await ctx.rebuildIndex();
    return updated;
  }

  /**
   * #37: applies an `update` item's fields (and note) to its target with the revision check: if the target
   * changed in any way since the item was raised, accepting fails as a conflict and nothing is written.
   * The guarded write also enforces the envelope and decision lifecycle rules. Retrying after a crash
   * between the two writes finds the change already on the target, one revision on, and just finishes.
   */
  private async acceptUpdate(review: LifeOSObject) {
    const { ctx } = this;
    const targetId = String(review.frontmatter.target_object_id);
    if (review.frontmatter.status === "accepted") return ctx.required(targetId);
    if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");
    const proposal = review.frontmatter.proposed_fields as unknown as UpdateProposal;
    const target = ctx.required(targetId);
    // Not isLive on purpose: the change targets its object by ID, which reaches an archived object (#118).
    if (target.frontmatter.deleted_at) throw new Error("The object to change was deleted");
    const note = proposal.append_note;
    // #67: superseding goes through the Decisions workspace path, which sets both links.
    const successor = target.frontmatter.type === "decision" ? proposal.changes.find((change) => change.field === "superseded_by_decision_id")?.proposed : undefined;
    const successorId = typeof successor === "string" ? successor : undefined;
    const landed = target.frontmatter.revision === proposal.base_revision + 1 && proposal.changes.every((change) => sameValue(target.frontmatter[change.field], change.proposed)) && (!note || target.body.endsWith(`\n${note}\n`));
    const now = new Date().toISOString();
    let updated = target;
    // #242: the exact text added to the body, kept on the item so undo can remove precisely that (unknown after a crash retry: undo is refused then).
    let appended: string | undefined;
    if (!landed) {
      if (target.frontmatter.revision !== proposal.base_revision || target.contentHash !== proposal.base_hash) {
        throw new ObjectConflictError(`${target.frontmatter.title} changed since this review item was raised (revision ${proposal.base_revision}, now ${target.frontmatter.revision}); reject it and send the change again`);
      }
      const changes = Object.fromEntries(proposal.changes.map((change) => [change.field, change.proposed ?? undefined]));
      appended = note ? appendedText(target.body, note) : undefined;
      const body = appended !== undefined ? target.body + appended : undefined;
      updated = successorId
        ? (await this.decisions.supersedeWith(targetId, successorId, proposal.base_hash, { changes, ...(body !== undefined ? { body } : {}) })).superseded
        : await ctx.update(target, changes, { expectedHash: proposal.base_hash, now, ...(body !== undefined ? { body } : {}) });
    } else if (successorId) {
      // #67: a crash may have left the successor's back link unwritten; finish it (a no-op once both links are set).
      updated = (await this.decisions.supersedeWith(targetId, successorId, target.contentHash)).superseded;
    }
    await ctx.update(review, { status: "accepted", reviewed_at: now, resolved_object_id: targetId, ...(appended !== undefined ? { applied_append: appended } : {}) }, { expectedHash: review.contentHash, now });
    await ctx.writeAuditOnce("review.accepted", targetId, now, {
      review_id: review.frontmatter.id, ...acceptRound(review), draft_key: proposal.draft_key,
      before: Object.fromEntries(proposal.changes.map((change) => [change.field, change.current])), after: Object.fromEntries(proposal.changes.map((change) => [change.field, change.proposed])),
      ...(note ? { append_note: note } : {})
    }, { matchOn: ["review_id", "operation_id"] });
    await ctx.rebuildIndex();
    return updated;
  }

  updateReviewTitle(reviewId: string, title: string) {
    return this.updateReviewFields(reviewId, { title });
  }

  /**
   * Edits a pending proposal before it is accepted. `null` clears a field. Title, owner, due and priority live in
   * `proposed_fields`; context links are the review's own `primary_*_id` fields, which acceptance already carries over.
   */
  async updateReviewFields(reviewId: string, changes: ReviewEdits) {
    const { ctx } = this;
    const review = ctx.required(reviewId, "review-item");
    if (review.frontmatter.status !== "pending") throw new Error("Only pending review items can be edited");
    if (review.frontmatter.review_type === "update") throw new Error("A proposed change cannot be renamed; accept or reject it");
    const target = String(review.frontmatter.target_object_type);
    // Only create proposals have fields to edit; other review types (link-resolution, …) keep just the title.
    const allowed = review.frontmatter.review_type === "create" ? editableFields[target] ?? ["title"] : ["title"];
    const proposed = { ...review.frontmatter.proposed_fields as Record<string, unknown> };
    const links: Record<string, unknown> = {};
    const issues: string[] = [];
    // Not isLive on purpose: the owner is given by ID, and an explicit ID reaches an archived person (#118).
    const reachable = (id: string, type: string) => { const object = ctx.index.get(id); return object && object.frontmatter.type === type && !object.frontmatter.deleted_at; };
    for (const [key, value] of Object.entries(changes)) {
      if (!allEditable.has(key)) { issues.push(`${key}: cannot be edited`); continue; }
      if (!allowed.includes(key)) { issues.push(`${key}: cannot be edited on a ${target}`); continue; }
      if (value !== null && typeof value !== "string") { issues.push(`${key}: must be text or null`); continue; }
      const clean = value?.trim();
      if (key === "title") { if (clean) proposed.title = clean; else issues.push("title: Proposal title is required"); }
      else if (key === "owner_person_id") { if (!clean) delete proposed.owner_person_id; else if (reachable(clean, "person")) proposed.owner_person_id = clean; else issues.push(`owner_person_id: ${clean} is not a person`); }
      else if (key === "priority") {
        const match = ["High", "Medium", "Low"].find((candidate) => candidate.toLowerCase() === clean?.toLowerCase());
        if (!clean) delete proposed.priority; else if (match) proposed.priority = match; else issues.push(`priority: unknown priority "${clean}" (expected High, Medium or Low)`);
      } else if (key === "due_on") {
        if (!clean) delete proposed.due_on;
        else if (isCalendarDate(clean)) { proposed.due_on = clean; delete proposed.due_at; delete proposed.due_timezone; } else issues.push(`due_on: not a calendar date YYYY-MM-DD ("${clean}")`);
      } else if (key === "due_at") {
        const dueAt = clean?.includes("T") ? toUtc(clean) : undefined;
        if (!clean) { delete proposed.due_at; delete proposed.due_timezone; }
        else if (dueAt) { proposed.due_at = dueAt; proposed.due_timezone = proposed.due_timezone ?? "UTC"; delete proposed.due_on; } else issues.push(`due_at: not an ISO 8601 date-time with Z or an offset ("${clean}")`);
      } else if (key === "due_timezone") {
        if (clean && !validTimeZone(clean)) issues.push(`due_timezone: unknown time zone "${clean}"`);
        else if (clean) proposed.due_timezone = clean;
      } else {
        const type = key.replace(/^primary_|_id$/g, "");
        if (!clean) links[key] = undefined; else if (reachable(clean, type)) links[key] = clean; else issues.push(`${key}: ${clean} is not a ${type}`);
      }
    }
    if (proposed.due_timezone !== undefined && proposed.due_at === undefined) delete proposed.due_timezone;
    if (issues.length) throw new Error(issues.join("; "));
    const title = String(proposed.title ?? review.frontmatter.title);
    const titleChanged = title !== review.frontmatter.title;
    const now = new Date().toISOString();
    // A name the adopter could not resolve is settled once the user sets (or clears) the field it was meant for.
    const settled: Record<string, string> = { owner_person_id: "owner", primary_project_id: "project", primary_client_id: "client", primary_product_id: "product" };
    const edited = new Set(Object.keys(changes).map((key) => settled[key]).filter(Boolean));
    const pendingNames = Array.isArray(review.frontmatter.unresolved_references) ? (review.frontmatter.unresolved_references as Array<{ field?: string }>) : undefined;
    const remaining = pendingNames && edited.size ? { unresolved_references: pendingNames.filter((entry) => !edited.has(String(entry.field))) } : {};
    const updated = await ctx.update(review, { title, proposed_fields: proposed, ...links, ...remaining }, { expectedHash: review.contentHash, now, ...(titleChanged ? { body: proposalBody(title, target === "knowledge-note" ? undefined : proposed.body) } : {}) });
    await ctx.rebuildIndex();
    return updated;
  }

  /**
   * Evidence per proposed field, with each source looked up now: a source that is missing (never matched, deleted,
   * or a hand-edited ID) is returned with `resolved: false` rather than failing the review.
   */
  reviewEvidence(reviewId: string): Record<string, ReviewEvidence[]> {
    const review = this.ctx.required(reviewId, "review-item");
    const raw = review.frontmatter.field_evidence;
    const result: Record<string, ReviewEvidence[]> = {};
    if (!raw || typeof raw !== "object") return result;
    const textOf = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : undefined;
    for (const [field, entries] of Object.entries(raw as Record<string, unknown>)) {
      result[field] = (Array.isArray(entries) ? entries : []).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object").map((entry) => {
        const sourceId = textOf(entry.source_id);
        const source = sourceId ? this.ctx.index.get(sourceId) : undefined;
        const resolved = !!source && isLive(source);
        const view: ReviewEvidence = { field, resolved };
        if (sourceId) view.source_id = sourceId;
        for (const key of ["source_ref", "fragment_id", "locator", "quote"] as const) { const value = textOf(entry[key]); if (value !== undefined) view[key] = value; }
        if (resolved) { view.source_title = source.frontmatter.title; view.source_type = source.frontmatter.type; }
        return view;
      });
    }
    return result;
  }

  rejectReviewItem(reviewId: string) {
    return this.serialise(reviewId, () => this.reject(reviewId));
  }

  private async reject(reviewId: string) {
    const { ctx } = this;
    const review = ctx.required(reviewId, "review-item");
    if (review.frontmatter.status === "rejected") return review;
    if (review.frontmatter.status !== "pending") throw new Error("Only pending review items can be rejected");
    // #82: an accept that started but did not finish is undone first (#56). The reject is journalled before the first
    // rollback write, so a crash part-way through is finished as a reject by recovery, never as the accept.
    const rejecting = await this.openReject(reviewId) ?? (await this.openAccept(review) ? await ctx.objects.prepareOperation?.(operationKinds.rejectReview, { reviewId }, uuidV7()) : undefined);
    if (rejecting) { await this.finishReject(rejecting); return ctx.required(reviewId, "review-item"); }
    const now = new Date().toISOString();
    const updated = await ctx.update(review, { status: "rejected", reviewed_at: now }, { expectedHash: review.contentHash, now });
    await ctx.writeAudit("review.rejected", reviewId, now, {});
    await ctx.rebuildIndex();
    return updated;
  }

  /**
   * #82: finishes a journalled reject: rolls back the item's unfinished accept, marks it rejected and closes the reject.
   * Every step is replay-safe, so the user retrying, or startup recovery, runs it again from the start.
   */
  private async finishReject(operation: Operation) {
    const { ctx } = this;
    await ctx.rebuildIndex();
    const reviewId = String(operation.payload.reviewId);
    const review = ctx.index.get(reviewId);
    if (review?.frontmatter.type !== "review-item") { await ctx.objects.completeOperation?.(operation.id); return; }
    await this.abandonOperation(review);
    const latest = ctx.required(reviewId, "review-item");
    const now = new Date().toISOString();
    if (latest.frontmatter.status === "pending") await ctx.update(latest, { status: "rejected", reviewed_at: now }, { expectedHash: latest.contentHash, now });
    await ctx.writeAuditOnce("review.rejected", reviewId, now, { operation_id: operation.id }, { matchOn: ["operation_id"] });
    await ctx.objects.completeOperation?.(operation.id);
    await ctx.rebuildIndex();
  }

  /**
   * ADR 0025: undoes the user's accept or reject. The item goes back to pending. Undoing an accept also takes back what it did:
   * a `create` item's object is soft-deleted (refused, 409, when it was edited since: revision no longer 1, the same rule as
   * `abandonCreate`); a Merge restores both People and every re-pointed file from the record the merge kept (#242); a link
   * item puts the field back; an `update` item reverts its fields (Patch undo's rule). Keep separate goes back to pending.
   * A refusal writes nothing. Idempotent: an item that is already pending is returned as it is. Journalled as an
   * `undo-review` intent (ADR 0013), whose `revert` holds what to put back.
   */
  undoReviewAction(reviewId: string): Promise<ReviewUndoResult> {
    return this.serialise(reviewId, async () => {
      const { ctx } = this;
      // A retry of an undo a failure interrupted finishes that undo (its intent is already recorded).
      const open = await this.openUndo(reviewId);
      if (open) return this.finishUndo(open);
      const review = ctx.required(reviewId, "review-item");
      const status = review.frontmatter.status;
      if (status === "pending") return { review, outcome: "already-pending" };
      if (status !== "accepted" && status !== "rejected") throw new ObjectConflictError(`Cannot undo: this item is ${String(status)}; only accepted or rejected items can be undone.`);
      const type = typeof review.frontmatter.review_type === "string" ? review.frontmatter.review_type : undefined;
      if (!isReviewActionUndoable(type, status)) throw new ObjectConflictError(notYetUndoable);
      const plan = this.undoPlan(review, type ?? "create", status);
      const operation = await ctx.objects.prepareOperation?.(operationKinds.undoReview, { reviewId, undoes: status, ...(plan.created ? { objectId: plan.created.frontmatter.id } : {}), ...(plan.revert ? { revert: plan.revert } : {}), nextOperationId: uuidV7() }, uuidV7());
      if (!operation) throw new Error("The object store cannot journal an undo");
      return this.finishUndo(operation);
    });
  }

  /** What undoing this decision puts back, or the refusal (nothing is written). */
  private undoPlan(review: LifeOSObject, type: string, status: "accepted" | "rejected"): { created?: LifeOSObject; revert?: Record<string, unknown> } {
    if (type === personMergeReviewType) {
      if (status === "rejected") { this.merges.checkKeepSeparateUndo(review); return {}; }
      return { revert: { kind: "merge", acceptOperationId: this.merges.checkUndo(review) } };
    }
    if (status === "rejected") return {};
    if (type === "link-resolution") return { revert: planLinkRevert(this.ctx, review) };
    if (type === "update") return { revert: planUpdateRevert(this.ctx, review) };
    const created = this.createdObject(review);
    if (created && !created.frontmatter.deleted_at && created.frontmatter.revision !== 1) throw new ObjectConflictError(this.editedSince(created));
    return { created };
  }

  /** The object an accept created for this item, if it is still on disk. */
  private createdObject(review: LifeOSObject) {
    const id = review.frontmatter.resolved_object_id;
    return typeof id === "string" ? this.ctx.index.get(id) : undefined;
  }

  private editedSince(created: LifeOSObject) {
    return `Cannot undo: "${created.frontmatter.title}" was changed after it was accepted (revision ${created.frontmatter.revision}). Open it to change or delete it yourself.`;
  }

  /**
   * Finishes a journalled undo. Every step is replay-safe: the object is deleted only while live, the item leaves its
   * decided state only while decided, the audit is written once, and the item gets a fresh accept-operation ID from the
   * journal so accepting it again creates a new object instead of finding the deleted one.
   */
  private async finishUndo(operation: Operation): Promise<ReviewUndoResult> {
    const { ctx } = this;
    await ctx.rebuildIndex();
    const reviewId = String(operation.payload.reviewId);
    const review = ctx.index.get(reviewId);
    if (review?.frontmatter.type !== "review-item") { await ctx.objects.completeOperation?.(operation.id); throw new ObjectConflictError(`Review item not found: ${reviewId}`); }
    const objectId = typeof operation.payload.objectId === "string" ? operation.payload.objectId : undefined;
    const created = objectId ? ctx.index.get(objectId) : undefined;
    const now = new Date().toISOString();
    let deletedObjectId: string | undefined;
    if (created && !created.frontmatter.deleted_at) {
      if (created.frontmatter.revision !== 1) {
        // Edited between the intent and now (or the app was restarted into a state the user changed): nothing was lost, so the undo is dropped.
        await ctx.objects.completeOperation?.(operation.id);
        throw new ObjectConflictError(this.editedSince(created));
      }
      await ctx.update(created, { deleted_at: now }, { expectedHash: created.contentHash, now });
      deletedObjectId = created.frontmatter.id;
    }
    const revert = operation.payload.revert as Record<string, unknown> | undefined;
    let reverted: Reverted | undefined;
    if (revert) {
      try { reverted = await this.revert(revert, now); }
      catch (error) {
        // Something it would put back was changed between the intent and now: the undo is dropped (a merge left whole again).
        if (error instanceof ObjectConflictError) await ctx.objects.completeOperation?.(operation.id);
        throw error;
      }
      await ctx.rebuildIndex();
    }
    const latest = ctx.required(reviewId, "review-item");
    if (latest.frontmatter.status === "accepted" || latest.frontmatter.status === "rejected") {
      const nextOperationId = typeof operation.payload.nextOperationId === "string" ? operation.payload.nextOperationId : uuidV7();
      // The undo records of link and update accepts go with the decision they described.
      // An `update` item is guarded by the target's revision and hash: both move to the target as the undo left it, so it can be applied again.
      const rebased = revert?.kind === "update" ? rebasedProposal(ctx, latest, revert) : undefined;
      await ctx.update(latest, { status: "pending", reviewed_at: undefined, resolved_object_id: undefined, chosen_object_id: undefined, link_undo: undefined, applied_append: undefined, operation_id: nextOperationId, ...(rebased ? { proposed_fields: rebased } : {}) }, { expectedHash: latest.contentHash, now });
    }
    await ctx.writeAuditOnce("review.undone", reviewId, now, {
      operation_id: operation.id, review_id: reviewId, undone: String(operation.payload.undoes),
      ...(objectId ? { deleted_object_id: objectId } : {}),
      ...(reverted ? { reverted_object_ids: reverted.ids, ...reverted.audit } : {})
    }, { matchOn: ["operation_id"] });
    await ctx.objects.completeOperation?.(operation.id);
    await ctx.rebuildIndex();
    return { review: ctx.required(reviewId, "review-item"), outcome: "undone", ...(deletedObjectId ? { deletedObjectId } : {}), ...(reverted ? { revertedObjectIds: reverted.ids } : {}) };
  }

  /** Puts back what an accept changed beyond creating an object: a merge, a link or an `update`. Replay-safe; see `undoMerge` and `applyRevert`. */
  private async revert(revert: Record<string, unknown>, now: string): Promise<Reverted> {
    if (revert.kind === "merge") {
      const merged = await this.merges.undoMerge(String(revert.acceptOperationId));
      return { ids: merged.restoredIds, audit: { restored_person_id: merged.restoredPersonId, kept_person_id: merged.keptPersonId } };
    }
    return { ids: await applyRevert(this.ctx, revert, now), audit: {} };
  }

  /** The open (journalled, not finished) undo of a Review Item, if any. */
  private async openUndo(reviewId: string) {
    return (await this.ctx.objects.incompleteOperations?.())?.find((operation) => operation.kind === operationKinds.undoReview && operation.payload.reviewId === reviewId);
  }

  /** Startup recovery of an `undo-review` operation: the undo is finished, or dropped when the object was edited meanwhile. */
  recoverUndo(operation: Operation) {
    return this.serialise(String(operation.payload.reviewId), () => this.finishUndo(operation).then(() => undefined, (error: unknown) => { if (!(error instanceof ObjectConflictError)) throw error; }));
  }

  /** The open (journalled, not finished) reject of a Review Item, if any (#82). */
  private async openReject(reviewId: string) {
    return (await this.ctx.objects.incompleteOperations?.())?.find((operation) => operation.kind === operationKinds.rejectReview && operation.payload.reviewId === reviewId);
  }

  /** The Review Item's unfinished accept operation, if any. */
  private async openAccept(review: LifeOSObject) {
    const operationId = review.frontmatter.operation_id;
    if (typeof operationId !== "string") return undefined;
    return (await this.ctx.objects.incompleteOperations?.())?.find((candidate) => candidate.id === operationId);
  }

  /** Startup recovery of a `reject-review` operation (#82): the reject is finished. */
  recoverReject(operation: Operation) {
    const reviewId = String(operation.payload.reviewId);
    return this.serialise(reviewId, () => this.finishReject(operation));
  }

  /**
   * Startup recovery of an `accept-review` operation (#56): finishes it while the item is pending or accepted,
   * and undoes it when the user rejected the item meanwhile (or the item is gone), so recovery never fails on it.
   * #82: a recorded reject intent wins, so the accept is never finished for an item the user chose to reject.
   */
  recoverAccept(operation: Operation) {
    const reviewId = String(operation.payload.reviewId);
    return this.serialise(reviewId, async () => {
      const rejecting = await this.openReject(reviewId);
      if (rejecting) { await this.finishReject(rejecting); return; }
      const review = this.ctx.index.get(reviewId);
      if (review?.frontmatter.type === "review-item" && (review.frontmatter.status === "pending" || review.frontmatter.status === "accepted")) {
        await this.accept(review.frontmatter.id);
      } else if (review?.frontmatter.type === "review-item") await this.abandonCreate(review, operation);
      else await this.ctx.objects.completeOperation?.(operation.id);
    });
  }

  /** Startup recovery of a `merge-person` operation: as `recoverAccept`, a recorded reject intent wins (#82). */
  recoverMerge(operation: Operation) {
    const reviewId = String(operation.payload.reviewId);
    return this.serialise(reviewId, async () => {
      const rejecting = await this.openReject(reviewId);
      if (rejecting) await this.finishReject(rejecting);
      else await this.merges.recover(operation);
    });
  }

  /** Undoes and closes the unfinished operation of a Review Item, if it has one. */
  private async abandonOperation(review: LifeOSObject) {
    const operation = await this.openAccept(review);
    if (operation?.kind === operationKinds.mergePerson) await this.merges.abandon(review, operation);
    else if (operation?.kind === operationKinds.acceptReview) await this.abandonCreate(review, operation);
  }

  /**
   * A create-accept that stopped after writing its object: the object is soft-deleted (restorable) unless the
   * user has edited it since, in which case it is kept as theirs. Then the operation is closed.
   */
  private async abandonCreate(review: LifeOSObject, operation: Operation) {
    const { ctx } = this;
    await ctx.rebuildIndex();
    const objectId = typeof operation.payload.objectId === "string" ? operation.payload.objectId : undefined;
    const created = objectId ? ctx.index.get(objectId) : undefined;
    const now = new Date().toISOString();
    const remove = !!created && !created.frontmatter.deleted_at && created.frontmatter.revision === 1;
    if (remove) await ctx.update(created, { deleted_at: now }, { expectedHash: created.contentHash, now });
    await ctx.writeAuditOnce("review.accept-rolled-back", review.frontmatter.id, now, { operation_id: operation.id, ...(remove ? { deleted_object_id: objectId } : {}) }, { matchOn: ["operation_id"] });
    await ctx.objects.completeOperation?.(operation.id);
    await ctx.rebuildIndex();
  }
}

/** What `undoReviewAction` did: `already-pending` when there was nothing to undo; `deletedObjectId` when an accept's object was deleted; `revertedObjectIds` when a merge, link or change was put back. */
export interface ReviewUndoResult { review: LifeOSObject; outcome: "undone" | "already-pending"; deletedObjectId?: string; revertedObjectIds?: string[] }
/** What an undo put back besides the item: the objects written, and the audit fields that say what they were. */
interface Reverted { ids: string[]; audit: Record<string, unknown> }

/** Fields the user may change on a pending proposal; `null` clears one. */
export type ReviewEdits = Partial<Record<"title" | "owner_person_id" | "due_on" | "due_at" | "due_timezone" | "priority" | "primary_project_id" | "primary_client_id" | "primary_product_id", string | null>>;
const editableFields: Record<string, string[]> = {
  task: ["title", "owner_person_id", "due_on", "due_at", "due_timezone", "priority", ...contextLinkFields],
  decision: ["title", ...contextLinkFields],
  "open-point": ["title", "owner_person_id", ...contextLinkFields]
};
const allEditable = new Set(Object.values(editableFields).flat());

/** One evidence reference as the Review screen shows it. */
export interface ReviewEvidence {
  field: string;
  resolved: boolean;
  source_id?: string;
  source_ref?: string;
  source_title?: string;
  source_type?: string;
  fragment_id?: string;
  locator?: string;
  quote?: string;
}
