# ADR 0013: One crash-recovery pattern

- Status: Accepted
- Date: 2026-10-04
- Source: issue #74 (review of the fix tickets #53–#73)

A step is **replay-safe** when running it again after a crash, or twice at once, ends in the same files as running it once. Every step that writes more than one file must be replay-safe. Pick the mechanisms below by what the step does. Each has one helper; do not hand-write another.

| The step… | Use | Helper |
|---|---|---|
| writes several files that must all land, or be undone | Journal it before the first write; recovery finishes or rolls it back | `prepareOperation` / `completeOperation`, and a handler in `SystemModule.recovery` |
| creates objects and may be replayed | Take IDs from the journal entry, keyed by role; wrap the replay in `ctx.replaying` | `run.newId(replayRoles.…)`, `replayableId`, `replayScope` |
| writes an audit event a replay could write again | Write it only if no matching audit exists | `ctx.writeAuditOnce(…, { matchOn })`; look up audits with `ctx.findAudits` |
| can be called twice at once (double-click, two tabs, watcher bursts) | Run calls one at a time per key | `OneAtATime.run(key, work)` |
| creates a file that must not already exist | Publish it exclusively, with the fallback for file systems that refuse hard links | `createExclusive` (object store) |

**Operations journal.** `operationKinds` (ports.ts) lists every kind; `Operation` is the one shape. Each kind has a startup recovery handler in `SystemModule.recovery`, except those in `notRecoveredAtStartup`: adoption replays `adopt-draft` and `adopt-batch` itself at the start of its next batch. A new kind does not compile until it gets a handler or joins that list.

**Role keys.** A role names what an ID is for (`main`, `summary`, `merge:<pair>`), never what an attempt found already written. Build roles only with `replayRoles`. Their text is stored data, since each ID is derived from it, so an existing role's text never changes.

**Audit once.** The match rule is the metadata keys that identify "the same audit", e.g. `draft_key` for an adopted draft, `superseded_by` for a superseded brief, none for a merge suggestion. Replays rebuild the index first, so they see what the first attempt wrote.

**Sharing one in-flight run** is a different need and stays hand-written: `rebuildIndex` coalesces callers into one follow-up scan, and `ensureSelfPerson` shares one creation.

Why: the fix tickets added five overlapping ways to do this, in several hand-written copies that had started to drift. One of them missed a case: a merge suggestion replayed after a crash lost its `review.proposed` audit. One documented pattern keeps new code from adding a sixth.
