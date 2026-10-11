import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import { proposeReviewItem, recordAgentRun, seededRun } from "./review-items.js";
import { isLive, replayRoles } from "./support.js";

export type QuickCaptureDetails = {
  primaryProjectId?: string;
  dueOn?: string;
  ownerPersonId?: string;
  sensitivity?: "normal" | "restricted";
};

/** Quick capture, pasted-text sources and the knowledge notes proposed from them. */
export class CaptureModule {
  constructor(private readonly ctx: AppContext) {}

  async quickCapture(text: string, details: QuickCaptureDetails = {}) {
    const { ctx } = this;
    const clean = text.trim();
    if (!clean) throw new Error("Capture text is required");
    const [title = clean, ...bodyLines] = clean.split(/\r?\n/);
    const now = new Date().toISOString();
    const ownerId = details.ownerPersonId ?? (await ctx.ensureSelfPerson(now)).frontmatter.id;
    const id = uuidV7();
    const optional = Object.fromEntries(Object.entries({
      primary_project_id: details.primaryProjectId,
      due_on: details.dueOn,
      sensitivity: details.sensitivity
    }).filter(([, value]) => value !== undefined));
    const body = `# ${title}\n${bodyLines.length ? `\n${bodyLines.join("\n")}\n` : ""}`;
    const task = await ctx.objects.write({ relativePath: `tasks/${markdownFileName(title, id, now)}`, frontmatter: { ...ctx.envelope(id, "task", title, now), status: "Inbox", owner_person_id: ownerId, source_ids: [], ...optional }, body });
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
    const cleanTitle = title.trim(), cleanText = text.trim();
    const fragmentId = "fragment-1";
    // #122: a paste whose proposal is still unfinished or pending (a retry after a crash) reuses its Source, so the
    // proposal replays below. Once the proposal was accepted or rejected, pasting again is deliberate: a new Source.
    const pasted = ctx.ai?.proposeKnowledgeNote ? ctx.index.all().find((object) => object.frontmatter.type === "source" && object.frontmatter.source_type === "pasted-text" && isLive(object) && object.frontmatter.title === cleanTitle && (object.frontmatter.fragments as Array<{ text?: unknown }> | undefined)?.[0]?.text === cleanText && this.proposalOpen(object)) : undefined;
    const now = new Date().toISOString();
    const sourceId = pasted?.frontmatter.id ?? uuidV7();
    const source = pasted ?? await ctx.objects.write({ relativePath: `sources/${markdownFileName(cleanTitle, sourceId, now)}`, frontmatter: { ...ctx.envelope(sourceId, "source", cleanTitle, now), source_type: "pasted-text", captured_at: now, ingestion_status: "captured", fragments: [{ id: fragmentId, text: cleanText, locator: { kind: "full-text" } }] }, body: `# ${cleanTitle}\n\n${cleanText}\n` });
    // #98: without an AI provider (the live app) this only saves; Claude proposes Knowledge Notes through the skills (ADR 0008).
    if (!ctx.ai?.proposeKnowledgeNote) {
      await ctx.rebuildIndex();
      return source;
    }
    const proposal = await ctx.ai.proposeKnowledgeNote(cleanText);
    const run = await recordAgentRun(ctx, proposalRun(ctx, source), {
      operation: "knowledge-proposal", title: "Propose knowledge note", inputSummary: cleanTitle, outputSummary: "1 proposal",
      relatedObjectIds: [sourceId], body: `# Agent run\n\nProposed a knowledge note from ${cleanTitle}.\n`
    });
    const evidence = [{ source_id: sourceId, fragment_id: fragmentId }];
    await proposeReviewItem(ctx, run, {
      role: replayRoles.knowledge, reviewType: "create", title: proposal.title, target: { type: "knowledge-note" },
      proposed: { title: proposal.title, body: proposal.body }, confidence: proposal.confidence, sourceIds: [sourceId],
      evidence: { title: evidence, body: evidence }, body: `# Knowledge proposal\n\n${proposal.body}`
    });
    await ctx.rebuildIndex();
    return source;
  }

  /** Whether the knowledge proposal of a pasted Source is not yet written (an interrupted paste) or still pending. */
  private proposalOpen(source: LifeOSObject) {
    const review = this.ctx.index.get(proposalRun(this.ctx, source).newId(replayRoles.knowledge));
    return !review || review.frontmatter.status === "pending";
  }
}

/** IDs come from the Source (ADR 0013): the proposal for one Source is written once, however often it is retried. */
const proposalRun = (ctx: AppContext, source: LifeOSObject) => seededRun(ctx, `knowledge-proposal:${source.frontmatter.id}`, String(source.frontmatter.captured_at ?? source.frontmatter.created_at));
