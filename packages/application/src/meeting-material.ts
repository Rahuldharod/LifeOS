import { sensitivityOf, uuidV7, type LifeOSObject } from "@lifeos/domain";
import { DraftError, text, toUtc, type AdoptionRun, type ParsedDraft, type ProposeOptions } from "./adoption.js";
import { markdownFileName, type AppContext } from "./context.js";
import { expectedMaterial } from "./enrichment.js";
import type { MeetingsModule } from "./meetings.js";
import { foldName, type ReferenceResolver } from "./resolution.js";

/**
 * Adoption of meeting material (#45, PRD "Enrichment Work Orders"). One `meeting-material` draft per meeting,
 * written by the enrichment skill:
 *
 *   meeting: <calendar event ID or meeting ID>   (optional calendar_id)
 *   sources: [{ source_type, url, external_id, occurred_at, provider?, title? }]
 *   proposals: [{ kind, title, confidence, missed_in_notes, evidence, key?, body?, …task/decision fields }]
 *   summary_confidence: High | Medium | Low      (optional, default Medium)
 *   body: the proposed meeting summary (optional)
 *
 * Adoption creates the meeting from the calendar event if needed (never its note), upserts Sources by
 * provider + external ID, raises one `summary` Review Item and create-type Review Items for the proposals
 * (inheriting the meeting's project, client, product and people), then sets `enriched` or `partial`.
 * Re-runs are safe: sources, the summary and proposals (by `key`, else kind + title) are found, not re-added.
 * Restricted meetings are never enriched.
 */

export const summaryReviewType = "summary";
export const materialSourceTypes =[...expectedMaterial, "drive-doc"] as const;
const defaultProvider: Record<string, string> = { "meet-transcript": "google-drive", "meet-recording": "google-drive", "drive-doc": "google-drive", "gong-call": "gong", "gong-summary-email": "gmail" };
const sourceLabels: Record<string, string> = { "meet-transcript": "Meet transcript", "meet-recording": "Meet recording", "drive-doc": "Drive doc", "gong-call": "Gong call", "gong-summary-email": "Gong summary email" };
const proposalKinds = ["task", "decision", "open-point"];
const confidences = ["High", "Medium", "Low"];
/** How far back the calendar is searched for an event that has no meeting yet. */
const eventLookbackMs = 30 * 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One place for every new object and Review Item ID this handler mints. */
/** Every ID this handler writes comes from the run, so a crash and replay rewrites the same files (#32). */
const newId = (run: AdoptionRun) => run.newId();

type Propose = (draft: ParsedDraft, run: AdoptionRun, options: ProposeOptions) => Promise<string[]>;
interface MaterialSource { at: string; sourceType: string; provider: string; externalId: string; url: string; occurredAt: string; title?: string }
interface MaterialProposal { at: string; key: string; missedInNotes: boolean; draft: ParsedDraft }

