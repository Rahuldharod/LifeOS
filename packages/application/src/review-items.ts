import type { Confidence, LifeOSObject, ObjectEnvelope, Origin } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import { isMeetingRestricted, isRestricted, replayableId, replayRoles, replayScope, type ReplayRole } from "./support.js";

/**
 * #122: the one way a step proposes a Review Item. The caller says what is proposed and why; this module writes
 * the item pending, with its field evidence and source links, an operation ID replayable after a crash (ADR 0013)
 * and the sensitivity of what it was drawn from (ADR 0010, ADR 0018). A step that revises its own pending proposal
 * does so through `reviseReviewItem`, so the same rule applies. User edits, accepting and rejecting live in review.ts.
 */

/** One piece of evidence for a proposed field; `source_id` is the object it was found in, when known. */
export type EvidenceEntry = { source_id?: string } & Record<string, unknown>;

/** What a step proposes and why. */
export interface ReviewProposal {
  /** What the item is for. Its ID and operation ID come from `run.newId` with this role, so a replay gets them back. */
  role: ReplayRole;
  reviewType: string;
  title: string;
  /** The object type the proposal creates or changes, and the existing object it changes, if any. */
  target: { type: string; id?: string };
  proposed: Record<string, unknown>;
  confidence: Confidence;
  /** The Markdown body the user reads. */
  body: string;
  /** Why: the Sources the proposal draws on. */
  sourceIds?: string[];
  /** Why, per proposed field. */
  evidence?: Record<string, EvidenceEntry[]>;
  /** Other objects the proposal is read from (the two people of a merge); only their sensitivity is used. */
  readsFrom?: string[];
  /** The proposer's own sensitivity (a draft's `sensitivity`). A restricted source makes the item restricted anyway. */
  sensitivity?: ObjectEnvelope["sensitivity"];
  /** Defaults to `app`. */
  origin?: Origin;
  /** Further front matter the review type needs: context links, `source_meeting_id`, `draft_key`, `captured_at`, … */
  fields?: Record<string, unknown>;
}

/** The step's run: its timestamp, its Agent run (if any) and the replayable IDs of its objects. */
export interface ProposingRun {
  /** When the step runs: the item's `created_at`. */
  now: string;
  /** The Agent run that proposes, if any. An adoption run's ID is its Agent run's. */
  id?: string;
  newId(role: ReplayRole): string;
  /** The time in file names; a seeded run keeps it across replays so a replay finds the file. Defaults to `now`. */
  fileTime?: string;
}

/**
 * A run whose IDs are derived from `seed` and `seedTime` (#59), for a step with no journal entry: running it again
 * with the same seed gets the same IDs (and file names), so it finds what an interrupted attempt wrote. `now` is the
 * real time of this attempt, which is what new objects record. `replay` wraps the step's other creates (its Source)
 * the same way `proposeReviewItem` wraps the item.
 */
export function seededRun(ctx: AppContext, seed: string, seedTime: string, now = new Date().toISOString()) {
  const owns = replayScope(seed, seedTime);
  return {
    now,
    fileTime: seedTime,
    newId: (role: ReplayRole) => replayableId(seed, role, seedTime),
    owns,
    replay: <T>(work: () => Promise<T>) => ctx.replaying(owns, work)
  };
}
export type SeededRun = ReturnType<typeof seededRun>;

/** What an Agent run outside adoption did (processing a meeting, proposing from a pasted Source). */
export interface AgentRunRecord {
  operation: string;
  title: string;
  inputSummary: string;
  outputSummary: string;
  relatedObjectIds: string[];
  body: string;
}

/**
 * Writes the step's Agent run once (a replay finds it) and returns the run with `id` set to it, ready for
 * `proposeReviewItem`. It started at `run.now` and completes now.
 */
export async function recordAgentRun(ctx: AppContext, run: SeededRun, record: AgentRunRecord): Promise<SeededRun & { id: string }> {
  const id = run.newId(replayRoles.agentRun);
  await run.replay(() => ctx.objects.write({
    relativePath: `agent-runs/${markdownFileName(record.title, id, run.fileTime)}`,
    frontmatter: {
      ...ctx.envelope(id, "agent-run", record.title, run.now), operation: record.operation, provider: "mock", model: "deterministic-mock", prompt_version: "1",
      status: "succeeded", started_at: run.now, completed_at: new Date().toISOString(), input_summary: record.inputSummary, output_summary: record.outputSummary, related_object_ids: record.relatedObjectIds
    },
    body: record.body
  }));
  return { ...run, id };
}

