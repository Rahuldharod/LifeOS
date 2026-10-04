import { originOf, uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { isCalendarDate, proposalBody, toUtc } from "./adoption.js";
import { markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { acceptSummary, summaryReviewType } from "./meeting-material.js";
import type { MeetingsModule } from "./meetings.js";
import { appendedText, type UpdateProposal } from "./patches.js";
import { PersonMergeModule, personMergeOperation, personMergeReviewType } from "./person-merge.js";
import { contextLinkFields, inheritContextLinks, sameValue, validTimeZone } from "./support.js";


/** Review Items: proposing them from a meeting, editing, accepting and rejecting. */
export class ReviewModule {
  /** `person-merge` Review Items (#40): suggesting, accepting and recovering merges. */
  readonly merges: PersonMergeModule;
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule) { this.merges = new PersonMergeModule(ctx); }

  reviews() {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "review-item");
  }

  async processMeeting(meetingId: string) {
    const { ctx } = this;
    if (!ctx.ai) throw new Error("AI provider is not configured");
    const workspace = await this.meetings.meetingWorkspace(meetingId);
    if (!workspace.note) throw new Error("Meeting has no canonical note");
    const pending = workspace.reviews.filter((review) => review.frontmatter.status === "pending");
    if (pending.length) return pending;
    const proposals = await ctx.ai.proposeMeetingOutputs(workspace.note.body);
    const now = new Date().toISOString();
    const agentRunId = uuidV7();
    await ctx.objects.write({
      relativePath: `agent-runs/${markdownFileName("Process meeting", agentRunId, now)}`,
      frontmatter: { ...ctx.envelope(agentRunId, "agent-run", "Process meeting", now), operation: "meeting-extraction", provider: "mock", model: "deterministic-mock", prompt_version: "1", status: "succeeded", started_at: now, completed_at: now, input_summary: workspace.note.frontmatter.title, output_summary: `${proposals.length} proposals`, related_object_ids: [meetingId, workspace.note.frontmatter.id] },
      body: `# Agent run\n\nProcessed ${workspace.note.frontmatter.title}.\n`
    });
    const created: LifeOSObject[] = [];
    for (const proposal of proposals) {
      const id = uuidV7();
      created.push(await ctx.objects.write({
        relativePath: `review-items/${markdownFileName(proposal.title, id, now)}`,
        frontmatter: {
          ...ctx.envelope(id, "review-item", proposal.title, now),
          review_type: "create",
          target_object_type: proposal.type,
          proposed_fields: { title: proposal.title, status: "Inbox" },
          confidence_label: proposal.confidence,
          field_evidence: {},
          status: "pending",
          agent_run_id: agentRunId,
          source_meeting_id: meetingId,
          source_ids: [workspace.note.frontmatter.id],
          ...inheritContextLinks(workspace.meeting),
          operation_id: uuidV7()
        },
        body: `# Proposal\n\n${proposal.title}\n`
      }));
    }
    await ctx.rebuildIndex();
    return created;
  }

  /** `linkTo` is the object chosen for a `link-resolution` item; other review types ignore it. */
  async acceptReviewItem(reviewId: string, options: { linkTo?: string } = {}) {
    const { ctx } = this;
    const review = ctx.required(reviewId, "review-item");
    if (review.frontmatter.review_type === personMergeReviewType) return this.merges.accept(review);
    if (review.frontmatter.review_type === "link-resolution") return this.acceptLinkResolution(review, options.linkTo);
    if (review.frontmatter.review_type === "update") return this.acceptUpdate(review);
    if (review.frontmatter.review_type === summaryReviewType) return acceptSummary(ctx, review);
    if (review.frontmatter.status === "accepted" && typeof review.frontmatter.resolved_object_id === "string") {
      if (typeof review.frontmatter.operation_id === "string") await ctx.objects.completeOperation?.(review.frontmatter.operation_id);
      return ctx.required(review.frontmatter.resolved_object_id);
    }
    if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");
    const now = new Date().toISOString();
    const owner = await ctx.ensureSelfPerson(now);
    const requestedOperationId = typeof review.frontmatter.operation_id === "string" ? review.frontmatter.operation_id : uuidV7();
    const operation = await ctx.objects.prepareOperation?.("accept-review", { reviewId, objectId: uuidV7() }, requestedOperationId);
    const objectId = typeof operation?.payload.objectId === "string" ? operation.payload.objectId : uuidV7();
    const proposed = review.frontmatter.proposed_fields as Record<string, unknown>;
    const title = typeof proposed.title === "string" ? proposed.title : review.frontmatter.title;
    const targetType = String(review.frontmatter.target_object_type);
    const folder = targetType === "task" ? "tasks" : targetType === "decision" ? "decisions" : targetType === "open-point" ? "open-points" : targetType === "knowledge-note" ? "knowledge" : undefined;
    if (!folder) throw new Error(`Unsupported review target: ${targetType}`);
    // Proposed fields carried over as they stand after the user's edits.
    const pick = (keys: string[]) => Object.fromEntries(keys.filter((key) => proposed[key] !== undefined).map((key) => [key, proposed[key]]));
    const extras = pick(["area", "sensitivity", "subjects", "tags", "captured_at", "people_ids"]);
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
    await ctx.writeAudit("review.accepted", objectId, now, { review_id: reviewId });
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
    const candidates = proposed.candidates ?? [];
    const chosenId = linkTo ?? (candidates.length === 1 ? candidates[0]!.id : undefined);
    if (!chosenId) throw new Error(`Choose the ${proposed.candidate_type} to link`);
    const chosen = ctx.index.get(chosenId);
    if (!chosen || chosen.frontmatter.type !== proposed.candidate_type || chosen.frontmatter.deleted_at) throw new Error(`Choose an existing ${proposed.candidate_type} to link`);
    const target = ctx.required(targetId);
    if (target.frontmatter.deleted_at) throw new Error("The object to link was deleted");
    const current = target.frontmatter[proposed.link_field];
    const value = proposed.list ? [...(Array.isArray(current) ? current as string[] : []).filter((id) => id !== chosenId), chosenId] : chosenId;
    const now = new Date().toISOString();
    const unchanged = proposed.list ? Array.isArray(current) && current.includes(chosenId) : current === chosenId;
    const updated = unchanged ? target : await ctx.update(target, { [proposed.link_field]: value }, { expectedHash: target.contentHash, now });
    await ctx.update(review, { status: "accepted", reviewed_at: now, resolved_object_id: targetId, chosen_object_id: chosenId }, { expectedHash: review.contentHash, now });
    await ctx.writeAudit("review.accepted", targetId, now, { review_id: review.frontmatter.id, link_field: proposed.link_field, linked_object_id: chosenId });
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
    if (target.frontmatter.deleted_at) throw new Error("The object to change was deleted");
    const note = proposal.append_note;
    const landed = target.frontmatter.revision === proposal.base_revision + 1 && proposal.changes.every((change) => sameValue(target.frontmatter[change.field], change.proposed)) && (!note || target.body.endsWith(`\n${note}\n`));
    const now = new Date().toISOString();
    let updated = target;
    if (!landed) {
      if (target.frontmatter.revision !== proposal.base_revision || target.contentHash !== proposal.base_hash) {
        throw new ObjectConflictError(`${target.frontmatter.title} changed since this review item was raised (revision ${proposal.base_revision}, now ${target.frontmatter.revision}); reject it and send the change again`);
      }
      const changes = Object.fromEntries(proposal.changes.map((change) => [change.field, change.proposed ?? undefined]));
      updated = await ctx.update(target, changes, { expectedHash: proposal.base_hash, now, ...(note ? { body: target.body + appendedText(target.body, note) } : {}) });
    }
    await ctx.update(review, { status: "accepted", reviewed_at: now, resolved_object_id: targetId }, { expectedHash: review.contentHash, now });
    await ctx.writeAudit("review.accepted", targetId, now, {
      review_id: review.frontmatter.id, draft_key: proposal.draft_key,
      before: Object.fromEntries(proposal.changes.map((change) => [change.field, change.current])), after: Object.fromEntries(proposal.changes.map((change) => [change.field, change.proposed])),
      ...(note ? { append_note: note } : {})
    });
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
    const live = (id: string, type: string) => { const object = ctx.index.get(id); return object && object.frontmatter.type === type && !object.frontmatter.deleted_at; };
    for (const [key, value] of Object.entries(changes)) {
      if (!allEditable.has(key)) { issues.push(`${key}: cannot be edited`); continue; }
      if (!allowed.includes(key)) { issues.push(`${key}: cannot be edited on a ${target}`); continue; }
      if (value !== null && typeof value !== "string") { issues.push(`${key}: must be text or null`); continue; }
      const clean = value?.trim();
      if (key === "title") { if (clean) proposed.title = clean; else issues.push("title: Proposal title is required"); }
      else if (key === "owner_person_id") { if (!clean) delete proposed.owner_person_id; else if (live(clean, "person")) proposed.owner_person_id = clean; else issues.push(`owner_person_id: ${clean} is not a person`); }
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
        if (!clean) links[key] = undefined; else if (live(clean, type)) links[key] = clean; else issues.push(`${key}: ${clean} is not a ${type}`);
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
        const resolved = !!source && !source.frontmatter.deleted_at;
        const view: ReviewEvidence = { field, resolved };
        if (sourceId) view.source_id = sourceId;
        for (const key of ["source_ref", "fragment_id", "locator", "quote"] as const) { const value = textOf(entry[key]); if (value !== undefined) view[key] = value; }
        if (resolved) { view.source_title = source.frontmatter.title; view.source_type = source.frontmatter.type; }
        return view;
      });
    }
    return result;
  }

  async rejectReviewItem(reviewId: string) {
    const review = this.ctx.required(reviewId, "review-item");
    if (review.frontmatter.status === "rejected") return review;
    if (review.frontmatter.status !== "pending") throw new Error("Only pending review items can be rejected");
    // #56: an accept that started but did not finish is undone first, so nothing is left half done.
    await this.abandonOperation(review);
    const latest = this.ctx.required(reviewId, "review-item");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(latest, { status: "rejected", reviewed_at: now }, { expectedHash: latest.contentHash, now });
    await this.ctx.writeAudit("review.rejected", reviewId, now, {});
    await this.ctx.rebuildIndex();
    return updated;
  }

  /**
   * Startup recovery of an `accept-review` operation (#56): finishes it while the item is pending or accepted,
   * and undoes it when the user rejected the item meanwhile (or the item is gone), so recovery never fails on it.
   */
  async recoverAccept(operation: Operation) {
    const review = this.ctx.index.get(String(operation.payload.reviewId));
    if (review?.frontmatter.type === "review-item" && (review.frontmatter.status === "pending" || review.frontmatter.status === "accepted")) {
      await this.acceptReviewItem(review.frontmatter.id);
    } else if (review?.frontmatter.type === "review-item") await this.abandonCreate(review, operation);
    else await this.ctx.objects.completeOperation?.(operation.id);
  }

  /** Undoes and closes the unfinished operation of a Review Item, if it has one. */
  private async abandonOperation(review: LifeOSObject) {
    const operationId = review.frontmatter.operation_id;
    if (typeof operationId !== "string") return;
    const operation = (await this.ctx.objects.incompleteOperations?.())?.find((candidate) => candidate.id === operationId);
    if (operation?.kind === personMergeOperation) await this.merges.abandon(review, operation);
    else if (operation?.kind === "accept-review") await this.abandonCreate(review, operation);
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
    await ctx.writeAudit("review.accept-rolled-back", review.frontmatter.id, now, { operation_id: operation.id, ...(remove ? { deleted_object_id: objectId } : {}) });
    await ctx.objects.completeOperation?.(operation.id);
    await ctx.rebuildIndex();
  }
}

type Operation = { id: string; kind: string; payload: Record<string, unknown> };

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
