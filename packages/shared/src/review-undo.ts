/**
 * ADR 0025: which Review actions can be undone today. One rule for the server (which refuses the rest) and the Inbox
 * (which shows no Undo for them), so they never disagree.
 *
 * - Undoing a reject puts the item back to pending (not for person-merge items: "keep separate" is #242).
 * - Undoing an accept deletes the object it created (only `create` items; merge, link and change undo are #242).
 */
export type ReviewOutcome = "accepted" | "rejected";

export function isReviewActionUndoable(reviewType: string | undefined, outcome: ReviewOutcome): boolean {
  const type = reviewType || "create";
  if (type === "person-merge") return false;
  return outcome === "rejected" || type === "create";
}

/** The text of the refusal for an action that cannot be undone yet. */
export const notYetUndoable = "This kind of decision cannot be undone yet";