/**
 * Writes one pending Review Item and returns it. Restricted when the proposer says so or when any object it draws on
 * is: a source, an evidence source, the target, the meeting (or its note) or a `readsFrom` object (ADR 0018). Retrying
 * with the same run and role returns the item already written instead of writing a second one.
 */
export async function proposeReviewItem(ctx: AppContext, run: ProposingRun, proposal: ReviewProposal): Promise<LifeOSObject> {
  const id = run.newId(proposal.role);
  const evidence = proposal.evidence ?? {};
  const sensitivity = sensitivityOf(ctx, {
    sourceIds: proposal.sourceIds, evidence, targetId: proposal.target.id, sensitivity: proposal.sensitivity, readsFrom: proposal.readsFrom,
    meetingId: typeof proposal.fields?.source_meeting_id === "string" ? proposal.fields.source_meeting_id : undefined
  });
  return ctx.replaying([id], () => ctx.objects.write({
    relativePath: `review-items/${markdownFileName(proposal.title, id, run.fileTime ?? run.now)}`,
    frontmatter: {
      ...ctx.envelope(id, "review-item", proposal.title, run.now, proposal.origin),
      ...(sensitivity !== undefined ? { sensitivity } : {}),
      review_type: proposal.reviewType,
      target_object_type: proposal.target.type,
      ...(proposal.target.id ? { target_object_id: proposal.target.id } : {}),
      proposed_fields: proposal.proposed,
      field_evidence: evidence,
      confidence_label: proposal.confidence,
      status: "pending",
      source_ids: proposal.sourceIds ?? [],
      ...(run.id ? { agent_run_id: run.id } : {}),
      ...proposal.fields,
      operation_id: run.newId(replayRoles.operation(proposal.role))
    },
    body: proposal.body
  }));
}

/** A newer version of a step's own pending proposal (a later summary for the same meeting). */
export interface ReviewRevision {
  proposed: Record<string, unknown>;
  confidence: Confidence;
  body: string;
  /** All the Sources the revised proposal draws on (not only the new ones). */
  sourceIds: string[];
  fields?: Record<string, unknown>;
}

/**
 * Rewrites a pending Review Item with a newer proposal, through a guarded write. Its sensitivity is worked out again
 * by the same rule as `proposeReviewItem` (ADR 0018): a restricted Source added now makes it restricted, and an item
 * that was restricted stays so.
 */
export async function reviseReviewItem(ctx: AppContext, run: ProposingRun, review: LifeOSObject, revision: ReviewRevision): Promise<LifeOSObject> {
  const stored = review.frontmatter;
  if (stored.status !== "pending") throw new Error("Only a pending Review Item can be revised");
  const meetingId = revision.fields?.source_meeting_id ?? stored.source_meeting_id;
  const sensitivity = sensitivityOf(ctx, {
    sourceIds: revision.sourceIds, evidence: (stored.field_evidence ?? {}) as Record<string, EvidenceEntry[]>, sensitivity: stored.sensitivity,
    targetId: typeof stored.target_object_id === "string" ? stored.target_object_id : undefined, meetingId: typeof meetingId === "string" ? meetingId : undefined
  });
  return ctx.update(review, {
    proposed_fields: revision.proposed, confidence_label: revision.confidence, source_ids: revision.sourceIds,
    ...(sensitivity !== undefined ? { sensitivity } : {}), ...(run.id ? { agent_run_id: run.id } : {}), ...revision.fields
  }, { expectedHash: review.contentHash, now: run.now, body: revision.body });
}

/** ADR 0018: restricted when the proposer says so or anything the item is drawn from is restricted; else the proposer's value. */
function sensitivityOf(ctx: AppContext, from: { sourceIds?: string[]; evidence: Record<string, EvidenceEntry[]>; targetId?: string; meetingId?: string; readsFrom?: string[]; sensitivity?: unknown }) {
  const drawnFrom = [
    ...from.sourceIds ?? [],
    ...Object.values(from.evidence).flat().flatMap((entry) => typeof entry.source_id === "string" ? [entry.source_id] : []),
    ...from.targetId ? [from.targetId] : [],
    ...from.meetingId ? [from.meetingId] : [],
    ...from.readsFrom ?? []
  ];
  const own = from.sensitivity as ObjectEnvelope["sensitivity"];
  return own === "restricted" || drawnFrom.some((objectId) => restrictedSource(ctx, objectId)) ? "restricted" as const : own;
}

/** ADR 0010: a meeting counts as restricted through its note too (#63); a missing object restricts nothing. */
function restrictedSource(ctx: AppContext, id: string) {
  const object = ctx.index.get(id);
  return object?.frontmatter.type === "meeting" ? isMeetingRestricted(object, ctx.index.all()) : isRestricted(object);
}