const isLive = (object: LifeOSObject) => !object.frontmatter.deleted_at && !object.frontmatter.archived_at;
const idList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class MeetingMaterialModule {
  constructor(private readonly ctx: AppContext, private readonly resolver: ReferenceResolver, private readonly propose: Propose, private readonly meetings?: MeetingsModule) {}

  async adopt(draft: ParsedDraft, run: AdoptionRun) {
    const { ctx } = this;
    const { fields } = draft;
    // 1. Which meeting. An existing restricted meeting stops everything before any check reads further.
    const reference = text(fields.meeting);
    if (!reference) throw new DraftError(["meeting: missing; give the calendar event ID (or meeting ID) from the Work Order"]);
    let meeting = this.existingMeeting(reference);
    if (meeting && sensitivityOf(meeting.frontmatter) === "restricted") throw new DraftError([`meeting: ${meeting.frontmatter.id} is restricted; LifeOS does not enrich restricted meetings`]);

    // 2. Every check up front, so a bad draft writes nothing (not even the meeting).
    const issues: string[] = [];
    const sources = this.parseSources(fields.sources, issues);
    const summary = draft.body.trim();
    const summaryConfidence = fields.summary_confidence === undefined ? "Medium" : confidences.find((value) => value.toLowerCase() === text(fields.summary_confidence).toLowerCase());
    if (!summaryConfidence) issues.push(`summary_confidence: unknown confidence "${text(fields.summary_confidence)}" (expected High, Medium or Low)`);
    const proposals = this.parseProposals(draft, issues);
    for (const proposal of proposals) {
      try { await this.propose(proposal.draft, run, { dryRun: true }); }
      catch (error) { if (error instanceof DraftError) issues.push(...error.issues.map((issue) => `${proposal.at}.${issue}`)); else throw error; }
    }
    if (issues.length) throw new DraftError(issues);

    // 3. The meeting from the calendar event if missing; the note is still only created on the first edit.
    const objectIds: string[] = [];
    if (!meeting) {
      if (uuid.test(reference) || !this.meetings) throw new DraftError([`meeting: no LifeOS meeting "${reference}"`]);
      const ensured = await this.meetings.ensureMeetingForEvent(reference, { from: new Date(Date.parse(run.now) - eventLookbackMs), to: new Date(Date.parse(run.now) + 86_400_000), calendarId: text(fields.calendar_id) || undefined, meetingId: newId(run) });
      if (!ensured) throw new DraftError([`meeting: no LifeOS meeting or calendar event "${reference}" in the last 30 days`]);
      meeting = ensured.meeting;
      if (ensured.created) objectIds.push(meeting.frontmatter.id);
    }
    const meetingId = meeting.frontmatter.id;

    // 4. Sources, upserted by provider + external ID.
    const sourceIds: string[] = [];
    const elsewhere: string[] = [];
    for (const source of sources) {
      const linked = await this.upsertSource(source, meeting, draft, run);
      if (!linked) continue;
      sourceIds.push(linked.id);
      if (linked.otherMeeting) elsewhere.push(linked.id);
    }
    objectIds.push(...sourceIds);
    await ctx.rebuildIndex();

    // 5. Summary and proposals, inheriting the meeting's context.
    meeting = ctx.required(meetingId, "meeting");
    if (summary) objectIds.push(await this.upsertSummary(summary, summaryConfidence!, meeting, sourceIds, draft, run));
    // Proposals already raised for this meeting (any status: a rejected one is never proposed again), by key.
    const raised = new Map(this.reviewsFor(meetingId).filter((review) => review.frontmatter.review_type === "create" && typeof review.frontmatter.proposal_key === "string").map((review) => [String(review.frontmatter.proposal_key), review.frontmatter.id]));
    const attendees = idList(meeting.frontmatter.attendee_ids);
    for (const proposal of proposals) {
      const found = raised.get(proposal.key);
      if (found) { objectIds.push(found); continue; }
      // `meeting` makes kindFields inherit the meeting's project, client and product; people default to its attendees.
      const inherited = { ...proposal.draft, fields: { ...proposal.draft.fields, meeting: meetingId, ...(proposal.draft.fields.people === undefined && attendees.length ? { people: attendees } : {}) } };
      const [reviewId] = await this.propose(inherited, run, { newId: () => newId(run), extra: { missed_in_notes: proposal.missedInNotes, proposal_key: proposal.key } });
      raised.set(proposal.key, reviewId!);
      objectIds.push(reviewId!);
    }
    await ctx.rebuildIndex();

    // 6. State: `enriched` when every expected kind of material is now linked, else `partial` (retriable).
    meeting = ctx.required(meetingId, "meeting");
    const listed = idList(meeting.frontmatter.source_ids);
    const extraIds = elsewhere.filter((id) => !listed.includes(id));
    const have = new Set(this.sourcesFor(meeting, [...listed, ...extraIds]).map((source) => String(source.frontmatter.source_type)));
    const missing = expectedMaterial.filter((kind) => !have.has(kind));
    const state = missing.length ? "partial" : "enriched";
    await ctx.update(meeting, { enrichment_state: state, enrichment_missing_material: missing, enrichment_adopted_at: run.now, ...(extraIds.length ? { source_ids: [...listed, ...extraIds] } : {}) }, { expectedHash: meeting.contentHash, now: run.now });
    await ctx.writeAudit("meeting.enrichment-adopted", meetingId, run.now, { from: meeting.frontmatter.enrichment_state ?? "none", to: state, missing_material: missing, draft_key: draft.draftKey, agent_run_id: run.id }, { type: "agent", ref: run.id });
    await ctx.rebuildIndex();
    return [...new Set(objectIds)];
  }

  /** By meeting ID, or by calendar event ID through the shared resolver (duplicates are refused, not picked). */
  private existingMeeting(reference: string) {
    const result = this.resolver.resolve("meeting", reference);
    if (result.status === "ambiguous") throw new DraftError([`meeting: calendar event "${reference}" has ${result.candidates.length} LifeOS meetings (${result.candidates.map((candidate) => candidate.id).join(", ")}); resolve the duplicate first`]);
    return result.status === "resolved" ? this.ctx.required(result.id, "meeting") : undefined;
  }

  private parseSources(value: unknown, issues: string[]) {
    const sources: MaterialSource[] = [];
    if (value === undefined) return sources;
    if (!Array.isArray(value)) { issues.push("sources: must be a list of { source_type, url, external_id, occurred_at } entries"); return sources; }
    const seen = new Set<string>();
    value.forEach((item: unknown, index) => {
      const at = `sources[${index}]`;
      if (!isRecord(item)) { issues.push(`${at}: must be a { source_type, url, external_id, occurred_at } entry`); return; }
      const before = issues.length;
      const sourceType = text(item.source_type);
      if (!sourceType) issues.push(`${at}.source_type: missing`);
      else if (!(materialSourceTypes as readonly string[]).includes(sourceType)) issues.push(`${at}.source_type: unknown source type "${sourceType}" (expected one of ${materialSourceTypes.join(", ")})`);
      const url = text(item.url);
      if (!url) issues.push(`${at}.url: missing`); else if (!/^https?:\/\//i.test(url)) issues.push(`${at}.url: not an http(s) URL ("${url}")`);
      const externalId = text(item.external_id);
      if (!externalId) issues.push(`${at}.external_id: missing`);
      const occurredAt = toUtc(item.occurred_at);
      if (item.occurred_at === undefined) issues.push(`${at}.occurred_at: missing`);
      else if (!occurredAt) issues.push(`${at}.occurred_at: not an ISO 8601 date-time with Z or an offset ("${String(item.occurred_at)}")`);
      if (item.provider !== undefined && !text(item.provider)) issues.push(`${at}.provider: must be text`);
      if (item.title !== undefined && !text(item.title)) issues.push(`${at}.title: must be text`);
      if (issues.length > before) return;
      const provider = text(item.provider) || defaultProvider[sourceType]!;
      // The same material listed twice in one draft is one source.
      if (seen.has(`${provider}\n${externalId}`)) return;
      seen.add(`${provider}\n${externalId}`);
      sources.push({ at, sourceType, provider, externalId, url, occurredAt: occurredAt!, ...(text(item.title) ? { title: text(item.title) } : {}) });
    });
    return sources;
  }

  /** Each proposal becomes an extracted draft of its own kind, checked and written by `proposeExtracted`. */
  private parseProposals(draft: ParsedDraft, issues: string[]) {
    const value = draft.fields.proposals;
    const proposals: MaterialProposal[] = [];
    if (value === undefined) return proposals;
    if (!Array.isArray(value)) { issues.push("proposals: must be a list of { kind, title, confidence, missed_in_notes, evidence } entries"); return proposals; }
    value.forEach((item: unknown, index) => {
      const at = `proposals[${index}]`;
      if (!isRecord(item)) { issues.push(`${at}: must be a { kind, title, confidence, missed_in_notes, evidence } entry`); return; }
      const before = issues.length;
      const kind = text(item.kind);
      if (!proposalKinds.includes(kind)) issues.push(kind ? `${at}.kind: "${kind}" cannot be proposed from meeting material (expected one of ${proposalKinds.join(", ")})` : `${at}.kind: missing`);
      const title = text(item.title);
      if (!title) issues.push(`${at}.title: missing`);
      if (item.missed_in_notes === undefined) issues.push(`${at}.missed_in_notes: missing; say whether the user's notes already cover it (true or false)`);
      else if (typeof item.missed_in_notes !== "boolean") issues.push(`${at}.missed_in_notes: must be true or false`);
      if (item.evidence === undefined || (Array.isArray(item.evidence) && !item.evidence.length)) issues.push(`${at}.evidence: missing; cite at least one source and locator`);
      if (item.key !== undefined && !text(item.key)) issues.push(`${at}.key: must be text`);
      for (const key of ["meeting", "operation_id", "origin", "draft_key"]) if (item[key] !== undefined) issues.push(`${at}.${key}: not allowed on a proposal; it comes from the draft`);
      if (issues.length > before) return;
      const { kind: _kind, title: _title, body, key, missed_in_notes: missedInNotes, ...rest } = item;
      proposals.push({
        at, key: `${kind}:${foldName(text(key) || title)}`, missedInNotes: missedInNotes as boolean,
        draft: { ...draft, kind: kind as ParsedDraft["kind"], title, draftKey: `${draft.draftKey}#${at}`, fields: rest, body: typeof body === "string" ? body : "" }
      });
    });
    return proposals;
  }

  /**
   * The source with this provider + external ID, created if missing and linked to the meeting. A source the
   * user deleted or archived is respected: not recreated, not relinked. A source already linked to another
   * meeting keeps that link and is listed in this meeting's `source_ids` instead.
   */
  private async upsertSource(source: MaterialSource, meeting: LifeOSObject, draft: ParsedDraft, run: AdoptionRun) {
    const { ctx } = this;
    const found = ctx.index.all().find((object) => object.frontmatter.type === "source" && object.frontmatter.provider === source.provider && object.frontmatter.external_id === source.externalId);
    if (found) {
      if (!isLive(found)) return undefined;
      const linkedTo = found.frontmatter.meeting_id;
      if (linkedTo === meeting.frontmatter.id) return { id: found.frontmatter.id, otherMeeting: false };
      if (typeof linkedTo === "string" && ctx.index.get(linkedTo)) return { id: found.frontmatter.id, otherMeeting: true };
      await ctx.update(found, { meeting_id: meeting.frontmatter.id }, { expectedHash: found.contentHash, now: run.now });
      return { id: found.frontmatter.id, otherMeeting: false };
    }
    const id = newId(run);
    const title = source.title ?? `${sourceLabels[source.sourceType]}: ${meeting.frontmatter.title}`;
    await ctx.objects.write({
      relativePath: `sources/${markdownFileName(title, id, run.now)}`,
      frontmatter: {
        ...ctx.envelope(id, "source", title, run.now, "agent-extracted"),
        source_type: source.sourceType, provider: source.provider, external_id: source.externalId, url: source.url,
        occurred_at: source.occurredAt, captured_at: draft.capturedAt, ingestion_status: "captured", meeting_id: meeting.frontmatter.id,
        ...contextLinks(meeting)
      },
      body: `# ${title}\n\n${source.url}\n`
    });
    return { id, otherMeeting: false };
  }

  /**
   * One summary per meeting at a time: the same text is never proposed twice, and a newer text replaces a
   * still-pending proposal rather than adding a second one. After accept or reject, a different text is new.
   */
  private async upsertSummary(summary: string, confidence: string, meeting: LifeOSObject, sourceIds: string[], draft: ParsedDraft, run: AdoptionRun) {
    const { ctx } = this;
    const summaries = this.reviewsFor(meeting.frontmatter.id).filter((review) => review.frontmatter.review_type === summaryReviewType);
    const same = summaries.find((review) => foldName(text((review.frontmatter.proposed_fields as Record<string, unknown>)?.summary)) === foldName(summary));
    if (same) return same.frontmatter.id;
    const title = `Summary: ${meeting.frontmatter.title}`;
    const body = `# ${title}\n\n${summary}\n`;
    const pending = summaries.find((review) => review.frontmatter.status === "pending");
    if (pending) {
      const merged = [...new Set([...idList(pending.frontmatter.source_ids), ...sourceIds])];
      await ctx.update(pending, { proposed_fields: { summary }, confidence_label: confidence, source_ids: merged, agent_run_id: run.id, draft_key: draft.draftKey, captured_at: draft.capturedAt }, { expectedHash: pending.contentHash, now: run.now, body });
      return pending.frontmatter.id;
    }
    const id = newId(run);
    await ctx.objects.write({
      relativePath: `review-items/${markdownFileName(title, id, run.now)}`,
      frontmatter: {
        ...ctx.envelope(id, "review-item", title, run.now, "agent-extracted"),
        review_type: summaryReviewType, target_object_type: "meeting", target_object_id: meeting.frontmatter.id, source_meeting_id: meeting.frontmatter.id,
        proposed_fields: { summary }, field_evidence: {}, confidence_label: confidence as "High" | "Medium" | "Low", status: "pending",
        agent_run_id: run.id, draft_key: draft.draftKey, captured_at: draft.capturedAt, source_ids: sourceIds, ...contextLinks(meeting),
        // U7: generated here, at adoption, never taken from the draft.
        operation_id: newId(run)
      },
      body
    });
    return id;
  }

  private reviewsFor(meetingId: string) {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.source_meeting_id === meetingId);
  }

  /** Live Sources for a meeting: linked by `meeting_id`, or listed in the meeting's or its note's `source_ids` (as #44 counts them). */
  private sourcesFor(meeting: LifeOSObject, listed: string[]) {
    const note = this.ctx.index.all().find((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.meeting_id === meeting.frontmatter.id && !object.frontmatter.deleted_at);
    const ids = new Set([...listed, ...idList(note?.frontmatter.source_ids)]);
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "source" && isLive(object) && (object.frontmatter.meeting_id === meeting.frontmatter.id || ids.has(object.frontmatter.id)));
  }
}

