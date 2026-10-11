import { confidenceLabels, type Confidence, type LifeOSObject } from "@lifeos/domain";
import { DraftError, text, toUtc, type AdoptionRun, type ParsedDraft, type ProposeOptions } from "./adoption.js";
import { markdownFileName, type AppContext } from "./context.js";
import { expectedMaterial, unavailableOf } from "./enrichment.js";
import type { EnrichmentOccurrenceTarget, MeetingsModule } from "./meetings.js";
import { foldName, type ReferenceResolver } from "./resolution.js";
import { proposeReviewItem, reviseReviewItem, type EvidenceEntry } from "./review-items.js";
import { inheritContextLinks, isLive, isMeetingRestricted, liveMeetingNote, objectIdPattern, replayRoles } from "./support.js";

/**
 * Adoption of meeting material (#45, PRD "Enrichment Work Orders"). One `meeting-material` draft per meeting,
 * written by the enrichment skill:
 *
 *   meeting: <calendar event ID or meeting ID>   (optional calendar_id)
 *   sources: [{ source_type, url, external_id, occurred_at, provider?, title? }]
 *   proposals: [{ kind, title, confidence, missed_in_notes, evidence, key?, body?, …task/decision fields }]
 *   unavailable: [gong-call, …]                  (optional: expected material the agent checked and found not to exist)
 *   summary_confidence: High | Medium | Low      (optional, default Medium)
 *   body: the proposed meeting summary (optional)
 *
 * Adoption creates the meeting from the calendar event if needed (never its note), upserts Sources by
 * provider + external ID, raises one `summary` Review Item and create-type Review Items for the proposals
 * (inheriting the meeting's project, client, product and people), then sets `enriched` (every expected kind is
 * linked or known not to exist) or `partial`.
 * Re-runs are safe: sources, the summary and proposals (by `key`, else kind + title) are found, not re-added.
 * Restricted meetings are never enriched.
 */

export const summaryReviewType = "summary";

