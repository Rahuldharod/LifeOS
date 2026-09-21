# ADR 0003: Advisory two-device lease with independent conflict checks

- Status: Accepted
- Date: 2026-09-21

LifeOS records the active installation in `.lifeos/session.md` using the device ID, session start, last activity and a short lease expiry. A second device that sees an unexpired foreign lease starts read-only and exposes an explicit takeover action. Takeover is appropriate only after the first device is closed and Google Drive synchronization is complete.

The lease is advisory because a synchronized file may arrive late. It is therefore never the sole concurrency control: every object save still compares the original content hash and revision, and conflicts are surfaced rather than overwritten. The System view reports the active lease and graph diagnostics for duplicate IDs, broken references, relationship type mismatches, multiple self-person records and duplicate canonical meeting notes.
