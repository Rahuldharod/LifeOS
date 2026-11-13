# ADR 0024: The lease stays with its Mac until the other Mac takes it over

- Status: Accepted
- Date: 2026-11-13
- Supersedes: ADR 0015 (release the device lease after inactivity)
- Amends: ADR 0003 (advisory device lease), ADR 0016 (quiet Drive writes)

## Context

ADR 0015 made the lease holder give up its lease after 15 minutes without user activity, and stay read-only until the user clicked **Take back**. In practice the user works on one Mac for a whole day and the other Mac on another day. Stepping away for 15 minutes was enough to make LifeOS read-only on the Mac in use, so it kept needing a click to reactivate.

## Decision

- **No idle release.** The Mac holding the lease keeps it for as long as LifeOS runs there. The one-minute heartbeat only extends a lease this Mac holds; it never claims one. `LIFEOS_IDLE_RELEASE_MINUTES` is gone.
- **Only the other Mac's explicit takeover moves a live lease.** While another Mac holds it, every page shows a banner: "LifeOS is in use on {Mac}" with **Use LifeOS here** (the existing takeover). The Mac that lost the lease shows the same banner and never takes it back by itself.
- **Expiry stays as crash and sleep safety.** A lease still expires 15 minutes after its holder stops renewing (asleep, shut down, crashed). The other Mac then claims it on its user's first activity (a save or the browser activity signal), with no click. A Mac that wakes after the other has claimed it is read-only and shows the banner.
- **The newest claim wins.** A takeover now often happens while the old holder is still running, so the old holder's renewal can reach Drive after the takeover and overwrite it. Each Mac remembers its own latest claim time (`started_at`). If it reads a live foreign lease that started before its own claim, that is a late renewal: it writes its claim again (at most once a minute). The old holder reads the newer claim and turns read-only.
- **Background writers** (automatic adoption, external-edit audits, person-merge suggestions, the Agent Index) still run only while `holdsLease()`. **Backups** keep running on a Mac that held the lease during this run and was then taken over; they still stop on a Mac that started read-only.
- The takeover caution changes from "only after LifeOS is closed on the other computer" to: saves on the other Mac stop once you switch; if you just edited there, let Drive finish syncing first.

## Consequences

- LifeOS no longer goes read-only on the Mac you are using, however long you step away.
- Switching to a Mac where the other one is still running and awake needs one click (**Use LifeOS here**). If the other Mac is asleep or closed, no click is needed after 15 minutes.
- During the Drive sync after a takeover (seconds to a minute), the old holder's background writers may still run. The lease stays advisory (ADR 0003): revision and content-hash checks remain the real protection.
