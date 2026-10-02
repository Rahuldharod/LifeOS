# ADR 0006: Separate stable and development runtimes

- Status: Accepted
- Date: 2026-10-02

The user's daily LifeOS is one background process on `127.0.0.1:4310`: Fastify serves both the API and the production web build, with no file watcher, so code changes never reload it mid-note. `scripts/lifeos.mjs` starts, stops and updates it; `update-app` builds before stopping, so a failed build leaves the running app untouched. Its PID file and log live on the device (`~/Library/Application Support/LifeOS`, `~/Library/Logs/LifeOS`), not in the synced Drive folder, so the other device never sees a stale PID.

Development (`pnpm dev`) runs on 5174/4311 against synthetic data in `.dev-data/` and the mock calendar. It never touches `../data`: the advisory lease (ADR 0003) does not protect against two local servers writing the same root, and Google's OAuth callback is registered for 4310 only.

Archiving an object sets `archived_at` in place through `ObjectStore` (revision and hash checks apply); files are not moved to `data/archive/`. Archived objects are excluded from note lists, meeting lookups and duplicate diagnostics.

Not yet decided: a double-clickable macOS app or start-at-login. Revisit once the terminal commands have proven the stable build solves the reloads.
