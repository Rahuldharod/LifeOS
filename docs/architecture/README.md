# Architecture baseline

LifeOS is a modular monolith. The browser calls application use cases through the localhost API. Application code owns orchestration; domain code owns invariants; adapters own Markdown, filesystem, connector, AI and secret-store details.

The stable app is a single localhost process on port 4310 that serves the API and the production web build; development runs separately on 5174/4311 against synthetic `.dev-data/` (ADR 0006). The Markdown data root is authoritative and lives at `../data` by default. The in-memory index is rebuilt at process start and may always be discarded. Google Calendar and mock AI adapters implement application-owned ports, keeping external services out of the domain and persistence layers.

The first complete flow now works without bypassing these boundaries:

1. Select a Google or mock calendar event from the timezone-aware day timeline.
2. Create its canonical meeting and meeting-note objects.
3. Capture Markdown.
4. Produce a durable review-item using the mock AI adapter.
5. Accept it idempotently into an authoritative task.
6. Surface that task on Today and Project views.

The Meeting Workspace provides visual, raw Markdown, and preview modes; browser-draft recovery and Markdown autosave; contextual project/client/product/people links; and edit/accept/reject controls for proposals. Managed images support file selection, clipboard paste, drag-and-drop, readable unique names, hash-based deduplication, relative Markdown paths, and missing-asset diagnostics.

The Calendar workspace queries the selected, non-hidden Google calendars for an exact display-timezone day. It exposes calendar filtering, source colors, a chronological timeline, elapsed-time gaps, and durable links from calendar occurrences to canonical meeting notes.

The System workspace now validates the complete in-memory graph and displays the active advisory device lease. A foreign, unexpired lease makes the local API read-only until an explicit takeover; revision and content-hash checks remain the authoritative last line of defense.

Versioned backups live in `../backups`. Each read-only generation includes the portable data tree and a SHA-256 manifest. Verification performs a full restoration into a temporary directory and validates every restored file without touching the live data root. The session lease and the derived `_agent/` folder are excluded, `_inbox/` is included, and ten generations are retained.

Agents never write objects (ADR 0007). They drop Inbox Drafts into `_inbox/drafts/`; the application's adoption module (`packages/application/src/adoption.ts`) reads them through the `InboxStore` port, validates the draft contract, routes by kind and origin, writes the objects, and files each draft in `_inbox/processed/` or `_inbox/failed/` with a `.result.md` sidecar. Adoption runs at startup, a few seconds after a draft lands, and on "Adopt now"; it is idempotent on `draft_key` plus content hash, using `draft.adopted` audit events as its ledger. The object scan ignores `_inbox/` and `_agent/`.

Agents read the Agent Index (ADR 0009): `packages/application/src/agent-index.ts` builds small Markdown summaries from the in-memory index after each rebuild (debounced) and writes them through the write-only `AgentIndexWriter` port (`FilesystemAgentIndexWriter`) into `_agent/`. The application never reads `_agent/` back; restricted objects are counted, never listed; a failed write shows in System Health.

Every step that writes more than one file follows one crash-recovery pattern (ADR 0013): it is journalled in `.lifeos/operations/` before its first write, takes replay IDs from the journal by role, writes each audit once, runs one at a time per key, and creates files exclusively. A user intent recorded as its own operation (such as rejecting a Review Item whose accept was interrupted) wins over the operation it undoes.

Each save keeps a version copy in `.lifeos/versions/<id>/`; only the last 10 per object are kept (ADR 0012). The newest copy is the baseline for spotting edits made outside the app, including edits made while it was closed or on the other computer.

The user's own email addresses and internal domains are synced settings (`settings/self-emails.md`, `settings/internal-domains.md`), never code. Secrets go through `KnownSecrets` over the Keychain store: connection status is answered from what the app has already seen, so only connect, sync, the start-up probe and an explicit Retry read the Keychain.
