# ADR 0016: Write synced files only when something changed

- Status: Accepted
- Date: 2026-10-09
- Amends: ADR 0003 (advisory device lease), ADR 0009 (Agent Index)

## Context

Google Drive uploaded the nine `_agent/` files every 20–40 seconds while the app ran. Each index rebuild (the inbox sweep every minute, watcher events) rewrote all nine, and only `generated_at` had changed. Both Macs wrote `_agent/`, so Drive made conflict copies (`people 2.md`, `_agent 2/`). The lease file `.lifeos/session.md` was rewritten every minute by the heartbeat.

## Decision

- **Agent Index:** a file is written only when its content changed apart from its generation time. `generated_at` therefore means "last changed". Only the lease holder writes `_agent/`.
- **File watcher:** Drive's conflict copies of app folders (`_agent 2/`, `_inbox 2/`, `.lifeos 2/`) are ignored.
- **Lease:** 15 minutes instead of 5. While this Mac holds a live lease, the lease file is rewritten at most once every 5 minutes (a third of the lease): heartbeat renewals and recorded activity sooner than that are skipped. Claims, takeovers, releases and clean stops always write. `last_activity_at` can lag real activity by up to 5 minutes; the idle timer (ADR 0015) runs in memory and is unaffected.

## Consequences

- An idle app writes nothing to Drive except the lease file every 5 minutes, and nothing at all after the idle release (15 minutes, ADR 0015).
- If a Mac crashes or sleeps without a clean stop, the other Mac sees its lease for up to 15 minutes (was 5). "Take over" remains available sooner.
- Drive sync can take minutes, so the longer lease also makes a slow sync less likely to look like an expired lease.
