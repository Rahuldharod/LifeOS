import { uuidV7 } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import { isLive } from "./support.js";

/** Quick capture, pasted-text sources and the knowledge notes proposed from them. */
export class CaptureModule {
  constructor(private readonly ctx: AppContext) {}

  async quickCapture(title: string) {
    const { ctx } = this;
    const clean = title.trim();
    if (!clean) throw new Error("Capture text is required");
    const now = new Date().toISOString();
    const owner = await ctx.ensureSelfPerson(now);
    const id = uuidV7();
    const task = await ctx.objects.write({ relativePath: `tasks/${markdownFileName(clean, id, now)}`, frontmatter: { ...ctx.envelope(id, "task", clean, now), status: "Inbox", owner_person_id: owner.frontmatter.id, source_ids: [] }, body: `# ${clean}\n` });
    await ctx.writeAudit("task.quick-captured", id, now, {});
    await ctx.rebuildIndex();
    return task;
  }

  knowledge(query = "") {
    const notes = this.ctx.index.all().filter((object) => object.frontmatter.type === "knowledge-note" && isLive(object));
    const needle = query.trim().toLowerCase();
    return needle ? notes.filter((note) => `${note.frontmatter.title}\n${note.body}`.toLowerCase().includes(needle)) : notes;
  }

  async ingestTextSource(title: string, text: string) {
    const { ctx } = this;
    if (!title.trim() || !text.trim()) throw new Error("Source title and text are required");
    const now = new Date().toISOString();
    const sourceId = uuidV7();
    const fragmentId = "fragment-1";
    const source = await ctx.objects.write({ relativePath: `sources/${markdownFileName(title, sourceId, now)}`, frontmatter: { ...ctx.envelope(sourceId, "source", title.trim(), now), source_type: "pasted-text", captured_at: now, ingestion_status: "captured", fragments: [{ id: fragmentId, text: text.trim(), locator: { kind: "full-text" } }] }, body: `# ${title.trim()}\n\n${text.trim()}\n` });
    // #98: without an AI provider (the live app) this only saves; Claude proposes Knowledge Notes through the skills (ADR 0008).
    if (!ctx.ai?.proposeKnowledgeNote) {
      await ctx.rebuildIndex();
      return source;
    }
    const proposal = await ctx.ai.proposeKnowledgeNote(text);
    const reviewId = uuidV7();
    await ctx.objects.write({ relativePath: `review-items/${markdownFileName(proposal.title, reviewId, now)}`, frontmatter: { ...ctx.envelope(reviewId, "review-item", proposal.title, now), review_type: "create", target_object_type: "knowledge-note", proposed_fields: { title: proposal.title, body: proposal.body }, field_evidence: { title: [{ source_id: sourceId, fragment_id: fragmentId }], body: [{ source_id: sourceId, fragment_id: fragmentId }] }, confidence_label: proposal.confidence, status: "pending", source_ids: [sourceId], operation_id: uuidV7() }, body: `# Knowledge proposal\n\n${proposal.body}` });
    await ctx.rebuildIndex();
    return source;
  }
}
