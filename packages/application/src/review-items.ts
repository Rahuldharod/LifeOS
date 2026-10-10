import type { LifeOSObject, ObjectEnvelope, Origin } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import { isMeetingRestricted, isRestricted, replayableId, replayRoles, replayScope, type ReplayRole } from "./support.js";

/**
 * #122: the one way a step proposes a Review Item. The caller says what is proposed and why; this module writes
 * the item pending, with its field evidence and source links, an operation ID replayable after a crash (ADR 0013)
 * and the sensitivity of what it was drawn from (ADR 0010). Editing, accepting and rejecting live in review.ts.
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
  confidence: "High" | "Medium" | "Low";
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
  now: string;
  agentRunId?: string;
  newId(role: ReplayRole): string;
}

/**
 * A run whose IDs are derived from `seed` and `now` (#59), for a step with no journal entry: running it again with
 * the same seed and `now` gets the same IDs, so it finds what an interrupted attempt wrote. `replay` wraps the
 * step's other creates (its Source, its Agent run) the same way `proposeReviewItem` wraps the item.
 */
export function seededRun(ctx: AppContext, seed: string, now: string) {
  const owns = replayScope(seed, now);
  return {
    now,
    newId: (role: ReplayRole) => replayableId(seed, role, now),
    owns,
    replay: <T>(work: () => Promise<T>) => ctx.replaying(owns, work)
  };
}

/**
 * Writes one pending Review Item and returns it. Restricted when the proposer says so or when any object it draws on
 * is: a source, an evidence source, the target, the meeting (or its note) or a `readsFrom` object. Retrying with the
 * same run and role returns the item already written instead of writing a second one.
 */
export async function proposeReviewItem(ctx: AppContext, run: ProposingRun, proposal: ReviewProposal): Promise<LifeOSObject> {
  const id = run.newId(proposal.role);
  const evidence = proposal.evidence ?? {};
  const drawnFrom = [
    ...proposal.sourceIds ?? [],
    ...Object.values(evidence).flat().flatMap((entry) => typeof entry.source_id === "string" ? [entry.source_id] : []),
    ...proposal.target.id ? [proposal.target.id] : [],
    ...typeof proposal.fields?.source_meeting_id === "string" ? [proposal.fields.source_meeting_id] : [],
    ...proposal.readsFrom ?? []
  ];
  const restricted = proposal.sensitivity === "restricted" || drawnFrom.some((objectId) => restrictedSource(ctx, objectId));
  const sensitivity = restricted ? "restricted" : proposal.sensitivity;
  return ctx.replaying([id], () => ctx.objects.write({
    relativePath: `review-items/${markdownFileName(proposal.title, id, run.now)}`,
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
      ...(run.agentRunId ? { agent_run_id: run.agentRunId } : {}),
      ...proposal.fields,
      operation_id: run.newId(replayRoles.operation(proposal.role))
    },
    body: proposal.body
  }));
}

/** ADR 0010: a meeting counts as restricted through its note too (#63); a missing object restricts nothing. */
function restrictedSource(ctx: AppContext, id: string) {
  const object = ctx.index.get(id);
  return object?.frontmatter.type === "meeting" ? isMeetingRestricted(object, ctx.index.all()) : isRestricted(object);
}
