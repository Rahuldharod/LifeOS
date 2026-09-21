# Architecture baseline

LifeOS is a modular monolith. The browser calls application use cases through the localhost API. Application code owns orchestration; domain code owns invariants; adapters own Markdown, filesystem, connector, AI and secret-store details.

The Markdown data root is authoritative and lives at `../data` by default. The in-memory index is rebuilt at process start and may always be discarded. Google Calendar and mock AI adapters implement application-owned ports, keeping external services out of the domain and persistence layers.

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

Versioned backups live in `../backups`. Each read-only generation includes the portable data tree and a SHA-256 manifest. Verification performs a full restoration into a temporary directory and validates every restored file without touching the live data root. The session lease is excluded, and ten generations are retained.
