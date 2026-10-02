# LifeOS Product Backlog

Last reviewed: 2026-10-02

This file is the durable product-level backlog for LifeOS. It captures problems and opportunities before they are detailed enough to become implementation work.

## How to use this backlog

1. Capture new ideas in **Inbox** without trying to fully specify them.
2. During backlog review, clarify the user problem, expected outcome, impact, and effort.
3. Promote the strongest candidates to **Now**, **Next**, or **Later**.
4. Once an item is ready for implementation, create a GitHub Issue and add its link here.
5. Keep completed implementation history in GitHub; keep product intent and prioritization decisions in this file.

### Priority scoring

Use a lightweight score rather than false precision:

- **Impact:** 1 (small) to 5 (transformational)
- **Confidence:** Low, Medium, or High
- **Effort:** 1 (small) to 5 (large)
- **Priority score:** Impact ÷ Effort, used as guidance rather than an automatic decision

## Now

Items required to make the current version dependable for regular use.

| ID | Improvement | User problem / desired outcome | Impact | Confidence | Effort | Owner | GitHub |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| PB-004 | Duplicate meeting reconciliation (absorbs PB-022c) | Stop the creation race that made two Product Weekly meetings 80 ms apart (per-event lock; identity = provider + calendar + event id), then a one-off dry-run → `--apply` cleanup that keeps the richest copy and archives the empty one, logged to audit. Out of scope: recreating notes for never-opened events (normal since PB-020) and Sync Run cleanup. | 4 | High | 3 | — | — |

## Next

High-value capabilities to address after the current version is stable.

| ID | Improvement | User problem / desired outcome | Impact | Confidence | Effort | Owner | GitHub |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| PB-003 | Visual-editor quality pass | Ensure Markdown and Visual modes round-trip headings, emphasis, lists, task boxes, code, tables, links, images, and LifeOS links without formatting drift. Moved from Now on 2026-10-02: the daily-use symptom is covered by PB-019. | 5 | High | 3 | — | — |
| PB-018 | In-app feedback button | Feedback button beside Settings at the bottom of the nav bar. Single user, text only. Submitting appends a formatted row to the Inbox of this Product Backlog (Captured date, Idea with Bug/Feature label and next PB ID, Source/context with the current page). Supersedes the 2026-09-21 feedback idea. Needs a decision on writing into the code repo at runtime, see ADR 0001. | 3 | High | 2 | — | — |
| PB-023 | Group Latest notes by date | In Notes → Latest notes, group by date shown as “day month-in-words” with a divider between days. | 3 | High | 1 | — | — |
| PB-024 | Use more screen space | Content on all tabs fills the width and height of 13-inch Retina and 4K displays. Widen the Latest notes column so longer titles do not wrap. Build with PB-023, same column. | 3 | High | 2 | — | — |
| PB-022b | Persist synced events locally | The Calendar tab depends on a live Google call, so a token or network failure leaves the day blank. Store the last synced events per day (derived, rebuildable) and show them, marked as stale, when Google is unreachable. Split from PB-022. | 4 | Medium | 3 | — | — |
| PB-005 | Note search, filtering, and sorting | Find notes by title, body, type, date, project, client, product, or person. | 4 | High | 3 | — | — |
| PB-006 | Editable note titles and metadata | Change a note title and its relationships without manually editing YAML front matter. | 4 | High | 2 | — | — |
| PB-007 | LifeOS link navigation | Clicking a `lifeos://object/...` link should open the linked object inside the application. | 4 | High | 2 | — | — |
| PB-008 | Image management panel | Edit alternative text, inspect usage, replace images, and safely remove orphaned managed assets. | 3 | High | 3 | — | — |
| PB-009 | Complete Google Drive connection | Turn the stored Drive credentials into a working source/synchronization connector with clear scope and health reporting. | 4 | Medium | 4 | — | — |
| PB-010 | Relationship picker improvements | Make project, client, product, and people relationships searchable and editable across all object forms. | 4 | High | 3 | — | — |
| PB-011 | Note history and restoration | Browse prior Markdown revisions and restore an earlier version without using the filesystem manually. | 4 | High | 3 | — | — |

## Later

Valuable ideas that are not prerequisites for dependable daily use.

| ID | Improvement | User problem / desired outcome | Impact | Confidence | Effort | Owner | GitHub |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| PB-012 | Background calendar synchronization | Keep events current without requiring a manual sync while retaining an auditable Sync Run. | 3 | Medium | 4 | — | — |
| PB-013 | Saved views and filters | Save reusable views such as “client meetings this month” or “high-priority waiting tasks.” | 3 | Medium | 3 | — | — |
| PB-014 | Command palette and keyboard shortcuts | Navigate, create, link, and format content efficiently without leaving the keyboard. | 3 | Medium | 3 | — | — |
| PB-015 | Backlog inside LifeOS | Represent product ideas as first-class LifeOS objects, with prioritization and links to projects or GitHub Issues. | 3 | Medium | 4 | — | — |
| PB-016 | Mobile/read-only companion | Provide a safe way to review notes and tasks from a smaller device without creating concurrent-write risk. | 3 | Low | 5 | — | — |

