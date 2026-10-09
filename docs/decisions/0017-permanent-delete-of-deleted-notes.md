# ADR 0017: The app may permanently delete a deleted note

- Status: Accepted
- Date: 2026-10-09
- Source: PB-030, issue #103
- Amends: ADR 0007 (only the application writes objects; it now also removes one kind of object file), ADR 0012 (a purged note's version copies go with it)

## Context

Deleting a note only sets `deleted_at` (PB-021), so the file stays on disk and obsolete notes pile up in Notes › Deleted. Removing them by hand in Finder bypasses the lease, the audit trail and the reference checks.

## Decision

**What.** "Delete permanently" on the Deleted tab removes a note's Markdown file and its kept copies in `.lifeos/versions/<id>/`. Only meeting and knowledge notes that are already tombstoned qualify. No other object type is ever removed by the app.

**Guards.**

- The request carries the note's `expectedHash`; a note changed since the list loaded is refused (409).
- It is a write, so it needs the device lease (423 without it, ADR 0003).
- It is refused while any other object names the note in a front-matter `*_id` or `*_ids` field; the refusal lists them. Audit events are not references (their `object_id` is history).
- `lifeos://object/<id>` links in other objects' bodies do not block. The pop-up lists them: their links will show as missing.

**Steps and recovery (ADR 0013).** The delete is journalled as a `purge-note` operation, then: remove the file (only while its hash still matches), remove the versions folder, write the audit once, close the operation, rebuild the index. Each step is safe to repeat. A crash in between is finished at the next start or by retrying the same delete. If the note changed, was restored or gained a reference before the file was removed, recovery removes nothing and closes the operation.

**Audit.** `note.purged` with the note's id, its title and the operation id. Never the body.

**Backups.** Existing backups still hold the note (ADR 0004); the pop-up says so. That is the only way back.

## Consequences

- A purged note's ID no longer resolves. Body links to it show as missing; front-matter links cannot dangle because they block the delete.
- An accepted Review Item or an agent run that names the note in `source_ids` or `related_object_ids` keeps the note from being purged. That is deliberate: the user removes the link first.