function parseUnavailable(value: unknown, sources: Array<{ sourceType: string }>, issues: string[]) {
  if (value === undefined) return [] as string[];
  if (!Array.isArray(value)) { issues.push(`unavailable: must be a list of material kinds (${expectedMaterial.join(", ")})`); return []; }
  const kinds: string[] = [];
  for (const item of value) {
    const kind = text(item);
    if (!(expectedMaterial as readonly string[]).includes(kind)) issues.push(`unavailable: unknown material "${kind}" (expected one of ${expectedMaterial.join(", ")})`);
    else if (sources.some((source) => source.sourceType === kind)) issues.push(`unavailable: ${kind} is also listed in sources`);
    else if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}
export const materialSourceTypes =[...expectedMaterial, "drive-doc"] as const;
const defaultProvider: Record<string, string> = { "meet-transcript": "google-drive", "meet-recording": "google-drive", "drive-doc": "google-drive", "gong-call": "gong", "gong-summary-email": "gmail" };
const sourceLabels: Record<string, string> = { "meet-transcript": "Meet transcript", "meet-recording": "Meet recording", "drive-doc": "Drive doc", "gong-call": "Gong call", "gong-summary-email": "Gong summary email" };
const proposalKinds = ["task", "decision", "open-point"];
/** How far back the calendar is searched for an event that has no meeting yet. */
const eventLookbackMs = 30 * 86_400_000;

/**
 * Every ID this handler writes comes from the run, keyed by role (#59): the meeting, each source by provider +
 * external ID, the summary, each proposal by key. A replay that finds one already written gets the same IDs for the rest.
 */
const roles = {
  meeting: replayRoles.meeting,
  source: (source: { provider: string; externalId: string }) => replayRoles.source(source.provider, source.externalId),
  summary: replayRoles.summary,
  proposal: replayRoles.proposal
};

type Propose = (draft: ParsedDraft, run: AdoptionRun, options: ProposeOptions) => Promise<string[]>;
interface MaterialSource { at: string; sourceType: string; provider: string; externalId: string; url: string; occurredAt: string; retrievedAt: string; providerRevision?: string; title?: string }
interface MaterialProposal { at: string; key: string; missedInNotes: boolean; draft: ParsedDraft }
interface MaterialEvidence { source: string; locator: string; quote?: string }

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
    if (meeting && isMeetingRestricted(meeting, ctx.index.all())) throw new DraftError([`meeting: ${meeting.frontmatter.id} is restricted; LifeOS does not enrich restricted meetings`]);

    const lookup = { from: new Date(Date.parse(run.now) - eventLookbackMs), to: new Date(Date.parse(run.now) + 86_400_000), calendarId: text(fields.calendar_id) || undefined };
    let occurrence = meeting ? this.meetings?.enrichmentOccurrenceForMeeting(meeting) : undefined;
    if (!meeting && this.meetings) {
      try { occurrence = await this.meetings.enrichmentOccurrenceForEvent(reference, lookup.from, lookup.to, lookup.calendarId); }
      catch (error) { if (!(error instanceof Error) || !error.message.startsWith("Calendar event not found:")) throw error; }
    }

    // 2. Every check up front, so a bad draft writes nothing (not even the meeting).
    const issues: string[] = [];
    this.validateOccurrence(fields, occurrence, issues);
    const sources = this.parseSources(fields.sources, issues);
    const unavailable = parseUnavailable(fields.unavailable, sources, issues);
    const summary = draft.body.trim();
    const summaryConfidence = fields.summary_confidence === undefined ? "Medium" : confidenceLabels.find((value) => value.toLowerCase() === text(fields.summary_confidence).toLowerCase());
    if (!summaryConfidence) issues.push(`summary_confidence: unknown confidence "${text(fields.summary_confidence)}" (expected High, Medium or Low)`);
    const proposals = this.parseProposals(draft, issues);
    for (const proposal of proposals) {
      try { await this.propose(proposal.draft, run, { dryRun: true }); }
      catch (error) { if (error instanceof DraftError) issues.push(...error.issues.map((issue) => `${proposal.at}.${issue}`)); else throw error; }
    }
    const summaryEvidence = this.parseMaterialEvidence(fields.summary_evidence, "summary_evidence", issues);
    if (occurrence && summary && !summaryEvidence.length) issues.push("summary_evidence: a recurring occurrence summary needs at least one Source and locator");
    const allowedSourceRefs = this.allowedSourceReferences(meeting, sources);
    if (occurrence) {
      this.validateEvidenceSources(summaryEvidence, "summary_evidence", allowedSourceRefs, issues);
      for (const proposal of proposals) this.validateEvidenceSources(this.parseMaterialEvidence(proposal.draft.fields.evidence, `${proposal.at}.evidence`, issues), `${proposal.at}.evidence`, allowedSourceRefs, issues);
    }
    if (issues.length) throw new DraftError(issues);

    // 3. The meeting from the calendar event if missing; the note is still only created on the first edit.
    const objectIds: string[] = [];
    if (!meeting) {
      if (objectIdPattern.test(reference) || !this.meetings) throw new DraftError([`meeting: no LifeOS meeting "${reference}"`]);
      const ensured = await this.meetings.ensureMeetingForEvent(reference, { ...lookup, meetingId: run.newId(roles.meeting), draftKey: draft.draftKey });
      if (!ensured) throw new DraftError([`meeting: no LifeOS meeting or calendar event "${reference}" in the last 30 days`]);
      meeting = ensured.meeting;
      if (ensured.created) objectIds.push(meeting.frontmatter.id);
    } else if (this.meetings && meeting.frontmatter.id === run.newId(roles.meeting)) {
      // Replay after a crash: this draft created the meeting; make sure its creation is audited (once).
      objectIds.push(meeting.frontmatter.id);
      await this.meetings.auditCreatedForDraft(meeting, draft.draftKey);
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

    if (occurrence && (sourceIds.length || summary || proposals.length)) {
      const materialized = await this.meetings?.ensureOccurrenceSectionForEnrichment(ctx.required(meetingId, "meeting"), lookup.from, lookup.to, lookup.calendarId);
      if (!materialized?.note) throw new DraftError([`occurrence_section_id: ${occurrence.sectionId} could not be materialized`]);
      await ctx.rebuildIndex();
      await this.updateMaterialsBlock(ctx.required(meetingId, "meeting"), occurrence, run.now);
      await ctx.rebuildIndex();
    }

    // 5. Summary and proposals, inheriting the meeting's context.
    meeting = ctx.required(meetingId, "meeting");
    if (summary) objectIds.push(await this.upsertSummary(summary, summaryConfidence!, meeting, sourceIds, summaryEvidence, occurrence, draft, run));
    // Proposals already raised for this meeting (any status: a rejected one is never proposed again), by key.
    const raised = new Map(this.reviewsFor(meetingId).filter((review) => review.frontmatter.review_type === "create" && typeof review.frontmatter.proposal_key === "string").map((review) => [String(review.frontmatter.proposal_key), review.frontmatter.id]));
    const attendees = idList(meeting.frontmatter.attendee_ids);
    for (const proposal of proposals) {
      const found = raised.get(proposal.key);
      if (found) { objectIds.push(found); continue; }
      // `meeting` makes kindFields inherit the meeting's project, client and product; people default to its attendees.
      const inherited = { ...proposal.draft, fields: { ...proposal.draft.fields, meeting: meetingId, ...(proposal.draft.fields.people === undefined && attendees.length ? { people: attendees } : {}) } };
      const [reviewId] = await this.propose(inherited, run, { role: roles.proposal(proposal.key), extra: {
        missed_in_notes: proposal.missedInNotes, proposal_key: proposal.key,
        ...(occurrence ? { occurrence_section_id: occurrence.sectionId, recurrence_occurrence_id: occurrence.occurrenceId } : {})
      } });
      raised.set(proposal.key, reviewId!);
      objectIds.push(reviewId!);
    }
    await ctx.rebuildIndex();

    // 6. State: `enriched` when every expected kind of material is now linked, else `partial` (retriable).
    meeting = ctx.required(meetingId, "meeting");
    const listed = idList(meeting.frontmatter.source_ids);
    const extraIds = elsewhere.filter((id) => !listed.includes(id));
    const have = new Set(this.sourcesFor(meeting, [...listed, ...extraIds]).map((source) => String(source.frontmatter.source_type)));
    // Material the agent reported as not existing (e.g. no Gong call) counts as done, unless it turned up after all.
    const absent = [...new Set([...unavailableOf(meeting), ...unavailable])].filter((kind) => !have.has(kind));
    const missing = expectedMaterial.filter((kind) => !have.has(kind) && !absent.includes(kind));
    const state = missing.length ? "partial" : "enriched";
    await ctx.update(meeting, { enrichment_state: state, enrichment_missing_material: missing, enrichment_unavailable_material: absent.length ? absent : undefined, enrichment_adopted_at: run.now, ...(extraIds.length ? { source_ids: [...listed, ...extraIds] } : {}) }, { expectedHash: meeting.contentHash, now: run.now });
    await ctx.writeAuditOnce("meeting.enrichment-adopted", meetingId, run.now, { from: meeting.frontmatter.enrichment_state ?? "none", to: state, missing_material: missing, draft_key: draft.draftKey, agent_run_id: run.id }, { matchOn: ["draft_key"], actor: { type: "agent", ref: run.id } });
    await ctx.rebuildIndex();
    return [...new Set(objectIds)];
  }

  /** By meeting ID, or by calendar event ID through the shared resolver (duplicates are refused, not picked). */
  private existingMeeting(reference: string) {
    const result = this.resolver.resolve("meeting", reference);
    if (result.status === "ambiguous") throw new DraftError([`meeting: calendar event "${reference}" has ${result.candidates.length} LifeOS meetings (${result.candidates.map((candidate) => candidate.id).join(", ")}); resolve the duplicate first`]);
    return result.status === "resolved" ? this.ctx.required(result.id, "meeting") : undefined;
  }

  private validateOccurrence(fields: Record<string, unknown>, occurrence: EnrichmentOccurrenceTarget | undefined, issues: string[]) {
    const sectionId = text(fields.occurrence_section_id);
    const occurrenceId = text(fields.recurrence_occurrence_id);
    if (!occurrence) {
      if (sectionId || occurrenceId) issues.push("occurrence_section_id: this is not a recurring occurrence");
      return;
    }
    if (!sectionId) issues.push("occurrence_section_id: missing; copy it from the Work Order");
    else if (sectionId !== occurrence.sectionId) issues.push(`occurrence_section_id: ${sectionId} does not belong to the resolved occurrence (expected ${occurrence.sectionId})`);
    if (!occurrenceId) issues.push("recurrence_occurrence_id: missing; copy it from the Work Order");
    else if (occurrenceId !== occurrence.occurrenceId) issues.push(`recurrence_occurrence_id: ${occurrenceId} does not belong to the resolved occurrence`);
  }

  private parseMaterialEvidence(value: unknown, at: string, issues: string[]) {
    if (value === undefined) return [] as MaterialEvidence[];
    if (!Array.isArray(value)) { issues.push(`${at}: must be a list of { source, locator, quote? } entries`); return []; }
    return value.flatMap((item, index) => {
      const field = `${at}[${index}]`;
      if (!isRecord(item)) { issues.push(`${field}: must be a { source, locator, quote? } entry`); return []; }
      const source = text(item.source);
      const locator = text(item.locator);
      if (!source) issues.push(`${field}.source: missing`);
      if (!locator) issues.push(`${field}.locator: missing; locate the evidence inside the targeted occurrence material`);
      if (item.quote !== undefined && !text(item.quote)) issues.push(`${field}.quote: must be text`);
      return source && locator ? [{ source, locator, ...(text(item.quote) ? { quote: text(item.quote) } : {}) }] : [];
    });
  }

  private allowedSourceReferences(meeting: LifeOSObject | undefined, sources: MaterialSource[]) {
    const linked = meeting ? this.sourcesFor(meeting, idList(meeting.frontmatter.source_ids)) : [];
    return new Set([
      ...sources.flatMap((source) => [source.url, source.externalId]),
      ...linked.flatMap((source) => [source.frontmatter.id, source.frontmatter.title, source.frontmatter.url, source.frontmatter.external_id].filter((value): value is string => typeof value === "string"))
    ]);
  }

  private validateEvidenceSources(evidence: MaterialEvidence[], at: string, allowed: Set<string>, issues: string[]) {
    for (const [index, item] of evidence.entries()) if (!allowed.has(item.source)) issues.push(`${at}[${index}].source: must name a Source linked to this occurrence`);
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
      const retrievedAt = item.retrieved_at === undefined ? undefined : toUtc(item.retrieved_at);
      if (item.retrieved_at !== undefined && !retrievedAt) issues.push(`${at}.retrieved_at: not an ISO 8601 date-time with Z or an offset ("${String(item.retrieved_at)}")`);
      if (item.provider_revision !== undefined && !text(item.provider_revision)) issues.push(`${at}.provider_revision: must be text`);
      if (item.title !== undefined && !text(item.title)) issues.push(`${at}.title: must be text`);
      if (issues.length > before) return;
      const provider = text(item.provider) || defaultProvider[sourceType]!;
      // The same material listed twice in one draft is one source.
      if (seen.has(`${provider}\n${externalId}`)) return;
      seen.add(`${provider}\n${externalId}`);
      sources.push({
        at, sourceType, provider, externalId, url, occurredAt: occurredAt!, retrievedAt: retrievedAt ?? "",
        ...(text(item.provider_revision) ? { providerRevision: text(item.provider_revision) } : {}),
        ...(text(item.title) ? { title: text(item.title) } : {})
      });
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
    let found = ctx.index.all().find((object) => object.frontmatter.type === "source" && object.frontmatter.provider === source.provider && object.frontmatter.external_id === source.externalId);
    if (found) {
      if (!isLive(found)) return undefined;
      const metadata = { retrieved_at: source.retrievedAt || draft.capturedAt, ...(source.providerRevision ? { provider_revision: source.providerRevision } : {}) };
      if (found.frontmatter.retrieved_at !== metadata.retrieved_at || (metadata.provider_revision && found.frontmatter.provider_revision !== metadata.provider_revision)) {
        found = await ctx.update(found, metadata, { expectedHash: found.contentHash, now: run.now });
      }
      const linkedTo = found.frontmatter.meeting_id;
      if (linkedTo === meeting.frontmatter.id) return { id: found.frontmatter.id, otherMeeting: false };
      if (typeof linkedTo === "string" && ctx.index.get(linkedTo)) return { id: found.frontmatter.id, otherMeeting: true };
      await ctx.update(found, { meeting_id: meeting.frontmatter.id }, { expectedHash: found.contentHash, now: run.now });
      return { id: found.frontmatter.id, otherMeeting: false };
    }
    const id = run.newId(roles.source(source));
    const title = source.title ?? `${sourceLabels[source.sourceType]}: ${meeting.frontmatter.title}`;
    await ctx.objects.write({
      relativePath: `sources/${markdownFileName(title, id, run.now)}`,
      frontmatter: {
        ...ctx.envelope(id, "source", title, run.now, "agent-extracted"),
        source_type: source.sourceType, provider: source.provider, external_id: source.externalId, url: source.url,
        occurred_at: source.occurredAt, captured_at: draft.capturedAt, retrieved_at: source.retrievedAt || draft.capturedAt,
        ...(source.providerRevision ? { provider_revision: source.providerRevision } : {}),
        ingestion_status: "captured", meeting_id: meeting.frontmatter.id,
        ...inheritContextLinks(meeting)
      },
      body: `# ${title}\n\n${source.url}\n`
    });
    return { id, otherMeeting: false };
  }

  /**
   * One summary per meeting at a time: the same text is never proposed twice, and a newer text replaces a
   * still-pending proposal rather than adding a second one. After accept or reject, a different text is new.
   */
  private async upsertSummary(summary: string, confidence: Confidence, meeting: LifeOSObject, sourceIds: string[], materialEvidence: MaterialEvidence[], occurrence: EnrichmentOccurrenceTarget | undefined, draft: ParsedDraft, run: AdoptionRun) {
    const { ctx } = this;
    const summaries = this.reviewsFor(meeting.frontmatter.id).filter((review) => review.frontmatter.review_type === summaryReviewType);
    const same = summaries.find((review) => foldName(text((review.frontmatter.proposed_fields as Record<string, unknown>)?.summary)) === foldName(summary));
    if (same) return same.frontmatter.id;
    const title = `Summary: ${meeting.frontmatter.title}`;
    const body = `# ${title}\n\n${summary}\n`;
    const evidence: Record<string, EvidenceEntry[]> = materialEvidence.length ? { summary: this.resolveMaterialEvidence(materialEvidence, meeting) } : {};
    const occurrenceFields = occurrence ? { occurrence_section_id: occurrence.sectionId, recurrence_occurrence_id: occurrence.occurrenceId } : {};
    const pending = summaries.find((review) => review.frontmatter.status === "pending");
    if (pending) {
      const merged = [...new Set([...idList(pending.frontmatter.source_ids), ...sourceIds])];
      await reviseReviewItem(ctx, run, pending, { proposed: { summary }, confidence, body, sourceIds: merged, evidence, fields: { draft_key: draft.draftKey, captured_at: draft.capturedAt, ...occurrenceFields } });
      return pending.frontmatter.id;
    }
    const review = await proposeReviewItem(ctx, run, {
      role: roles.summary, reviewType: summaryReviewType, title, target: { type: "meeting", id: meeting.frontmatter.id },
      proposed: { summary }, confidence, body, sourceIds, evidence, origin: "agent-extracted",
      fields: { source_meeting_id: meeting.frontmatter.id, draft_key: draft.draftKey, captured_at: draft.capturedAt, ...occurrenceFields, ...inheritContextLinks(meeting) }
    });
    return review.frontmatter.id;
  }

  private resolveMaterialEvidence(evidence: MaterialEvidence[], meeting: LifeOSObject): EvidenceEntry[] {
    const sources = this.sourcesFor(meeting, idList(meeting.frontmatter.source_ids));
    return evidence.map((entry) => {
      const source = sources.find((candidate) => [candidate.frontmatter.id, candidate.frontmatter.title, candidate.frontmatter.url, candidate.frontmatter.external_id].includes(entry.source));
      return { source_ref: entry.source, ...(source ? { source_id: source.frontmatter.id } : {}), locator: entry.locator, ...(entry.quote ? { quote: entry.quote } : {}) };
    });
  }

  private async updateMaterialsBlock(meeting: LifeOSObject, occurrence: EnrichmentOccurrenceTarget, now: string) {
    const note = liveMeetingNote(meeting.frontmatter.id, this.ctx.index.all());
    if (!note) throw new DraftError([`occurrence_section_id: ${occurrence.sectionId} has no Recurring Meeting Note`]);
    const sections = Array.isArray(note.frontmatter.occurrence_sections) ? note.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
    if (!sections.some((section) => section.section_id === occurrence.sectionId && section.meeting_id === meeting.frontmatter.id)) {
      throw new DraftError([`occurrence_section_id: ${occurrence.sectionId} does not resolve to meeting ${meeting.frontmatter.id}`]);
    }
    const sources = this.sourcesFor(meeting, idList(meeting.frontmatter.source_ids));
    const body = withOccurrenceMaterials(note.body, sections, occurrence.sectionId, sources);
    if (body !== note.body) await this.ctx.update(note, {}, { expectedHash: note.contentHash, now, body });
  }

  private reviewsFor(meetingId: string) {
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "review-item" && object.frontmatter.source_meeting_id === meetingId);
  }

  /** Live Sources for a meeting: linked by `meeting_id`, or listed in the meeting's or its note's `source_ids` (as #44 counts them). */
  private sourcesFor(meeting: LifeOSObject, listed: string[]) {
    const note = liveMeetingNote(meeting.frontmatter.id, this.ctx.index.all());
    const ids = new Set([...listed, ...idList(note?.frontmatter.source_ids)]);
    return this.ctx.index.all().filter((object) => object.frontmatter.type === "source" && isLive(object) && (object.frontmatter.meeting_id === meeting.frontmatter.id || ids.has(object.frontmatter.id)));
  }
}

