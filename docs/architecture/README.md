# Architecture baseline

LifeOS is a modular monolith. The browser calls application use cases through the localhost API. Application code owns orchestration; domain code owns invariants; adapters own Markdown, filesystem, connector, AI and secret-store details.

The stable app is a single localhost process on port 4310 that serves the API and the production web build; development runs separately on 5174/4311 against synthetic `.dev-data/` (ADR 0006). The Markdown data root is authoritative. It lives in Google Drive and is found only through `LIFEOS_DATA_ROOT`; the code lives outside Drive in `~/Developer/lifeos_app` (ADR 0014). The server and maintenance scripts refuse to start unless the root holds `.lifeos/schema.md`. The in-memory index is rebuilt at process start and may always be discarded. Google Calendar and (in tests only) mock AI adapters implement application-owned ports, keeping external services out of the domain and persistence layers.

The first complete flow now works without bypassing these boundaries:

1. Select a Google or mock calendar event from the timezone-aware day timeline.
2. Create its canonical meeting and meeting-note objects.
3. Capture Markdown.
4. Produce a durable review-item from a Claude-written Inbox Draft (ADR 0008). The live server has no AI provider; the mock AI adapter is for tests only (#98).
5. Accept it idempotently into an authoritative task.
6. Surface that task on Today and Project views.

The Meeting Workspace provides visual, raw Markdown, and preview modes; browser-draft recovery and Markdown autosave; contextual project/client/product/people links; and edit/accept/reject controls for proposals. Managed images support file selection, clipboard paste, drag-and-drop, readable unique names, hash-based deduplication, relative Markdown paths, and missing-asset diagnostics.

The Calendar workspace queries the selected, non-hidden Google calendars for an exact display-timezone day. It exposes calendar filtering, source colors, a chronological timeline, elapsed-time gaps, and durable links from calendar occurrences to canonical meeting notes.

The System workspace now validates the complete in-memory graph and displays the active advisory device lease. A foreign, unexpired lease makes the local API read-only until an explicit takeover; revision and content-hash checks remain the authoritative last line of defense. The holder releases its lease after 15 minutes without user activity and stays read-only until the user takes it back (ADR 0015, `apps/server/src/lease.ts`). Background object writers (adoption, external-edit audits) run only while `holdsLease()` is true; the heartbeat only extends a lease this device holds.

Versioned backups live in `LIFEOS_BACKUP_ROOT` (default `~/LifeOS-backups`), local to each Mac and outside Drive. Each read-only generation includes the portable data tree and a SHA-256 manifest. Verification performs a full restoration into a temporary directory and validates every restored file without touching the live data root. The session lease and the derived `_agent/` folder are excluded, `_inbox/` is included, and ten generations are retained.

Backups are automatic (ADR 0004, `packages/application/src/backups.ts`): at start, daily while running and at a clean stop, on the device holding the lease (and on one that released it for inactivity, since backups only read the data). A weekly copy of the newest verified backup goes to an off-Drive folder (four kept). That folder is a device-specific setting the server reads, so it is stored keyed by device ID in `settings/backups.md` (ADR 0005). Backups and adoption batches share one run-one-at-a-time queue (`ctx.runExclusive`, ADR 0013). A failure or a 26-hour gap shows a warning on Today and System Health.

A clean stop (`apps/server/src/shutdown.ts`) refuses HTTP writes with 503, closes HTTP, waits for adoption to go idle, takes the stop backup and then releases the lease. Every step is bounded so the whole sequence ends before the stop script's 60-second force-stop.

Agents never write objects (ADR 0007). They drop Inbox Drafts into `_inbox/drafts/`; the application's adoption module (`packages/application/src/adoption.ts`) reads them through the `InboxStore` port, validates the draft contract, routes by kind and origin, writes the objects, and files each draft in `_inbox/processed/` or `_inbox/failed/` with a `.result.md` sidecar. Adoption runs at startup, a few seconds after a draft lands, and on "Adopt now"; it is idempotent on `draft_key` plus content hash, using `draft.adopted` audit events as its ledger. The object scan ignores `_inbox/` and `_agent/`.

Agents read the Agent Index (ADR 0009): `packages/application/src/agent-index.ts` builds small Markdown summaries from the in-memory index after each rebuild (debounced) and writes them through the write-only `AgentIndexWriter` port (`FilesystemAgentIndexWriter`) into `_agent/`. The application never reads `_agent/` back; restricted objects are counted, never listed; a failed write shows in System Health.

Every step that writes more than one file follows one crash-recovery pattern (ADR 0013): it is journalled in `.lifeos/operations/` before its first write, takes replay IDs from the journal by role, writes each audit once, runs one at a time per key, and creates files exclusively. A user intent recorded as its own operation (such as rejecting a Review Item whose accept was interrupted) wins over the operation it undoes.

Each save keeps a version copy in `.lifeos/versions/<id>/`; only the last 10 per object are kept (ADR 0012). The newest copy is the baseline for spotting edits made outside the app, including edits made while it was closed or on the other computer.

The app removes object files in one case only: "Delete permanently" on a note already in Notes › Deleted (ADR 0017). It is a journalled `purge-note` operation that removes the file and its version copies, refused while another object references the note in its front matter.

The user's own email addresses and internal domains are synced settings (`settings/self-emails.md`, `settings/internal-domains.md`), never code. Secrets go through `KnownSecrets` over the Keychain store: connection status is answered from what the app has already seen, so only connect, sync, the start-up probe and an explicit Retry read the Keychain.

The History panel lists an object's version copies and restores one through the guarded write (`packages/application/src/history.ts`). A restore keeps the object's current sensitivity and review state, and is refused if the object changed since the panel was opened (it sends the content hash it was opened with).

The calendar endpoints get their connector from `apps/server/src/calendar-source.ts`. The mock calendar answers only in explicit dev/mock mode. When Google Calendar fails (network, sign-in or Keychain denied), the calendar module returns the meetings already stored in LifeOS with an `offline` reason and last sync time, and Today and the calendar view show an Offline banner with Retry. Nothing stored is changed while offline.

The visual editor's round trip is tested in CI (`tests/integration/editor-round-trip.test.ts`). Constructs it rewrites are listed there as known failures; the web app labels a note that holds one "Unproven formatting", and blocks a Visual-mode save that would drop an image.

The Claude skills in `skills/` are the agent side of the Inbox Draft contract. Their examples are fixtures run through real adoption in `tests/integration/skill-fixtures.test.ts`, so skill text and adoption code change together. The skills run in Claude, not in this process; the app only sees the drafts they write and the Work Orders they file.

Agent guardrails (ADR 0014): `scripts/hooks/data-guard.mjs` is a Claude Code `PreToolUse` hook that blocks agent writes to the data root outside `_inbox/`, and `scripts/prune-worktrees.mjs` removes clean, pushed, idle agent worktrees at the end of each Claude Code session.
