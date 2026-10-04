import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import type { MeetingsModule } from "./meetings.js";

/** Review Items: proposing them from a meeting, editing, accepting and rejecting. */
export class ReviewModule {
  constructor(private readonly ctx: AppContext, private readonly meetings: MeetingsModule) {}

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
          primary_client_id: workspace.meeting.frontmatter.primary_client_id,
          primary_product_id: workspace.meeting.frontmatter.primary_product_id,
          primary_project_id: workspace.meeting.frontmatter.primary_project_id,
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
    if (review.frontmatter.review_type === "link-resolution") return this.acceptLinkResolution(review, options.linkTo);
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
    const proposed = review.frontmatter.proposed_fields as { title?: string; status?: string; body?: string };
    const title = proposed.title ?? review.frontmatter.title;
    const targetType = String(review.frontmatter.target_object_type);
    const folder = targetType === "task" ? "tasks" : targetType === "decision" ? "decisions" : targetType === "open-point" ? "open-points" : targetType === "knowledge-note" ? "knowledge" : undefined;
    if (!folder) throw new Error(`Unsupported review target: ${targetType}`);
    const common = { source_meeting_id: review.frontmatter.source_meeting_id, source_ids: review.frontmatter.source_ids ?? [], primary_client_id: review.frontmatter.primary_client_id, primary_product_id: review.frontmatter.primary_product_id, primary_project_id: review.frontmatter.primary_project_id };
    const fields = targetType === "task"
      ? { status: proposed.status ?? "Inbox", owner_person_id: owner.frontmatter.id, ...common }
      : targetType === "decision"
        ? { status: "active", decision_text: title, decided_at: now, ...common }
        : targetType === "open-point"
          ? { status: "open", owner_person_id: owner.frontmatter.id, ...common }
          : { source_ids: review.frontmatter.source_ids ?? [], related_object_ids: [] };
    const created = ctx.index.get(objectId) ?? await ctx.objects.write({ relativePath: `${folder}/${markdownFileName(title, objectId, now)}`, frontmatter: { ...ctx.envelope(objectId, targetType as ObjectEnvelope["type"], title, now), ...fields }, body: targetType === "knowledge-note" && typeof proposed.body === "string" ? proposed.body : `# ${title}\n` });
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

  async updateReviewTitle(reviewId: string, title: string) {
    const review = this.ctx.required(reviewId, "review-item");
    if (review.frontmatter.status !== "pending") throw new Error("Only pending review items can be edited");
    const nextTitle = title.trim();
    if (!nextTitle) throw new Error("Proposal title is required");
    const now = new Date().toISOString();
    const proposed = review.frontmatter.proposed_fields as Record<string, unknown>;
    const updated = await this.ctx.update(review, { title: nextTitle, proposed_fields: { ...proposed, title: nextTitle } }, { expectedHash: review.contentHash, now, body: `# Proposal\n\n${nextTitle}\n` });
    await this.ctx.rebuildIndex();
    return updated;
  }

  async rejectReviewItem(reviewId: string) {
    const review = this.ctx.required(reviewId, "review-item");
    if (review.frontmatter.status === "rejected") return review;
    if (review.frontmatter.status !== "pending") throw new Error("Only pending review items can be rejected");
    const now = new Date().toISOString();
    const updated = await this.ctx.update(review, { status: "rejected", reviewed_at: now }, { expectedHash: review.contentHash, now });
    await this.ctx.writeAudit("review.rejected", reviewId, now, {});
    await this.ctx.rebuildIndex();
    return updated;
  }
}