const materialsStart = (sectionId: string) => `<!-- lifeos:materials:start ${sectionId} -->`;
const materialsEnd = (sectionId: string) => `<!-- lifeos:materials:end ${sectionId} -->`;

/** Replaces only one occurrence's app-managed Materials block; all user prose and neighbouring sections survive byte-for-byte. */
export function withOccurrenceMaterials(body: string, sections: Array<Record<string, unknown>>, sectionId: string, sources: LifeOSObject[]) {
  const startMarker = materialsStart(sectionId);
  const endMarker = materialsEnd(sectionId);
  const rows = sources.map((source) => {
    const title = String(source.frontmatter.title).replace(/[\[\]]/g, "");
    const url = typeof source.frontmatter.url === "string" ? source.frontmatter.url : undefined;
    const details = [
      typeof source.frontmatter.retrieved_at === "string" ? `retrieved ${source.frontmatter.retrieved_at}` : undefined,
      typeof source.frontmatter.provider_revision === "string" ? `provider revision ${source.frontmatter.provider_revision}` : undefined
    ].filter(Boolean);
    return `- ${url ? `[${title}](${url})` : title}${details.length ? ` — ${details.join(", ")}` : ""}`;
  });
  const block = [startMarker, "", "### Materials", "", ...(rows.length ? rows : ["- No linked materials." ]), "", endMarker].join("\n");
  const existingStart = body.indexOf(startMarker);
  const existingEnd = existingStart < 0 ? -1 : body.indexOf(endMarker, existingStart + startMarker.length);
  if (existingStart >= 0 && existingEnd >= 0) return `${body.slice(0, existingStart)}${block}${body.slice(existingEnd + endMarker.length)}`;

  const anchor = `<a id="${sectionId}"></a>`;
  const anchorAt = body.indexOf(anchor);
  if (anchorAt < 0) throw new Error(`Occurrence section anchor is missing: ${sectionId}`);
  const laterAnchors = sections
    .map((section) => String(section.section_id))
    .filter((candidate) => candidate !== sectionId)
    .map((candidate) => body.indexOf(`<a id="${candidate}"></a>`, anchorAt + anchor.length))
    .filter((offset) => offset >= 0);
  const nextAnchor = laterAnchors.length ? Math.min(...laterAnchors) : -1;
  const nextHeading = nextAnchor < 0 ? body.length : Math.max(0, body.lastIndexOf("\n## ", nextAnchor) + 1);
  const section = body.slice(0, nextHeading).trimEnd();
  const after = body.slice(nextHeading);
  return `${section}\n\n${block}${after ? `\n\n${after}` : ""}`;
}

