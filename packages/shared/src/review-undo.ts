/**
 * ADR 0025: which Review actions can be undone. One rule for the server (which refuses the rest) and the Inbox
 * (which shows no Undo for them), so they never disagree.
 *
 * - Undoing a reject (including Keep separate) puts the item back to pending.
 * - Undoing an accept puts it back to pending too, and takes back what the accept did: it deletes the object a `create`
 *   item made, restores both People of a Merge, and reverts the link or the fields a link or `update` item set.
 *
 * The server can still refuse a decision this says is undoable, with a reason: an object it touched was edited since,
 * or (merges and links made before #242) nothing recorded what the accept changed.
 */
export type ReviewOutcome = "accepted" | "rejected";

const undoableAccepts = new Set(["create", "person-merge", "link-resolution", "update"]);

export function isReviewActionUndoable(reviewType: string | undefined, outcome: ReviewOutcome): boolean {
  return outcome === "rejected" || undoableAccepts.has(reviewType || "create");
}

/** The text of the refusal for an action that cannot be undone. */
export const notYetUndoable = "This kind of decision cannot be undone yet";