## Inbox

Note: PB-015 and PB-016 were reused in Git history for shipped work (tab-refocus reconciliation, discard-draft undo), colliding with the Later items of the same ID. New items start at PB-017. [TBD: renumber or reconcile.]

Capture raw ideas here. Promote them only after the problem and expected outcome are clear.

| Captured | Idea | Source / context |
| --- | --- | --- |
| 2026-09-21 | Add accessibility labels and tooltips to every visual-editor formatting control. | Visual editor usability |
| 2026-09-21 | Add configurable autosave timing and a visible “browser draft recovered” history. | Note reliability |

## Completed

Keep this section brief. Detailed delivery history should live in GitHub Issues and releases once GitHub is connected.

| ID | Delivered capability | Completed |
| --- | --- | --- |
| — | Recent-notes workspace with view, edit, preview, and Markdown save | 2026-09-21 |
| — | Markdown-native Visual editing mode | 2026-09-21 |
| — | Managed local image assets with deduplication and health diagnostics | 2026-09-21 |
| — | Immediate browser draft cache and idle Markdown autosave | 2026-09-21 |
| PB-002 | Autosave recovery experience: side-by-side conflict panel, unified meeting-note editor, tab-refocus check, one-shot undo | 2026-09-28 |
| PB-017 | Settings button no longer overlaps the token-refresh message in the nav bar | 2026-10-02 |
| PB-019 | Editor ribbon and styling correct on first open | 2026-10-02 |
| PB-020 | Opening an event saves nothing until the first real edit | 2026-10-02 |
| PB-022a | Google token failure is visible: Reconnect banner with last sync time, real error in the timeline, throttled failed Sync Runs | 2026-10-02 |
| PB-021 | Delete a note as a tombstone (`deleted_at`, file kept, confirm first); no in-app restore yet | 2026-10-02 |
| PB-001 | Stable launcher: `pnpm start/stop/status/update-app` runs the built app in the background on 4310 (no reloads), "Reconnecting…" banner with autosave retry, dev isolated on 5174/4311 with synthetic data and mock calendar | 2026-10-02 |
| PB-025 | Notes: Open/Deleted tabs, keyword search (every word, ignoring case and accents) and restore; restore refused when the meeting has a newer note | 2026-10-02 |

## Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-09-21 | Use this Markdown file for product intent and early-stage ideas; use GitHub Issues for implementation-ready work. | The product repository remains portable and human-readable, while GitHub provides workflow, ownership, discussion, and delivery traceability. |
| 2026-10-02 | Feedback is single-user and text-only, so the in-app button writes straight into this backlog's Inbox, not a separate feedback folder. | No new object type or schema needed; entries follow the backlog format. |
| 2026-10-02 | Triaged PB-017 to PB-024. Order in Now: PB-017, PB-022, PB-020, PB-019, PB-021, PB-001, PB-004. PB-003 moved to Next, PB-002 marked complete. | Fix what blocks daily use first; keep Now to seven items. |
| 2026-10-02 | Split PB-022 into 022a (Now), 022b and 022c (Next). | Diagnosis showed the root cause is an expired token shown as an empty day; fix visibility first, then resilience and cleanup. |
| 2026-10-02 | Notes search starts as a keyword filter on the in-memory index (no new package); add MiniSearch only if results feel poorly ordered or typos matter. | The index already holds every note; at 87 files and about 44 KB a scan is instant, and the real scaling cost is the full re-read after each save, which is a separate item. |
| 2026-10-02 | PB-001: terminal commands first (no macOS app yet); one process on 4310 serves UI and API; `update-app` builds before stopping so a failed build never takes the app down; PID file and log live on the device, not in Drive. | Confirm the stable build solves the reloads before investing in macOS packaging; a Drive-synced PID file would mislead the other device. |
| 2026-10-02 | Dev mode never touches real data: ports 5174/4311, `.dev-data/` seeded from fixtures, mock calendar. | Two servers writing `../data` at once is not covered by the advisory lease. |
| 2026-10-02 | PB-022c merged into PB-004. Survey: one duplicate (Product Weekly 2026-09-21), caused by a check-then-write race in `createMeetingFromEvent`; one missing note is a never-opened event, not a defect. | Avoid building the same duplicate detector twice; fix the cause, not just the symptom. |