/**
 * The Summary section of a meeting body is fenced by these markers (#66), so finding its end never depends on
 * the headings the summary itself contains. Everything outside the markers is the user's and is never changed.
 * Markers, heading and text are separated by blank lines (#96): the form the visual editor keeps byte-for-byte.
 * Sections written before #96 without those blank lines are still read, and respaced when next replaced.
 */
export const summaryStartMarker = "<!-- lifeos:summary:start -->";
export const summaryEndMarker = "<!-- lifeos:summary:end -->";
const markerPattern = /<!--\s*lifeos:summary:(?:start|end)\s*-->/gi;
const isMarkerLine = (line: string, marker: string) => line.trim() === marker;

/**
 * Writes `summary` as the meeting body's Summary section, replacing the one already there, or appending one.
 * - Marked section: everything from the start marker to the end marker is replaced, nothing else.
 * - Unmarked `## Summary` (written before #66), or a start marker whose end marker is gone: migrated to a
 *   marked section, replacing up to the next heading of level 1–2 as before (an older summary's own headings
 *   past that point cannot be told apart from the user's, so they are left alone).
 * Deterministic: writing the same summary again returns the body unchanged.
 */
export function withSummarySection(body: string, summary: string) {
  const text = summary.replace(markerPattern, "").trim();
  const section = [summaryStartMarker, "", "## Summary", "", ...(text ? [...text.split("\n"), ""] : []), summaryEndMarker];
  const lines = body.split("\n");
  const start = lines.findIndex((line) => isMarkerLine(line, summaryStartMarker));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && isMarkerLine(line, summaryEndMarker));
  if (end >= 0) return [...lines.slice(0, start), ...section, ...lines.slice(end + 1)].join("\n");

  const isSummaryHeading = (line: string) => /^##\s+Summary\s*$/i.test(line);
  // A start marker without its end marker owns only the heading right under it, never a later one.
  const from = start >= 0 ? start : lines.findIndex(isSummaryHeading);
  const heading = start >= 0 ? (isSummaryHeading(lines[start + 1] ?? "") ? start + 1 : start) : from;
  if (from < 0) {
    const separator = !body ? "" : /\r?\n\r?\n$/.test(body) ? "" : /\n$/.test(body) ? "\n" : "\n\n";
    return `${body}${separator}${section.join("\n")}\n`;
  }
  const next = lines.findIndex((line, index) => index > heading && /^#{1,2}\s/.test(line));
  const after = next < 0 ? [""] : ["", ...lines.slice(next)];
  return [...lines.slice(0, from), ...section, ...after].join("\n");
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
  // Not isLive on purpose: the summary names its meeting by ID, and an explicit ID reaches an archived meeting (#118).
  if (meeting.frontmatter.deleted_at) throw new Error("The meeting for this summary was deleted");
  // ADR 0010, #63: restricted since the summary was raised (the meeting or its note); nothing is written.
  if (isMeetingRestricted(meeting, ctx.index.all())) throw new Error("This meeting is now restricted, so its summary cannot be accepted");
  const sectionId = typeof review.frontmatter.occurrence_section_id === "string" ? review.frontmatter.occurrence_section_id : undefined;
  const occurrenceId = typeof review.frontmatter.recurrence_occurrence_id === "string" ? review.frontmatter.recurrence_occurrence_id : undefined;
  if (sectionId || occurrenceId) {
    const note = liveMeetingNote(meetingId, ctx.index.all());
    const sections = Array.isArray(note?.frontmatter.occurrence_sections) ? note.frontmatter.occurrence_sections as Array<Record<string, unknown>> : [];
    const section = sections.find((candidate) => candidate.meeting_id === meetingId);
    if (!section || section.section_id !== sectionId || section.occurrence_id !== occurrenceId) throw new Error("This summary no longer belongs to the resolved occurrence section");
  }
  const summary = text((review.frontmatter.proposed_fields as Record<string, unknown> | undefined)?.summary);
  if (!summary) throw new Error("This summary Review Item has no summary text");
  const now = new Date().toISOString();
  const body = withSummarySection(meeting.body, summary);
  const updated = body === meeting.body ? meeting : await ctx.update(meeting, {}, { expectedHash: meeting.contentHash, now, body });
  await ctx.update(review, { status: "accepted", reviewed_at: now, resolved_object_id: meetingId }, { expectedHash: review.contentHash, now });
  await ctx.writeAuditOnce("review.accepted", meetingId, now, { review_id: review.frontmatter.id, review_type: summaryReviewType }, { matchOn: ["review_id"] });
  await ctx.rebuildIndex();
  return updated;
}
