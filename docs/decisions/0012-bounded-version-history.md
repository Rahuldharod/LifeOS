# ADR 0012: Bounded version history for external-edit detection

- Status: Accepted
- Date: 2026-10-04
- Source: issue #72 (review of #69); decision by Rahul, 2026-10-04

**Per-save copies.** Each save keeps a copy of the object in `.lifeos/versions/<id>/<revision>--<hash>.md`. The hash part is the start of the hash of the file the copy came from. When the app notices an edit made outside it (Obsidian, an agent, another device), it also keeps the copy from before the edit.

**Retention.** Only the last 10 copies per object are kept (configurable, at least 2). Older copies are deleted on save. "Last" means highest revision, then most recently saved. The newest copy and the copy just saved are never deleted. An old audit event may point at a copy that has since been pruned.

**Baseline.** The newest copy is the baseline for external-edit detection: the last state the app knows about. If the file on disk differs from it, the edit is recorded as an `external` audit event, and the edited file becomes the new baseline.

**Startup cost.** At start, each object's baseline is checked by listing its versions folder. No copy is read. If the file's revision and hash match the newest copy's file name, nothing changed. A copy is read only when they differ. Modification times are read only to order two copies of the same revision.

**Other devices.** A file with a newer revision but no copy yet is handled by its `updated_by_device` stamp:

- Stamped by this device: the app stopped between saving and keeping the copy. The file becomes the baseline.
- Stamped by another device: its copy has not synced yet. The app waits for that copy and does not take the file as the baseline. When the copy arrives, any Obsidian edit made on top of it is recorded as external.

If that copy never arrives, edits on top of it are not flagged.

**Backups.** Backups (ADR 0004) include `.lifeos/versions/`, so a restored vault keeps its baselines. Retention keeps that bounded: at most 10 copies per object.

Why: #69 kept every revision forever, so the vault kept growing (all synced over Drive) and every start read every object's latest copy. Ten copies cover recent undo and detection, with a known, small cost.