/** A new source carries the meeting's context links, so it shows up under the same project, client and product. */
function contextLinks(meeting: LifeOSObject) {
  return Object.fromEntries(["primary_project_id", "primary_client_id", "primary_product_id"].filter((key) => typeof meeting.frontmatter[key] === "string").map((key) => [key, meeting.frontmatter[key]]));
}

/** Replaces the `## Summary` section of a meeting body (up to the next heading of level 1–2), or appends one. */
export function withSummarySection(body: string, summary: string) {
  const section = `## Summary\n\n${summary.trim()}\n`;
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^##\s+Summary\s*$/i.test(line));
  if (start < 0) return `${body.trimEnd()}\n\n${section}`;
  const nextHeading = lines.findIndex((line, index) => index > start && /^#{1,2}\s/.test(line));
  const after = nextHeading < 0 ? "" : `\n${lines.slice(nextHeading).join("\n")}`;
  return `${lines.slice(0, start).join("\n")}${start ? "\n" : ""}${section}${after}`;
}

/**
 * Accepting a `summary` Review Item writes the Summary section of the MEETING body through a guarded write;
 * the meeting-note body stays the user's own text. Idempotent: an accepted item returns the meeting, and a
 * retry after a crash between the two writes finds the section already in place and writes nothing new.
 */
export async function acceptSummary(ctx: AppContext, review: LifeOSObject) {
  const meetingId = String(review.frontmatter.target_object_id);
  if (review.frontmatter.status === "accepted") return ctx.required(meetingId, "meeting");
  if (review.frontmatter.status !== "pending") throw new Error("Review item is not pending");
  const meeting = ctx.required(meetingId, "meeting");
  if (meeting.frontmatter.deleted_at) throw new Error("The meeting for this summary was deleted");
  const summary = text((review.frontmatter.proposed_fields as Record<string, unknown> | undefined)?.summary);
  if (!summary) throw new Error("This summary Review Item has no summary text");
  const now = new Date().toISOString();
  const body = withSummarySection(meeting.body, summary);
  const updated = body === meeting.body ? meeting : await ctx.update(meeting, {}, { expectedHash: meeting.contentHash, now, body });
  await ctx.update(review, { status: "accepted", reviewed_at: now, resolved_object_id: meetingId }, { expectedHash: review.contentHash, now });
  await ctx.writeAudit("review.accepted", meetingId, now, { review_id: review.frontmatter.id, review_type: summaryReviewType });
  await ctx.rebuildIndex();
  return updated;
}
