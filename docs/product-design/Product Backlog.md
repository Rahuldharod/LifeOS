# LifeOS Product Backlog

Last reviewed: 2026-10-14

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

Items required to make the current version dependable for regular use. Reviewed 2026-10-14: the 2026-10-09 Now items (#100–#107) shipped; bugs first, then the top of Next.

| ID | Improvement | User problem / desired outcome | Impact | Confidence | Effort | Owner | GitHub |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| — | Visual editor keeps typing on a Note switch | Typing then opening another Note within the debounce (~0.2 s) loses the last keystrokes. Data loss. | 4 | High | 2 | agent | #192 |
| — | Inbox summary proposal editable | Accept summary is disabled and the proposed text cannot be edited; fix it or say why. Diagnose first. | 4 | Medium | 2 | agent | #195 |
| PB-032 | Dyslexia-friendly font and dark theme | Optional reading font and dark theme (PRD stories 88–91), moved from Phase A to Phase B (#90). Needs grilling and a ticket. | 3 | High | 2 | — | — |
| PB-018 | In-app feedback button | Feedback button beside Settings at the bottom of the nav bar. Single user, text only. Submitting appends a formatted row to the Inbox of this Product Backlog (Captured date, Idea with Bug/Feature label and next PB ID, Source/context with the current page). Supersedes the 2026-09-21 feedback idea. Opens as a popup with a Bug/Feature toggle. Needs grilling. Needs a decision on writing into the code repo at runtime, see ADR 0001. | 3 | High | 2 | — | — |
| PB-008 | Image management panel | Edit alternative text, inspect usage, replace images, and safely remove orphaned managed assets. Needs grilling. | 3 | High | 3 | — | — |

## Next

High-value capabilities to address after the current version is stable.

| ID | Improvement | User problem / desired outcome | Impact | Confidence | Effort | Owner | GitHub |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| PB-031 | Split Legacy shared Notes | One-time reviewed split of each Legacy shared Note (ADR 0019 format) into one Note per occurrence, backup first, originals kept until confirmed, so the Visual editor and the collapsible series view work on old data. Known case: the Weekly Prio note; [TBD] count any others. See *Analysis* below. | 3 | Medium | 3 | — | — |
| PB-009 | Complete Google Drive connection | Turn the stored Drive credentials into a working source/synchronization connector with clear scope and health reporting. | 4 | Medium | 4 | — | — |
| PB-033 | macOS launcher and start at login | Open LifeOS without the terminal and start it at login (PRD story 85, ADR 0006), moved from Phase A (#90). | 3 | Medium | 3 | — | — |

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
| 2026-10-03 | CI: bump `actions/checkout`, `actions/setup-node` and `pnpm/action-setup` to versions that target Node 24; GitHub is retiring Node 20 for actions. Warning only, CI still passes. | CI run 37099945764 annotation |
| 2026-10-03 | CI: on or after **19 Oct 2026**, check the first CI run on Ubuntu 26 (`ubuntu-latest` migrates that day); pin `ubuntu-24.04` if anything breaks. | CI run 37099945764 annotation |
| 2026-10-13 | Inbox: after the user decides on a recommendation (accept, edit, reject, snooze), move automatically to the next item so a batch is processed faster. Open: what happens at the last item (empty state), and a way to go back one step. | Rahul, Inbox speed |
| 2026-10-13 | Inbox: accepting a task proposal can also mark it closed. Implies a task life cycle with defined statuses (To do, In progress, Done, Abandoned). Needs a check of today's task statuses and of existing tasks, the transitions allowed (can Done reopen?), and how status shows in lists and filters (PB-005, PB-013). Today's statuses are Inbox, Next, Waiting, Done, Cancelled (`packages/domain`), so this is mostly a mapping and naming question. Decided 2026-10-13: show To do (stored as Next), add In progress, show Abandoned (stored as Cancelled). Open: whether to rename stored values (needs a migration of existing task files) or only relabel in the UI (recommended: relabel, add In progress). | Rahul, Inbox + Tasks |
| 2026-10-13 | Delete button beside the Save button on every object editor (notes, tasks, projects, clients, products, people). One consistent place, same look. | Rahul, UX consistency |
| 2026-10-13 | Cmd+Enter saves the object being edited, in every editor. Related to PB-014 (command palette and shortcuts); this one is a small standalone slice. | Rahul, keyboard flow |
| 2026-10-13 | App version in `X.X.X` format, bumped on every merge to main and shown in the UI. See *Analysis: app version* below. | Rahul, traceability |
| 2026-10-13 | Create a note without a meeting. Choose the project, client, product, people and other metadata at creation (PB-006's header pickers already exist after first edit). | Rahul, Notes tab |
| 2026-10-13 | `@` tagging in note and task editors. Typing `@` plus a character (for example `@P`) opens a list under the text, grouped by type across all objects, for example *Person:* Paul; *Product:* P.Promo, P.Picks. Up/Down arrows move through the options; Enter or Space picks one, puts the value in the text and sets that metadata on the object. The `@` text is not kept: once picked it disappears and only the metadata is set (decided 2026-10-13). | Rahul, capture speed |
| 2026-10-13 | Settings has no Area manager. `areaOptions` is a fixed list in code, so the user cannot add or edit area values. Add an Areas card beside the other reference-data cards. | Rahul, Settings |
| 2026-10-13 | Review the "Copy link" buttons: the URL now points to the object (PB-027), so they may be redundant. PB-029 shipped as #107 on 2026-10-09, so this is now a change to built behaviour. See *Analysis: copy link* below. | Rahul, UI clean-up |

### Analysis notes for the 2026-10-13 items

**App version.**
- Where: System page, a new "About LifeOS" card at the top showing `Version 0.4.2` and the build date. Also a small muted version in the nav-bar footer, next to Settings, so it is visible without opening a page.
- Source of truth: the `version` field in the root `package.json`, injected into the build.
- Bumping: a GitHub Action on merge to main raises the patch number (`X.X.Z`); the minor number is raised by hand for a notable feature. A bump commit by a bot avoids forgetting it.
- [TBD] Does the stable app (4310) show the version of its snapshot? It should, since `update-app` serves a snapshot.

**Recurring meeting notes.**
- What changed: ADR 0019 (one shared Note per series) caused the 2026-10-12 overwrite incident, so ADR 0021 replaced it with one Note per occurrence, shown as the last 4 occurrences, collapsed, newest first.
- Why you still see a single file: Notes created under ADR 0019 are stored as one Legacy shared Note. They open as one whole Note, and the Visual editor is disabled for them because the section anchors would be rewritten (the "Opened in Markdown" message). Preview works because it only reads.
- Pros of per-occurrence containers: one week's edit cannot damage another; each has its own save status and history; matches Calendar and enrichment, which are per occurrence.
- Cons: more files; the series view needs its own loading rules; old Notes need migrating.
- Alternative (now PB-031): a one-time, reviewed split of each Legacy shared Note into per-occurrence Notes (backup first, originals kept until confirmed), so the Visual editor and the collapsible view work on old data. Known so far: the Weekly Prio note; [TBD] check for others.

**Copy link.**
- Reasons to remove: the address bar already holds the object URL (PB-027), and the button adds clutter to every editor.
- Reasons to keep: (1) `lifeos://object/...` is the only form that works inside Markdown, so a link pasted into another note survives; (2) the browser URL depends on the device and port (dev 5174, stable 4310) and the link does not; (3) the title-plus-link format saves typing in notes and email.
- Recommendation: remove the button from the editor toolbar and keep the function as one item in a per-object "more" menu; or keep only the `lifeos://` copy. #107 is already built, so this needs its own ticket if pursued.

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
| PB-004 | Duplicate meetings: creation serialized per event, `pnpm reconcile-meetings` (dry run, `--apply` with backup); the empty Product Weekly copy and its note archived (absorbs PB-022c) | 2026-10-02 |
| PB-023 | Latest notes grouped by last-edited day ("Today", "Yesterday", "Thursday 1 October", year only if not this year); items show the time only; Deleted tab groups by deletion day | 2026-10-02 |
| PB-024 | Tabs fill the window; note text stops at ~90 characters per line; list, timeline and editor fill the height; Notes and Calendar side column grows with the screen (320–480px) and has a draggable divider remembered per device (double-click resets) | 2026-10-02 |
| PB-024b | Feedback fixes: Notes and Calendar fit the window with no page scroll; editor text left-aligned; Notes editor 70% wide by default (640px floor) with a bottom-right handle to resize freely (remembered per device, double-click resets); top margin trimmed and logo aligned with the page title | 2026-10-03 |
| PB-025 | Notes: Open/Deleted tabs, keyword search (every word, ignoring case and accents) and restore; restore refused when the meeting has a newer note | 2026-10-02 |
| PB-006 | Note header: click the title to rename; searchable dropdowns under it for project, client, product and (meeting notes) people. Each pick saves on its own, in Notes and in the Calendar editor. For a note not yet created, choices are held and applied right after the first edit creates it | 2026-10-03 |
| PB-007 | `lifeos://object/...` links open the object in the app: notes (including deleted) in Notes, meetings in Calendar on their day, tasks, projects, clients, products and people in their list with the card highlighted, review items in Inbox. One click opens it in every mode, including the editor's link bubble (which no longer opens a new tab); the open note is saved first; missing or unsupported targets explain why | 2026-10-03 |
| PB-003 | Visual-editor round-trip suite in CI; an "Unproven formatting" label names Markdown the editor would rewrite; images are never lost; LifeOS's Summary section round-trips (#89, #91, #96). Remaining rewrites are a PRD *Known gap* | 2026-10-04 |
| PB-022b | Calendar offline fallback: Today and the calendar view list meetings already stored in LifeOS under an Offline banner with Retry; never demo meetings (#88, #94). Built from stored meetings, not a separate cache | 2026-10-04 |
| PB-011 | History panel on every object with "Restore this version"; restore keeps sensitivity and review state and is refused if the object changed since the panel opened (#85, #92) | 2026-10-04 |
| PB-027 | Every tab and open item has its own URL; Back/Forward, reload and bookmarks work (#100) | 2026-10-09 |
| PB-010 | Searchable relationship pickers on the Tasks, Projects, Clients, Products and People forms (#101) | 2026-10-09 |
| PB-028 | One editor layout everywhere (#102) | 2026-10-09 |
| PB-030 | Delete a note permanently from the Deleted tab (#103) | 2026-10-09 |
| PB-005 | Filter the notes list by type, date, project, client, product and person (#105) | 2026-10-09 |
| PB-026 | Breadcrumbs (#106) | 2026-10-09 |
| PB-029 | Copy a LifeOS link to any object (#107) | 2026-10-09 |

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
| 2026-10-02 | Archive means `archived_at` in place, not a move to `data/archive/` (ADR 0006). | Moving files would bypass ObjectStore hash checks, and the scan reads every folder, so a moved duplicate would still be flagged. |
| 2026-10-04 | PB-007: one click on a LifeOS link opens the object in every mode, including the Visual editor. | Tried plain-click-edits / Cmd+click-opens first; it was not discoverable. LifeOS links are for navigation and their wording is rarely edited (arrow keys or Markdown mode still work). |
| 2026-10-04 | Phase A closes on the core. Launcher and start at login, dyslexia-friendly font, dark theme, Playwright tests and the 10,000-object fixture move to Phase B (#90); each needs its own ticket. PB-003, PB-022b and PB-011 are complete. | Decided by Rahul so Phase A can close on the core (#90). |
| 2026-10-04 | Phase A build decisions and known gaps are recorded in the PRD (*Decisions made during the build*, *Known gaps*) and Solution Design v0.7 (13.10, 13.11), not duplicated here. | One place per decision; the backlog keeps intent and priority only. |
| 2026-10-09 | Phase A closed (#99 merged, #21 closed). Grilled the backlog: PB-027, PB-010, PB-005, PB-028, PB-030, PB-026 and PB-029 ticketed under Phase B (#90) as #100–#107; Rahul's manual steps in #104. PB-018 stays in Next. | PB-027 unblocks breadcrumbs and copy link; the I=4/E=2 items reuse PB-006's picker. Decisions are recorded in each issue. |
| 2026-10-02 | PB-023/024: group by last-edited date (matches the sort); the divider width is a per-device browser preference (ADR 0005); the stable app now serves a snapshot of the build. | Headers must follow the list order; 13-inch and 4K screens need different widths; a plain `pnpm build` was silently changing the running app. |
| 2026-10-14 | Backlog cleanup: #100–#107 moved to Completed. Now: #192, #195, PB-032 (new), PB-018, PB-008. Next: PB-031, PB-009, PB-033 (new). PB-032 and PB-033 come from the Phase B list in #90. The copy-link note is updated because #107 has shipped. | Bugs that lose data or block review come first; the three feature items go through grill-with-docs before they are ticketed. |
