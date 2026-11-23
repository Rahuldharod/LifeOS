import type { LifeOSObject } from "@lifeos/domain";
import { isReviewActionUndoable } from "@lifeos/shared";
import type { AppContext } from "./context.js";
import type { PatchModule } from "./patches.js";
import { isRestricted } from "./support.js";

/** CONTEXT.md: the Inbox History lists the last 100 Review actions. */
export const inboxHistoryLimit = 100;

export type HistoryAction = "accepted" | "rejected" | "merged" | "kept-separate" | "applied" | "linked";

/** One Review action, for the Inbox History tab (#243). */
export interface InboxHistoryEntry {
  /** The audit event of the action itself. */
  id: string;
  at: string;
  /** "system" is an action nobody at the keyboard took: an Agent's Patch Draft applied by Adoption, or any audit not written as a person. */
  actor: "you" | "system";
  action: HistoryAction;
  /** `review`: a Review Item that was decided (undo it with its `reviewId`). `patch`: an applied Patch Draft (undo it with its `id`). */
  source: "review" | "patch";
  reviewId?: string;
  /** What the Review kind badge is made from; `update` for an applied Patch Draft. */
  reviewType: string;
  targetObjectType?: string;
  title: string;
  sourceMeetingId?: string;
  sourceMeetingTitle?: string;
  /** What an accept created or changed (a merge: the kept Person): "Open <object>". Absent for a reject and once an undo took it back. */
  objectId?: string;
  /** A Patch Draft's changes in words ("priority none → High"). */
  summary?: string;
  /** The item (or the object a patch changed) is Restricted: shown with the lock badge, as in the Inbox. */
  restricted: boolean;
  undone: boolean;
  /** Undo would be tried: not undone yet, still the item's current decision, and of a kind that can be undone. The server can still refuse with a reason. */
  undoable: boolean;
}

const metadataOf = (event: LifeOSObject) => (event.frontmatter.metadata ?? {}) as Record<string, unknown>;
const when = (event: LifeOSObject) => String(event.frontmatter.occurred_at ?? event.frontmatter.created_at);
const text = (value: unknown) => typeof value === "string" ? value : undefined;

/** The audit events that record a decision on a Review Item, and the outcome each means. A merge is recorded by `person.merged`. */
const decisionActions: Record<string, "accepted" | "rejected"> = { "review.accepted": "accepted", "person.merged": "accepted", "review.rejected": "rejected" };

/**
 * #243: the Inbox History, built from the audit ledger (ADR 0025): `review.accepted` / `person.merged` / `review.rejected`
 * for each decision, `review.undone` for each undo, `patch.applied` / `patch.undone` for applied Patch Drafts. Reads the
 * index only; writes nothing.
 *
 * **Who:** the event's `actor_type`. A person (the default for every Review action the app records) is "you"; "system",
 * "agent" or "external" is "system". Every `patch.applied` is "system" whatever its actor_type: nobody applies a Patch Draft
 * by hand (the user's own route to a change is accepting an `update` Review Item), and events written before the actor was
 * recorded say "person".
 */
export class InboxHistoryModule {
  constructor(private readonly ctx: AppContext, private readonly patches: PatchModule) {}

  /** Newest first: the last `limit` Review actions (and applied Patch Drafts). */
  inboxHistory(limit = inboxHistoryLimit): InboxHistoryEntry[] {
    const events = this.ctx.index.all().filter((object) => object.frontmatter.type === "audit-event");
    return [...this.reviewEntries(events), ...this.patchEntries()]
      .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
      .slice(0, limit);
  }

  private reviewEntries(events: LifeOSObject[]): InboxHistoryEntry[] {
    const { ctx } = this;
    const byReview = new Map<string, LifeOSObject[]>();
    for (const event of events) {
      const action = String(event.frontmatter.action);
      if (!(action in decisionActions) && action !== "review.undone") continue;
      const reviewId = text(metadataOf(event).review_id) ?? (action === "review.rejected" || action === "review.undone" ? text(event.frontmatter.object_id) : undefined);
      if (reviewId) byReview.set(reviewId, [...(byReview.get(reviewId) ?? []), event]);
    }
    const entries: InboxHistoryEntry[] = [];
    for (const [reviewId, history] of byReview) {
      const review = ctx.index.get(reviewId);
      if (review?.frontmatter.type !== "review-item") continue;
      // Per item, in order: a decision is undone when the next thing that happened to the item was an undo. Same-instant events
      // are decision-then-undo (an undo needs a decision to undo).
      const rank = (event: LifeOSObject) => event.frontmatter.action === "review.undone" ? 1 : 0;
      history.sort((left, right) => when(left).localeCompare(when(right)) || rank(left) - rank(right) || String(left.frontmatter.id).localeCompare(String(right.frontmatter.id)));
      history.forEach((event, index) => {
        const outcome = decisionActions[String(event.frontmatter.action)];
        if (!outcome) return;
        const undone = history[index + 1]?.frontmatter.action === "review.undone";
        entries.push(this.reviewEntry(event, review, outcome, undone, index === history.length - 1));
      });
    }
    return entries;
  }

  private reviewEntry(event: LifeOSObject, review: LifeOSObject, outcome: "accepted" | "rejected", undone: boolean, latest: boolean): InboxHistoryEntry {
    const reviewType = text(review.frontmatter.review_type) ?? "create";
    const action: HistoryAction = reviewType === "person-merge" ? (outcome === "accepted" ? "merged" : "kept-separate")
      : outcome === "rejected" ? "rejected" : reviewType === "link-resolution" ? "linked" : reviewType === "update" ? "applied" : "accepted";
    const meetingId = text(review.frontmatter.source_meeting_id);
    const meeting = meetingId ? this.ctx.index.get(meetingId) : undefined;
    const objectId = outcome === "accepted" && !undone ? text(event.frontmatter.object_id) : undefined;
    const target = text(review.frontmatter.target_object_type);
    return {
      id: String(event.frontmatter.id), at: when(event), actor: event.frontmatter.actor_type === "person" || event.frontmatter.actor_type === undefined ? "you" : "system",
      action, source: "review", reviewId: review.frontmatter.id,
      reviewType, ...(target ? { targetObjectType: target } : {}), title: review.frontmatter.title,
      ...(meetingId && meeting ? { sourceMeetingId: meetingId, sourceMeetingTitle: meeting.frontmatter.title } : {}),
      ...(objectId ? { objectId } : {}), restricted: isRestricted(review), undone,
      undoable: !undone && latest && review.frontmatter.status === outcome && isReviewActionUndoable(reviewType, outcome)
    };
  }

  private patchEntries(): InboxHistoryEntry[] {
    return this.patches.appliedPatches().map((patch) => {
      const target = this.ctx.index.get(patch.objectId);
      const changes = [...Object.keys(patch.after).map((field) => `${field} ${String(patch.before[field] ?? "none")} → ${String(patch.after[field] ?? "none")}`), ...(patch.appendedNote ? [`note added: "${patch.appendedNote}"`] : [])];
      return {
        id: patch.auditEventId, at: patch.appliedAt, actor: "system" as const, action: "applied" as const, source: "patch" as const,
        reviewType: "update", ...(target ? { targetObjectType: target.frontmatter.type } : {}), title: patch.title, objectId: patch.objectId,
        summary: changes.join("; ") || "no change", restricted: isRestricted(target), undone: patch.undone, undoable: !patch.undone
      };
    });
  }
}
