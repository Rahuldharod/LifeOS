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

- **Entry point:** `undoReviewAction(reviewId)` (`POST /api/v1/review-items/:id/undo`). Since #242 it undoes every reject (Keep separate included) and the accepts of `create`, `person-merge`, `link-resolution` and `update` items. Other accepted kinds (a meeting summary) are refused with 409 "cannot be undone yet". `isReviewActionUndoable` (shared) is the one rule; the Inbox hides Undo for the rest. It can still say yes where the server then refuses with a reason (see #242 below).
- **"Edited since" is the created object's revision.** The accept writes revision 1 and every guarded write adds one, so any revision other than 1 means someone changed it. This is the same rule the accept rollback already used (`abandonCreate`). A refusal writes nothing and says why. The Inbox toast then offers View on that object. An object already deleted does not block the undo.
- **Journalled as `undo-review`** (ADR 0013). The refusal check runs before the journal entry, so a refused undo leaves no trace. The entry holds the Review Item, the created object and a fresh accept-operation ID. Replay deletes the object only while it is live, moves the item to pending only while it is decided, and writes `review.undone` once (matched on the operation ID). A retry finds the open entry and finishes it.
- **The item gets a fresh `operation_id`.** The accept journal is keyed by it, and a finished entry would hand back the deleted object's ID on the next accept.
- **Ledger for History (#243):** `review.accepted` (object = the created object), `review.rejected` (object = the item) and `review.undone` (object = the item; `undone`, `deleted_object_id`).

## How it works (#242): merge, keep separate, link, apply change

The undo journal entry (`undo-review`) now carries a `revert` record next to the optional created object. `finishUndo` puts it back first, then moves the item to pending, then writes `review.undone` once. Each revert step is replay-safe (a file already back is skipped), so a crash at any step is finished by the retry or by recovery. The checks run before the journal entry, so a refusal writes nothing.

| Decision | What undo does | Refused (409, nothing written) when |
|---|---|---|
| **Merge** (accepted `person-merge`) | Restores the merged-away Person (live again, with its emails, aliases and name), the kept Person (moved emails and added Alias removed, name and `review_state` back) and every file the merge re-pointed | The merge has no record (made before #242), or any file it changed has a revision other than the one right after the merge. That covers the kept Person edited or merged again, and a re-pointed task or note edited |
| **Keep separate** (rejected `person-merge`) | Item back to pending. The "not proposed again" rule is the rejected item itself (the sweep skips any pair that has an item), so the same item simply waits again | One of the two People was deleted or merged into someone else since, or another pending or accepted suggestion exists for the pair |
| **Link resolution** (accepted) | Puts the link field back to what it held; a list loses only the linked ID | The field no longer holds the linked ID, or the item was accepted before #242 (no record of the old value) |
| **Apply change** (accepted `update`) | Puts the fields back to the proposal's `current` values and removes exactly the note it added. The item's guard (`base_revision`, `base_hash`) moves to the target as the undo left it, so Apply change works again | A changed field no longer holds the proposed value, or the added note was edited (Patch undo's rule); the change set a decision or open-point status or a decision link (final by the lifecycle rules, and a supersede changes two decisions); the change added a note and the item has no `applied_append` (accepted before #242 or after a crash retry) |

- **Where a merge records what it changed:** the `person.merged` audit (object = the kept Person) gains `undo_record`: per changed file its `before` and `after` values (the merge's plan, field by field), its `revision` right after the merge, and for a body only where the links were moved (`at`, `was_at`, `was`), never the body text. It is written with the audit, once per merge operation, from the journal's plan if the crash came after the item was marked accepted. The merge is found from the item's current `operation_id`; an undo gives the item a fresh one.
- **"Edited since" for a merge is the revision**, like create: strict, so one later edit to any re-pointed file refuses the whole undo rather than risk overwriting it.
- **A conflict found while undoing (an edit made in the crash window)** re-applies the files already put back, so the merge is whole again, and drops the undo with the refusal.
- **A link records its old value on the item before the link is written** (`link_undo`: target, field, previous, linked, whether it changed), in its own write, so a crash between the link and the item's accept cannot lose it. An undo clears it.
- **An `update` accept records the exact text it appended** (`applied_append`) on the item, because the note's leading blank line cannot be recovered from the body.
- **Ledger for History (#243):** `review.undone` also carries `reverted_object_ids` (every object put back; for a merge, the merged-away and kept People first), and for a merge `restored_person_id` and `kept_person_id`. `person.merged` is unchanged apart from `undo_record`.
- **Not done:** a link resolution made by creating a new Person does not delete that Person: the create is a separate action recorded nowhere, so undo takes back the link only.

## How it works (#243): Inbox History

`GET /api/v1/inbox/history` (`application.inboxHistory()`, `packages/application/src/inbox-history.ts`) builds the History tab from the audit ledger and writes nothing. It returns the last 100 entries (`inboxHistoryLimit`), newest first, Review actions and applied Patch Drafts together.

- **Rows:** one per decision event: `review.accepted`, `person.merged` (a merge; its `review_id` names the item) and `review.rejected`. The action word comes from the item's kind: merge / kept separate (`person-merge`), linked (`link-resolution`), applied (`update`), else accepted / rejected. An applied Patch Draft is one `patch.applied` event.
- **Undone:** per Review Item, the events are put in order; a decision is Undone when the next event for that item is a `review.undone`. So accept, undo, accept again lists two rows: the first Undone, the second live. A `link-resolution` or `update` accept audits the same target both times, so those audits now also carry the item's `operation_id` (fresh after every undo) and match on it; without that the second accept would leave no row.
- **Undoable:** not undone, the latest decision on the item, the item's status still equal to it, and `isReviewActionUndoable`. The server can still refuse with its reason; History shows it as the toast does. Undo of a patch row is `POST /inbox/patches/:id/undo`.
- **Who:** the event's `actor_type`. `person` (what every Review action the app records carries, and what events from before this change carry) is You; `system`, `agent` and `external` are System. Every `patch.applied` is System whatever its `actor_type`, because only Adoption applies a Patch Draft; from now on it is written with `actor_type: agent` (the Agent run) and a crash-recovery write with `system`. A future automatic accept or reject must write its audit with `actor: { type: "system" }` and History will label it.
- **Restricted:** the row carries `restricted` and the app shows the lock badge, as in the Inbox. The Agent Index never reads `audit/`, and a test checks that a restricted item's title is in no Agent Index file.
- **Open and Reopen:** Open <object> uses the accept's object (the created object, the changed target, the kept Person); it is absent once an undo took the object back. Reopen in Inbox for a rejected or kept-separate row is an Undo, then a jump to `/inbox/<item id>`.
