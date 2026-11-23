# ADR 0025: Review actions can be undone

- Status: Accepted
- Date: 2026-11-23
- Supersedes: the "no undo of a decision" line of PB-035 (Inbox auto-advance)

## Context

A Review Item's status has only moved forward: pending to accepted or rejected, never back. Only an applied Patch Draft could be undone. Bulk reject therefore asked "This cannot be undone." before acting.

The Inbox redesign makes the user act from the list, often on whole groups at once, so a slip is more likely. Mail apps handle this with Undo instead of a confirmation prompt. The user wants that in the action toast and in an Inbox History of the last 100 Review actions.

## Decision

- **Every Review action can be undone**: accept, edit, reject, merge, keep separate and apply, whether the user took it or the system did.
- **Undoing a reject or keep separate** puts the Review Item back to pending.
- **Undoing an accept** puts the Review Item back to pending and deletes the object the accept created (a soft delete that sets `deleted_at`, through the normal use cases).
- **Undo is refused when the created object has been edited since the accept.** This is the same rule as Patch undo, so nothing the user changed afterwards is lost silently. The refusal says why and offers to open the object.
- **Undo replaces confirmation.** Bulk reject no longer asks first. The toast offers Undo instead.

## Considered options

- **Keep forward-only status and keep confirmations.** Rejected: it slows group triage, and "are you sure?" prompts get clicked through anyway.
- **Undo an accept by archiving the created object.** Rejected: archived objects still resolve by identifier and can be reused (see *Live* in `CONTEXT.md`). A deleted object is gone, which matches "it was never accepted".

## Consequences

- Undoing an accept writes two files (the Review Item and the created object), so it follows the crash-recovery pattern of ADR 0013, with the undo journalled as a Recorded intent.
- Undo must know which object an accept created. `resolved_object_id` already records this for accepts. Merge and apply need the same link back to what they changed.
- An accepted item that was then edited can only be "undone" by deleting or changing the object by hand.

## How it works (#241)

- **Entry point:** `undoReviewAction(reviewId)` (`POST /api/v1/review-items/:id/undo`). It undoes rejects of any type except person-merge, and accepts of `create` items. Everything else is refused with 409 "cannot be undone yet" until #242. `isReviewActionUndoable` (shared) is the one rule; the Inbox hides Undo for the rest.
- **"Edited since" is the created object's revision.** The accept writes revision 1 and every guarded write adds one, so any revision other than 1 means someone changed it. This is the same rule the accept rollback already used (`abandonCreate`). A refusal writes nothing and says why. The Inbox toast then offers View on that object. An object already deleted does not block the undo.
- **Journalled as `undo-review`** (ADR 0013). The refusal check runs before the journal entry, so a refused undo leaves no trace. The entry holds the Review Item, the created object and a fresh accept-operation ID. Replay deletes the object only while it is live, moves the item to pending only while it is decided, and writes `review.undone` once (matched on the operation ID). A retry finds the open entry and finishes it.
- **The item gets a fresh `operation_id`.** The accept journal is keyed by it, and a finished entry would hand back the deleted object's ID on the next accept.
- **Ledger for History (#243):** `review.accepted` (object = the created object), `review.rejected` (object = the item) and `review.undone` (object = the item; `undone`, `deleted_object_id`).
