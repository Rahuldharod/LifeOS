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
| PB-017 | Settings button overlaps token-refresh message | Bug. Settings sits on top of the Google token-refresh message in the nav bar. Make it visible above the separating line. Settings is where the token problem is fixed, so it must stay reachable. | 3 | High | 1 | — | — |
| PB-022a | Google token failure is visible | Bug. When Google rejects the saved token (invalid_grant, seen on the Mac mini on 2026-09-28), the app showed “This calendar is clear” instead of the error. Now: typed GoogleAuthError; API returns 401 with a reconnect flag; connection status reports connected=false, reason “expired”; Calendar tab shows a Reconnect banner with the last successful sync time; the timeline shows the real error; identical failed Sync Runs are written at most once per hour. Built 2026-10-02, committed on branch feature/pb-017-019-020-022a (63aa703). Split from PB-022 with 022b and 022c. | 5 | High | 2 | — | — |
| PB-020 | No autosave until the user edits a note | Bug. Opening a calendar event creates and saves a note with a “Notes” header even with no changes. Save nothing until the user clicks into the notes section and changes something. Stops new empty files from being created. | 4 | High | 2 | — | — |
| PB-019 | Editor ribbon and styling correct on first open | Bug. Visual mode opens without the formatting ribbon until switching to Markdown and back. Ribbon button fonts differ between Visual and Markdown. Ribbon and editable notes section must work on first open, with one shared style. First-open symptom of PB-003. | 5 | High | 2 | — | — |
| PB-021 | Delete a note | Notes created by mistake or no longer needed can be deleted to reduce clutter and empty files. Follow the archive/tombstone rules (no silent hard delete) and confirm before deleting. Do after PB-020. Built 2026-10-02 on branch feature/pb-021-delete-note, not yet committed: Delete note button in Notes and the meeting workspace, with a confirm; sets `deleted_at` (tombstone), keeps the file, blocks later edits, and the event starts a fresh note if reopened. No in-app restore yet: remove the `deleted_at` line by hand. | 4 | High | 2 | — | — |
| PB-001 | Production application packaging | Running through the development server causes live reloads while code changes. Provide a stable production launcher that does not interrupt note-taking. | 5 | High | 3 | — | — |
| PB-004 | Duplicate meeting reconciliation | Detect and merge or archive duplicate canonical meetings and meeting notes created during retries or earlier development. Re-check with PB-022c. | 4 | High | 3 | — | — |

## Next

High-value capabilities to address after the current version is stable.

| ID | Improvement | User problem / desired outcome | Impact | Confidence | Effort | Owner | GitHub |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| PB-003 | Visual-editor quality pass | Ensure Markdown and Visual modes round-trip headings, emphasis, lists, task boxes, code, tables, links, images, and LifeOS links without formatting drift. Moved from Now on 2026-10-02: the daily-use symptom is covered by PB-019. | 5 | High | 3 | — | — |
| PB-018 | In-app feedback button | Feedback button beside Settings at the bottom of the nav bar. Single user, text only. Submitting appends a formatted row to the Inbox of this Product Backlog (Captured date, Idea with Bug/Feature label and next PB ID, Source/context with the current page). Supersedes the 2026-09-21 feedback idea. Needs a decision on writing into the code repo at runtime, see ADR 0001. | 3 | High | 2 | — | — |
| PB-023 | Group Latest notes by date | In Notes → Latest notes, group by date shown as “day month-in-words” with a divider between days. | 3 | High | 1 | — | — |
| PB-024 | Use more screen space | Content on all tabs fills the width and height of 13-inch Retina and 4K displays. Widen the Latest notes column so longer titles do not wrap. Build with PB-023, same column. | 3 | High | 2 | — | — |
| PB-022b | Persist synced events locally | The Calendar tab depends on a live Google call, so a token or network failure leaves the day blank. Store the last synced events per day (derived, rebuildable) and show them, marked as stale, when Google is unreachable. Split from PB-022. | 4 | Medium | 3 | — | — |
| PB-022c | Dedupe Sync Runs and recreate missing notes | After the Drive reload, check for duplicate Sync Run files and meetings whose note file went missing. Merge or archive duplicates and recreate missing notes idempotently, without silent deletes. Split from PB-022; overlaps PB-004. | 4 | Medium | 3 | — | — |
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

## Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-09-21 | Use this Markdown file for product intent and early-stage ideas; use GitHub Issues for implementation-ready work. | The product repository remains portable and human-readable, while GitHub provides workflow, ownership, discussion, and delivery traceability. |
| 2026-10-02 | Feedback is single-user and text-only, so the in-app button writes straight into this backlog's Inbox, not a separate feedback folder. | No new object type or schema needed; entries follow the backlog format. |
| 2026-10-02 | Triaged PB-017 to PB-024. Order in Now: PB-017, PB-022, PB-020, PB-019, PB-021, PB-001, PB-004. PB-003 moved to Next, PB-002 marked complete. | Fix what blocks daily use first; keep Now to seven items. |
| 2026-10-02 | Split PB-022 into 022a (Now), 022b and 022c (Next). | Diagnosis showed the root cause is an expired token shown as an empty day; fix visibility first, then resilience and cleanup. |
