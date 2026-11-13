# ADR 0015: Release the device lease after inactivity

- Status: Superseded by [ADR 0024](0024-lease-stays-until-taken-over.md) (2026-11-13): no idle release; the lease moves only by takeover
- Date: 2026-10-07
- Amends: ADR 0003 (advisory two-device lease)

## Context

The desktop Mac is often left running while the laptop is used. Before this ADR the lease heartbeat renewed the lease every minute while the app ran, so the laptop stayed read-only until the user walked back to the desktop or forced a takeover.

## Decision

- The lease holder **releases its lease after N minutes without user activity** (default 15; `LIFEOS_IDLE_RELEASE_MINUTES`). Releasing expires the lease now in `.lifeos/session.md`. The check runs with the existing one-minute heartbeat (`apps/server/src/lease.ts`).
- **User activity** is:
  - the browser's activity signal (`POST /api/v1/session/activity`), sent only after a real key press, click, scroll or pointer move in a visible, focused tab, at most once a minute;
  - any successful write request, except backups, backup verification, calendar sync, index rebuild, connection retry and "Adopt now";
  - the explicit takeover.
- **Not activity:** the heartbeat timer, automatic adoption, automatic and daily backups, the file watcher, calendar reads and any other read. The heartbeat only extends a lease this Mac already holds; it never claims one.
- **After a release** the Mac is read-only exactly like a Mac that sees another device's lease (writes answer 423). It **never takes the lease back by itself**, even when no other Mac claims it. Every page shows a banner with **Take back**, which is the existing takeover. If the other Mac has the lease by then, the banner shows the takeover caution (the other Mac may still be active; let Drive finish syncing).
- **Background writers** (automatic adoption, external-edit audits, person-merge suggestions) run only while this Mac holds the lease (`holdsLease()`). Backups only read the data folder, so they keep running after an idle release; they still stop on a Mac that started read-only behind another device's lease.
- The other Mac claims a free lease on its user's first activity there (a save or the activity signal), not from its own timer.
- `last_activity_at` in the lease file now records user activity only; the heartbeat moves only `lease_expires_at`.

## Consequences

- Leaving the desktop running no longer blocks the laptop for more than about 15 minutes, plus Drive sync time.
- Coming back to the desktop needs one click (Take back). That is deliberate: an automatic reclaim could take the lease from the laptop while it is still being used.
- The lease stays advisory (ADR 0003): revision and content-hash checks remain the real protection.
