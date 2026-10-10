# ADR 0013: One crash-recovery pattern

- Status: Accepted
- Date: 2026-10-04
- Source: issue #74 (review of the fix tickets #53–#73); amended by #78 (audit once on every journalled path, exceptions list) and #82 (`reject-review`: a recorded intent wins over the operation it undoes)

A step is **replay-safe** when running it again after a crash, or twice at once, ends in the same files as running it once. Every step that writes more than one file must be replay-safe. Pick the mechanisms below by what the step does. Each has one helper; do not hand-write another.

| The step… | Use | Helper |
|---|---|---|
| writes several files that must all land, or be undone | Journal it before the first write; recovery finishes or rolls it back | `prepareOperation` / `completeOperation`, and a handler in `SystemModule.recovery` |
| creates objects and may be replayed | Take IDs from the journal entry, keyed by role; wrap the replay in `ctx.replaying` | `run.newId(replayRoles.…)`, `replayableId`, `replayScope` |
| proposes a Review Item (#122) | Write it through the one factory: replayable ID and operation ID, source sensitivity carried (ADR 0018); a step with no journal entry seeds its IDs from what it proposes from and records its Agent run once; a step revising its own pending item revises it there too | `proposeReviewItem`, `seededRun`, `recordAgentRun`, `reviseReviewItem` (review-items.ts) |
| writes an audit event a replay could write again | Write it only if no matching audit exists | `ctx.writeAuditOnce(…, { matchOn })`; look up audits with `ctx.findAudits` |
| can be called twice at once (double-click, two tabs, watcher bursts) | Run calls one at a time per key | `OneAtATime.run(key, work)` |
| reads the data a multi-file step writes (a backup snapshot during adoption) | Share that step's queue | `ctx.runExclusive` (adoption batches and backups, #95) |
| creates a file that must not already exist | Publish it exclusively, with the fallback for file systems that refuse hard links | `createExclusive` (object store) |

**Operations journal.** `operationKinds` (ports.ts) lists every kind; `Operation` is the one shape. Each kind has a startup recovery handler in `SystemModule.recovery`, except those in `notRecoveredAtStartup`: adoption replays `adopt-draft` and `adopt-batch` itself at the start of its next batch. A new kind does not compile until it gets a handler or joins that list.

**A recorded intent wins.** When a user action undoes another open operation (rejecting a Review Item whose accept or merge was interrupted), the action is journalled as its own kind (`reject-review`) before the first undo write. Recovery of the undone kind checks for that intent first and finishes the undo instead, so a crash part-way through never completes the opposite of what the user chose. The same check runs when the user tries to accept an item whose reject is still open. `review.rejected` is then written once, matched on the reject operation's ID.

**Role keys.** A role names what an ID is for (`main`, `summary`, `merge:<pair>`), never what an attempt found already written. Build roles only with `replayRoles`. Their text is stored data, since each ID is derived from it, so an existing role's text never changes.

**Audit once.** The match rule is the metadata keys that identify "the same audit", e.g. `draft_key` for an adopted draft, `superseded_by` for a superseded brief, none for a merge suggestion. Replays rebuild the index first, so they see what the first attempt wrote.

Every audit written while an operation is open (between `prepareOperation` and `completeOperation`, or on a recovery or rollback path) uses `writeAuditOnce`, so a crash after the audit and before the operation closes never writes it twice. Match on the operation's ID (`operation_id` in the metadata), or on `review_id` for `review.accepted`, or on the draft's `draft_key` (and `content_hash` for a patch) for adoption. Plain `writeAudit` is for single-write steps that no journal replays.

**Allowed exceptions.** These stay hand-written; anything else uses the helpers above.

| Exception | Where | Why it is not a helper |
|---|---|---|
| Rebuild coalescing | `rebuildIndex` | Shares one in-flight scan and one follow-up scan between callers; not one-at-a-time |
| Self person creation | `ensureSelfPerson` | Shares one in-flight creation until the index holds it |
| Adoption trigger coalescing | `startAutoAdoption` (`waiting`) | At most one trigger batch waits in the queue; later watcher events are covered by it, so they are dropped, not queued |
| Ledger reads that skip a whole step | `findAudits` in adoption replay, `recoverJournal` and `undoPatch` | They decide whether a step still has work (a patch already applied, raised for review, or undone), not whether to write an audit |

Why: the fix tickets added five overlapping ways to do this, in several hand-written copies that had started to drift. One of them missed a case: a merge suggestion replayed after a crash lost its `review.proposed` audit. One documented pattern keeps new code from adding a sixth.
