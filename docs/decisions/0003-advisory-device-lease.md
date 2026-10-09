# ADR 0003: Advisory two-device lease with independent conflict checks

- Status: Accepted; amended by [ADR 0015](0015-idle-lease-auto-handover.md) (2026-10-07): the holder releases the lease after 15 minutes without user activity and stays read-only until the user takes it back; amended by [ADR 0016](0016-quiet-drive-writes.md) (2026-10-09): 15-minute lease, lease file rewritten at most every 5 minutes.
- Date: 2026-09-21

LifeOS records the active installation in `.lifeos/session.md` using the device ID, session start, last activity and a short lease expiry. A second device that sees an unexpired foreign lease starts read-only and exposes an explicit takeover action. Takeover is appropriate only after the first device is closed and Google Drive synchronization is complete.

The lease is advisory because a synchronized file may arrive late. It is therefore never the sole concurrency control: every object save still compares the original content hash and revision, and conflicts are surfaced rather than overwritten. The System view reports the active lease and graph diagnostics for duplicate IDs, broken references, relationship type mismatches, multiple self-person records and duplicate canonical meeting notes.
