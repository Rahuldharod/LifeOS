# Spec: LifeOS Phase A — agent-first work daily driver (PRD v1.0)

> **Status:** ready-for-agent · **Date:** 3 October 2026 · **Baseline:** Solution Design v0.5 + GitHub `main` @ `e981138` · **Source:** grilling session of 3 October 2026 (Q1–Q41, C1–C5)
>
> This spec supersedes the following charting decisions on map #1: direct agent writes (now Inbox Drafts + Adoption), the in-app Claude API provider (now deferred; agents do the AI work), and the `actions.md` import (fresh start for work; personal rows stay Phase B). Vocabulary follows `CONTEXT.md`; new terms are defined in *Further Notes → Glossary additions*.

## Problem Statement

I run my work life across meeting notes, calendar invites, Meet transcripts, Gong recordings, emailed summaries, a Markdown action list and my own memory. I forget commitments, I lose track of what others owe me, and I start most days without a clear view of what matters most.

LifeOS already stores my meetings, notes and tasks safely, and opening a Google Calendar event gives me a meeting note. But the system stops there:

- The "AI" that turns my notes into tasks, decisions and open points is a fake that returns three fixed items.
- Transcripts, recordings and Gong calls arrive hours after a meeting, and nothing collects them or checks them for things my notes missed.
- I can't capture anything when I'm away from my Mac, and I can't ask "what do I owe Joel?" from my phone.
- Agents like Steve can't safely write into the vault: bad files vanish silently, duplicate IDs are not blocked, and nothing tells the agent it failed.
- Decisions and open points can only be created by accepting a review, and can never be edited, superseded or closed.
- The Today page doesn't tell me *why* something matters today, and nothing reminds me when the app is closed.
- People from calendar invites are not linked or named consistently, and I can't tell colleagues from external contacts at a glance.

## Solution

LifeOS becomes my single source of truth for work commitments. The app stays the human interface and the validator; **Claude (with my existing connectors and subscription) becomes the AI layer**, working through skills against the same Drive-synced Markdown vault.

- **Agents never write authoritative objects.** They drop simple **Inbox Drafts** (plain front matter, references *by name*) into an `_inbox/` folder. LifeOS **adopts** each draft: it assigns the ID, resolves names to IDs, validates, files it, and routes it — my own dictated words become objects directly; anything an agent extracted becomes a Review Item.
- **After meetings**, one button ("Enrich last 48h") writes a **Work Order**. I tell Claude "run LifeOS enrichment"; it fetches Meet transcripts and recordings, Gong transcripts and emailed summaries, then writes back links and proposals — flagging anything my notes missed — with evidence.
- **Every morning**, a scheduled Claude routine writes a **Daily Focus** brief (what I owe, Top 3 with why-today, waiting/decisions, meeting prep, day shape) and sends me a 5-line Slack DM. The Today page shows the brief with **live** status overlaid, so finished items drop away during the day.
- **From my phone**, I chat with Claude: it reads a small **Agent Index** that LifeOS keeps up to date, and writes drafts or **Patch Drafts** ("mark that done", "move it to Friday") that LifeOS applies, audits and lets me undo.
- **Decisions and Open Points** get a minimal workspace with their full lifecycle.
- **People** are matched by email, named consistently, and external people are marked "- ext" in red.
- **Safety first:** the file-edit gaps found in research #3 are fixed before agents are pointed at the vault; backups run automatically with a weekly off-Drive copy.

**Success (two gates):**
1. **Core-loop quality gate:** 10 real meetings through the loop within 2 weeks; ≥70% of proposals accepted with no or light edits; ≤2 minutes from starting review to done per meeting; 0 commitments persisted without review; Today opened on ≥8 of 10 workdays.
2. **Phase A exit gate (from #8):** 4 consecutive weeks where every new work action is captured in LifeOS and Steve's morning brief reads from LifeOS. Then Phase B (personal areas) opens.

## User Stories

### Capture and agent writes

1. As Rahul, I want to dictate a task to Claude on my Android phone, so that I capture commitments the moment they happen, away from my Mac.
2. As Rahul, I want a task I dictated to become a real Inbox task without a review step, so that my own words are never second-guessed.
3. As Rahul, I want anything an agent *extracted* (not dictated by me) to arrive as a Review Item, so that AI never invents commitments on my behalf.
4. As Rahul, I want every object to show its origin (dictated, agent-extracted, calendar, imported, app), so that I can always tell where something came from.
5. As an Agent, I want to reference projects, clients, products and people by name in a draft, so that I don't need to know internal IDs.
6. As an Agent, I want a single short draft format, so that I can't easily produce a file that breaks the app.
7. As an Agent, I want to invent my own draft key, so that re-sending the same draft after a network retry never creates a duplicate.
8. As Rahul, I want drafts with ambiguous names ("Joel" when there are two Joels) to come to my review queue, so that wrong links are never guessed silently.
9. As Rahul, I want drafts that fail validation to be kept, shown with the exact file and reason, and never deleted, so that I don't lose a capture.
10. As an Agent, I want a result file next to my draft after adoption (adopted object ID or error), so that I can confirm what happened.
11. As Rahul, I want drafts to be adopted automatically when the app starts and whenever a new draft lands, so that I don't have to remember to import.
12. As Rahul, I want an "Adopt now" control and a count of "drafts awaiting adoption", so that I can see and clear the backlog on demand.
13. As Rahul, I want a draft that is still being written (partial file) to be skipped until it is complete, so that half-files never become objects.
14. As Rahul, I want the Quick Capture box to keep creating an Inbox task directly, so that typing in the app stays instant.
15. As Rahul, I want to save an idea or a web link from chat as a Knowledge Note or Source, so that knowledge capture works from my phone too.
16. As Rahul, I want agent outputs to follow the language of the source (French meeting → French task), so that items read naturally.

### Patch drafts (changing existing objects from chat)

17. As Rahul, I want to say "mark the sizing deck task done" in Claude chat and have it applied, so that small updates don't need the app.
18. As Rahul, I want low-risk changes I dictate (status, due date, priority, appended note) to apply automatically, so that chatting stays useful.
19. As Rahul, I want meaning-changing edits (owner change, closing an open point, superseding or rewording a decision) to become Review Items even when I dictate them, so that big changes get a second look.
20. As Rahul, I want every applied patch to be audited with before/after values and undoable in one click, so that a misheard instruction is cheap to fix.
21. As Rahul, I want a patch whose target changed after I dictated it to come to review instead of overwriting, so that newer edits are never lost.
22. As an Agent, I want to target an object by ID (preferred) or by an exact title, so that patches land on the right object.

### Agent Index (reading from chat and routines)

23. As Rahul, I want to ask Claude chat "what do I owe Joel?" and get a correct answer from my vault, so that I can check commitments from anywhere.
24. As an Agent, I want a small set of up-to-date summary files (open tasks, waiting on, open points, recent decisions, projects, people, recent and upcoming meetings) with IDs and paths, so that I don't have to scan hundreds of files.
25. As an Agent, I want the index to say when it was generated, so that I can warn Rahul when it may be stale.
26. As an Agent, I want pending drafts in `_inbox/` to be readable and clearly labelled "pending adoption", so that recent captures aren't invisible.
27. As Rahul, I want restricted objects to be excluded from the Agent Index (count only), so that sensitive material is not handed to agents by default.

### Post-meeting enrichment

28. As Rahul, I want an "Enrich last 48h" button, so that I can collect transcripts, recordings and Gong material when they've had time to appear.
29. As Rahul, I want the button to produce a Work Order listing each ended meeting, its calendar event ID, attendees, note and what material is still missing, so that Claude knows exactly what to fetch.
30. As Rahul, I want to start enrichment with one sentence to Claude ("run LifeOS enrichment"), so that I don't spend API credits or write prompts.
31. As an Agent, I want the enrichment skill to tell me how to find Meet transcripts and recordings (from the calendar event and Drive), Gong transcripts (Gong connector) and Gong email summaries (Gmail), so that I fetch from the right places.
32. As Rahul, I want each meeting to show its enrichment state (not requested, requested, enriched, partial, gave up), so that I know what's still coming.
33. As Rahul, I want transcript, recording, Gong and document links stored as Sources linked to the meeting, so that my own notes are never rewritten.
34. As Rahul, I want the AI summary proposed as a Review Item and, once accepted, shown on the meeting page separately from my notes, so that my notes stay mine.
35. As Rahul, I want proposals that don't appear in my notes flagged "Not in your notes", so that I see what I missed.
36. As Rahul, I want each proposal to carry evidence (source and locator such as transcript timestamp or document section), so that I can verify it in seconds.
37. As Rahul, I want proposed tasks and decisions to inherit the meeting's project, client, product and people, so that I don't reclassify them.
38. As Rahul, I want enrichment to work for meetings where I took no notes, so that transcript-only meetings still produce outputs.
39. As Rahul, I want re-running enrichment on the same meeting to never duplicate sources or proposals, so that retries are safe.
40. As Rahul, I want a meeting with no material after 48 hours to be markable "gave up", so that it stops appearing in work orders.
41. As Rahul, I want work orders older than 7 days that were never processed to be flagged stale, so that forgotten runs surface.

### Review

42. As Rahul, I want to accept, edit or reject each proposal quickly, so that review stays under 2 minutes per meeting.
43. As Rahul, I want to edit all proposed fields (title, owner, due, priority, context links) before accepting, so that I fix proposals instead of rejecting them.
44. As Rahul, I want new review types for updates, link resolution, person merges and meeting summaries, so that every agent change goes through the same queue.

### Today and the Daily Focus brief

45. As Rahul, I want a morning brief generated before I start work, so that I begin with a clear view without opening anything.
46. As Rahul, I want the brief to lead with what I owe (due, overdue, yesterday's meeting actions), so that I stop forgetting commitments.
47. As Rahul, I want a Top 3 (max, configurable) with a "why today" and an if-then slot (when/where/how long), so that my priorities are clear and actionable.
48. As Rahul, I want aged waiting-on items and pending decisions in one short list, so that I know what to chase.
49. As Rahul, I want prep for my next key meetings (max 3) with context and "your ask", so that I walk in prepared.
50. As Rahul, I want the day shape (meeting hours, free hours) as information only, so that the Top 3 is sized to reality without nagging me about meetings I can't control.
51. As Rahul, I want 1–3 "consider deferring" task suggestions with a reason when my must-dos exceed my free time, so that I practise saying no — never applied automatically, never about meetings.
52. As Rahul, I want the brief to fit one screen (about 250–300 words), so that it's scannable with dyslexia.
53. As Rahul, I want the Today page to show the brief with live status overlaid (done items struck through, past meetings marked), so that it stays useful all day.
54. As Rahul, I want "Generated at HH:MM" and a Refresh action that asks Claude to re-plan, so that I know when the brief is stale and can update it.
55. As Rahul, I want to pin, replace or dismiss Top 3 items, and have my choices respected, so that the plan stays mine.
56. As Rahul, I want the deterministic Top 3 rule (priority, then due date) when no brief exists, so that Today always works.
57. As Rahul, I want the live panels (overdue, due today, waiting, next meetings, review count, drafts awaiting adoption, open points for today's meetings) computed fresh, so that they never go stale.
58. As Rahul, I want a 5-line Slack DM each workday (Top 3, I-owe count with overdue, day shape, link to the brief), so that I'm reminded even when the app is closed.
59. As Rahul, I want the Slack DM to be read-only, so that there is no second write path to break.
60. As Rahul, I want my inbox triage (email, Slack, Jira) to stay in Steve's separate brief, so that LifeOS shows commitments, not noise.

### Decisions and Open Points

61. As Rahul, I want a Decisions list filterable by project, client, product, status and date, so that I can find what was decided without rereading notes.
62. As Rahul, I want to create and edit decisions by hand, so that decisions made outside meetings are recorded.
63. As Rahul, I want to supersede a decision with a new one, keeping the link between them, so that history stays traceable.
64. As Rahul, I want an Open Points list with the same filters, so that unresolved questions are visible.
65. As Rahul, I want to resolve an open point with a summary or by linking or creating a decision, and to close one that no longer matters, so that open points have a real lifecycle.
66. As Rahul, I want decisions and open points to keep appearing in project, client, product and person roll-ups, so that context pages stay complete.

### People

67. As Rahul, I want meeting attendees matched to People by email, so that meetings, tasks and history connect automatically.
68. As Rahul, I want unknown attendees created as People with first and last name derived from their email (calendar display name wins when present), so that I don't type names.
69. As Rahul, I want names like `jean-pierre.dupont@` to become "Jean-Pierre Dupont", and addresses without a dot to fall back to the calendar display name, so that names are correct.
70. As Rahul, I want badges and pickers to show first names, and full names when two people share a first name, so that labels are short but unambiguous.
71. As Rahul, I want people outside `eagleeye.com` and `untienots.com` marked external and shown as "Name - ext" in red, so that I can see at a glance who's outside the company.
72. As Rahul, I want automatically created people flagged "unreviewed" with merge suggestions for likely duplicates, so that my people list stays clean without auto-merging.
73. As Rahul, I want all my own addresses (work and personal) to resolve to my single self person, so that My Tasks and ownership work everywhere.

### Safety, sensitivity and data integrity

74. As Rahul, I want to mark any object `restricted`, so that it's excluded from the Agent Index, the brief, Slack and work orders.
75. As Rahul, I want an invalid or broken file to appear in System Health with its file path and reason, so that I can fix it.
76. As Rahul, I want writes blocked on objects involved in a duplicate-ID conflict until I resolve it, so that the wrong copy is never edited.
77. As Rahul, I want saves to compare the revision as well as the content hash, so that the conflict rule matches the design.
78. As Rahul, I want external changes (Obsidian, Drive, agents) recorded in the audit trail and the prior version kept, so that I can see and undo what changed outside the app.
79. As Rahul, I want Area validated against the agreed vocabulary (legacy values warned, not rejected), so that a future work/personal split stays possible.
80. As Rahul, I want subjects normalised at adoption ("retail-media" matches "Retail Media"), so that topics don't fragment.

### Backups, runtime and resilience

81. As Rahul, I want backups to run automatically at app start, at app stop and daily while running, so that I never rely on remembering.
82. As Rahul, I want a weekly backup copy in a local folder outside Google Drive (4 generations), so that a Drive or employer-account problem can't take both data and backups.
83. As Rahul, I want a visible warning when a backup fails, so that silent failure is impossible.
84. As Rahul, I want a documented exit plan for taking my vault with me, so that leaving Eagle Eye never costs me my system.
85. As Rahul, I want to start LifeOS by double-clicking an app and have it start at login, so that I never use the terminal.
86. As Rahul, I want the calendar to show the last synced events (marked stale) when Google is unreachable, so that my day never goes blank.
87. As Rahul, I want the visual editor to save Markdown without changing it (headings, lists, task lists, tables, code, links, inline HTML, images), so that I can trust visual mode.

### Accessibility and interface

88. As Rahul, I want a readable font (optional dyslexia-friendly font), short lines, generous spacing and bold anchors, so that the app is easy for me to scan.
89. As Rahul, I want no meaning carried by colour alone, full keyboard use, and light and dark themes, so that the interface works in any condition.
90. As Rahul, I want summary panels to show at most 5–7 rows before "show more", so that I'm never faced with a wall of items.
91. As Rahul, I want a calm, neutral design that isn't the company brand, so that a personal system doesn't feel like a work tool.

### Steve and the skills pack

92. As Steve, I want my morning brief to read from LifeOS (Agent Index and Daily Focus), so that work commitments have one source.
93. As Steve, I want to capture new work actions as LifeOS drafts instead of writing to `actions.md`, so that the old tracker stops growing.
94. As Rahul, I want the skills (Object Contract, capture, enrichment, daily focus, ask) versioned with the code and installable in Claude desktop and the Claude app, so that phone, desktop and routines all follow the same rules.
95. As Rahul, I want the examples in each skill to be tested against the real adoption code, so that skill text and app never drift apart.

## Implementation Decisions

### Architecture

- **Agent-first AI.** The `AiProvider` port is kept; the deterministic mock remains for tests. No in-app LLM provider is built in Phase A. All AI work (enrichment, extraction, briefs, chat answers) is done by Claude through skills, using the user's subscription and connectors. The in-app provider (#5) is deferred; the cost research (#2) remains the reference when it returns.
- **Single writer for authoritative objects.** Only the application writes object files. Agents write only into `_inbox/` (drafts, patches, requests) and read `_agent/` (derived index). This also makes the device lease (U6) irrelevant for agents and removes the partial-object scan risk (U8) for objects.
- **Phase A scope only.** Personal migration, recurring tasks, Belongings and personal calendars remain Phase B, blocked by the Phase A exit gate.
- **New ADRs to record:** Inbox Drafts and Adoption (agents never write objects); agent-first AI with the in-app provider deferred; the derived Agent Index; the `sensitivity` field; Daily Focus ownership split (agent-owned brief, app-owned override).

### Prerequisites from research #3 (must land before any agent is pointed at the vault)

- **Path-aware diagnostics (U2):** every validation, YAML and graph diagnostic carries the relative file path, the object ID if readable, and a human-readable reason.
- **Duplicate-ID blocking (U3):** when two files share an ID, both are reported with paths, the winner is deterministic (oldest `created_at`, then path order), and writes to that ID are refused until resolved.
- **Revision comparison:** a guarded save fails as a conflict if either the content hash or the `revision` differs from the opened version.
- **External-change history (U4, U5):** when the watcher detects a changed object whose hash differs from the last-known version, the last-known copy is kept in the versions store and an `audit-event` with `actor_type: external` is written.
- **Review Item operation IDs (U7):** generated only by the application at adoption; agent drafts never carry them.
- **UUIDv7 enforcement:** IDs must be version 7.

### Object Contract, Inbox Drafts and Adoption

- **Data-root folders (new):** `_inbox/drafts/`, `_inbox/patches/`, `_inbox/requests/` (work orders), `_inbox/processed/`, `_inbox/failed/`; and `_agent/` for the derived index. The object scan ignores `_inbox/` and `_agent/`; the watcher observes `_inbox/` for adoption and ignores `_agent/`. Backups include `_inbox/` and exclude `_agent/`.
- **Draft format (contract v1):** a Markdown file with minimal front matter:
  - `lifeos_draft: 1` (contract version)
  - `kind`: `task | decision | open-point | knowledge-note | source | person | meeting-material | daily-focus`
  - `draft_key`: any agent-chosen unique string (idempotency key)
  - `origin`: `user-dictated | agent-extracted`
  - `title`, optional `area`, `subjects`, `tags`, `sensitivity`
  - references by name or ID: `project`, `client`, `product`, `people`, `owner`, `waiting_for`, `meeting` (calendar event ID or meeting ID)
  - kind-specific fields (for example `due_on`/`due_at`, `priority`, `status`, `expected_output` for tasks; `url` and `occurred_at` for sources; `evidence` entries with source reference and locator)
  - `captured_at` in any ISO 8601 form (the adopter normalises it to UTC `Z`)
  - Body is the narrative.
- **Adoption use case:**
  - **Triggers:** app startup, a watcher event in `_inbox/`, and the manual "Adopt now" action.
  - **Partial files:** skipped if modified less than 2 seconds ago or if unparsable on first sight; retried on the next trigger.
  - **Idempotency:** keyed by `draft_key` plus the content hash. A re-sent identical draft is a no-op that points to the original result.
  - **Name resolution:** case- and accent-insensitive exact match on title, then on recorded aliases; people by email first. Unresolved or ambiguous references create a `link-resolution` Review Item, never a guess. Unresolved references never block creation of a dictated task: it is created with the resolved links only, plus the review item.
  - **Envelope:** assigns the UUIDv7 and full envelope; filename per ADR 0002; adds `origin`, `source_ids`, and inherited context from any referenced meeting.
  - **Routing:**
    - `origin: user-dictated` → the object is created directly. Dictated tasks get status Inbox and owner = self unless named.
    - `origin: agent-extracted` → a create-type Review Item with `proposed_fields`, `field_evidence` and a confidence label.
    - `person` drafts → a Person created as `unreviewed`, plus `person-merge` review items for likely duplicates.
  - **Records:** writes one `agent-run` record per adoption batch and one `audit-event` per object or review item created.
  - **Outcome:** the draft moves to `_inbox/processed/` or `_inbox/failed/`. A sidecar `.result.md` holds the adopted object IDs or the errors (path-aware). Failed drafts are listed in Inbox and System Health and are never deleted automatically.
  - **Subjects:** normalised to an existing subject when equal after case/accent/separator normalisation.
- **Patch drafts:** front matter has `lifeos_patch: 1`, `draft_key`, `origin`, target (`id` preferred, or exact `title` plus `type`), `captured_at`, and `set` (field → value) and/or `append_note`.
  - **Auto-applied fields** for `origin: user-dictated`: task `status`, `due_on`/`due_at`/`due_timezone`, `priority`, `waiting_for` (only together with Waiting status), and appended body notes for any object.
  - **Always a Review Item** (`update` type), even when dictated: changes to owner, decision text, superseding, open-point closing or resolving, title, and any field on decisions.
  - **Agent-extracted patches** always become Review Items.
  - **Conflict rule:** if the target's `updated_at` is later than `captured_at` and one of the patched fields changed since, the patch becomes an `update` Review Item.
  - **Undo:** each applied patch records before/after in its audit event. Undo restores the before values through a guarded write.
- **Review Item types (new):** `update` (field changes on an existing object), `link-resolution`, `person-merge`, and `summary` (meeting summary). Accepting an `update` applies the fields with revision checks. Accepting a `summary` writes the Summary section of the **meeting** object body. The meeting-note body stays the user's own text.
- **Object Contract document** lives in the code repository with the skills. It defines the draft and patch formats, the kinds, the routing rules, the language rule (outputs follow the source language), the restricted rule, and the self-check (read the `.result.md`).

### Origin and sensitivity

- **Envelope additions:**
  - `origin`: `app | user-dictated | agent-extracted | calendar | imported | external`. It is set at creation and never changed. Existing objects without it are read as `app`.
  - `sensitivity`: `normal` (default) or `restricted`. Restricted objects are excluded from the Agent Index (counted only), from Daily Focus inputs, from work orders and from Slack, and show a lock badge. The skills state that restricted files must not be read. This is an instruction, not a technical lock, and the PRD says so. Out-of-scope categories (finance, health) are linked out, not run in LifeOS.
- **Area validation:** values must be one of `work`, `maintenance`, `household`, `learning`, `personal-projects` or `personal-growth`. New writes with other values are rejected. Existing files with other values produce a System Health warning, not a rejection.

### Agent Index

- **Derived files** are regenerated (debounced) after each index rebuild, from the in-memory index:
  - an overview: data-root map, counts per type, generated time, pending-draft count, folder per type
  - open tasks: mine, grouped overdue / today / upcoming / no date
  - waiting on, by person, with age
  - open points
  - decisions from the last 30 days
  - active projects, clients and products
  - people, with display labels, emails and an external flag
  - meetings from the last 14 days and the next 7, with enrichment state
- **Each entry** carries ID, title, relative path and key fields.
- **The index is disposable:** never read back by the app and never authoritative.
- **Freshness:** every file states its generation time. The skills must report it to the user when it's older than 24 hours.

### Enrichment Work Orders

- **"Enrich last 48h"** selects ended, non-all-day, non-declined events from the selected calendars that started in the last 48 hours. It includes events without a meeting object yet, and excludes meetings already `enriched` or `gave_up`. It writes one Work Order file to `_inbox/requests/` containing each meeting's IDs, calendar event ID, title, times, timezone, attendee emails, the note's relative path if any, existing sources, and material still missing. Each meeting is set to `requested`.
- **Meeting enrichment state** (a new meeting field): `none → requested → enriched | partial | gave_up`. `partial` means some expected material was missing and the meeting is retriable. `gave_up` is set by the user, or proposed after 48 hours with no material. Work Orders not processed within 7 days are flagged stale on Today and in System.
- **Agent output** is a `meeting-material` draft per meeting. It contains Source entries (`meet-transcript`, `meet-recording`, `gong-call`, `gong-summary-email`, `drive-doc`, each with URL, external ID and occurred time), an optional summary, and extracted proposals. Each proposal has evidence locators and a `missed_in_notes` flag.
- **Adoption of meeting material:**
  - Creates the meeting from the calendar event if missing, reusing the existing idempotent creation keyed by calendar event ID. The canonical note is still created only when the user first edits it.
  - Upserts Sources by provider and external ID.
  - Creates `summary` and create-type Review Items, inheriting the meeting's project, client, product and people.
  - Sets the state to `enriched` or `partial`.
- **The enrichment skill** names the sources:
  - Meet transcripts and recordings come from the calendar event attachments and Drive.
  - Gong comes from the Gong connector (transcript, brief).
  - Gong email summaries come from Gmail.
  - It compares the material with the user's note to set `missed_in_notes`.

### Daily Focus and Today

- **The `daily-focus` object** (an existing type) is written via a `daily-focus` draft by the morning routine. Its fields:
  - `focus_on` (date)
  - `generated_at`
  - `i_owe`: task IDs, with an overdue flag
  - `top3`: task ID, why_today, if_then
  - `waiting_and_decisions`: object ID, age in days
  - `meeting_prep`: meeting ID, context, ask (max 3)
  - `day_shape`: meeting hours, free hours (information only)
  - `defer_candidates`: task ID, reason (1–3, tasks only)

  The body is the brief narrative, at most about 300 words. A newer brief for the same date supersedes the older one (the older one is archived in place).
- **`focus-override`** (a new app-owned type): one per date, holding pinned, replaced (old → new) and dismissed task IDs. The effective Top 3 is the brief's `top3` with overrides applied. With no brief, the existing deterministic rule (priority, then due date) applies, with its visible reason.
- **Live overlay:** Today renders the brief using live index state. Completed or cancelled tasks are struck through and sink. Past meetings are marked. "Generated at HH:MM" is shown. Refresh writes a `replan` Work Order to `_inbox/requests/`.
- **Live panels** stay computed by the app: overdue, due today, upcoming high priority, waiting by person, next meetings, open points linked to today's meetings, review count, drafts awaiting adoption, failed drafts, stale work orders.
- **Settings** (synced app-setting): max must-dos (default 3), meeting-hours information threshold (default 5), brief time (default 06:00 Europe/Paris on workdays, confirmed by Rahul 2026-10-03), internal domains (default `eagleeye.com`, `untienots.com`), weekly off-Drive backup folder.
- **The morning routine** (a cloud routine; a desktop scheduled task is the fallback) reads the Agent Index, calendar and pending drafts, writes the `daily-focus` draft, and sends a read-only Slack DM to self. The DM has 5 lines: Top 3, the I-owe count with the overdue count, day shape, and a path or link to the brief. The order is I owe → Top 3 → waiting/decisions → meeting prep → day shape. Restricted objects are never included. Inbox triage stays in Steve's separate brief.

### Decisions and Open Points workspace

- Each type gets a list view with filters (project, client, product, person, status, date range) and a detail view with source, meeting and evidence links. Manual create and edit set `origin: app`.
- **Decision lifecycle:** `active` → `superseded`, via "Supersede", which creates the new decision with `supersedes_decision_id` and sets the old one superseded.
- **Open-point lifecycle:** `open` → `resolved` (requires `resolution_summary` or `resolution_decision_id`; "Resolve with decision" creates and links a decision) or `closed` (no longer relevant; reason optional). `resolved_at` and `closed_at` agree with status. These rules are enforced in the domain schema.

### People

- **Attendee matching:** case-insensitive email match against each person's `identifiers` emails. An unmatched attendee creates a Person with `origin: calendar`, `review_state: unreviewed`, given and family name, an email identifier, and an organization derived from the domain.
- **Name derivation:**
  - The calendar display name wins when present.
  - Otherwise `first.last@` and `first_last@` become First Last, with title-case per part. Hyphens and accents are preserved.
  - A local part with no separator falls back to the display name, or else to the local part as the given name.
- **External flag:** `is_external` is derived from the email domain against the internal-domain setting, with a manual override. External people get minimal handling in Phase A: they are created, matched and badged. Organization and client linking is deferred.
- **Display label** (application read model, used by badges, pickers and the Agent Index):
  - first name by default
  - first and last name when another active person shares the first name, recomputed live
  - external people get the suffix " - ext", styled red, with the text always present
- **Self person:** carries all of the user's addresses (`rahul.dharod@eagleeye.com`, `rahul.dharod@untienots.com`, `baloo.rahul@gmail.com`), so it is never duplicated.
- **Merge:** `person-merge` Review Items are suggested when names match, or when the email local part matches across internal domains. Accepting re-points references through a recoverable multi-file operation and tombstones the merged person. Merges never happen automatically.

### Knowledge (Phase A level)

- Sources: pasted text and web links only. Claude fetches link text in the skill.
  - A `source` draft creates a Source.
  - An agent-extracted knowledge note becomes a Review Item.
  - A user-dictated knowledge note is created directly.
- PDFs and richer media come after Phase A.

### Backups, runtime and resilience

- **Backup schedule:** automatic backups at stable-app start, at stop, and every 24 hours while running, on top of manual backups. A failure shows a persistent banner and is recorded in System.
- **Off-Drive copy:** a weekly copy of the latest verified snapshot goes to a local folder outside Google Drive (a setting), keeping 4 generations. If the copy fails, it raises the same banner.
- **Exit plan:** the Further Notes describe how to take the vault: data folder and backups copied to a personal location, and secrets re-entered.
- **macOS launcher:** a double-clickable launcher for the stable app, plus an optional start-at-login item. Stopping the app releases the lease.
- **Calendar offline fallback (PB-022b):** the last synced events per day are kept as a disposable cache, shown marked stale with their sync time when Google is unreachable.
- **Editor round-trip (PB-003):** a lossless suite for headings, lists, task lists, tables, code blocks, links, LifeOS links, inline HTML (underline) and images. Visual mode is labelled unproven until it passes.

### Links

- **Body links:** links between objects in bodies use the `lifeos://object/<id>` form (PB-007). The in-app click opens the object. Obsidian shows plain text, which is accepted, because Obsidian is a portability guarantee, not a daily interface.

### Steve and the skills pack

- **The skills pack** is versioned with the code: Object Contract, capture, enrichment, daily focus and ask (read via the Agent Index). It's installable in Claude desktop and the Claude app (Android, Drive connector).
- **The Steve skill changes:**
  - Its morning brief reads the Agent Index and the Daily Focus.
  - New work actions are written as drafts, not to `actions.md`.
  - Steve is pointed at the data root only after the prerequisites above have landed.

### Non-functional requirements

- **Scale:** 10,000 objects (about 2–3 years).
  - Index ready in under 3 s at startup.
  - Save in under 300 ms.
  - Search in under 500 ms.
  - Adoption of a 20-draft batch in under 5 s.
  - When a full index rebuild exceeds 1 s on real data, incremental indexing becomes required work.
- **Durability:** no data loss on crash, sleep or power loss. Startup recovery completes interrupted journals and adoption batches.
- **Privacy:**
  - Secrets stay in the macOS Keychain.
  - No secrets in drafts, the index, work orders, logs or Slack.
  - Restricted objects are excluded as specified.
  - External LLM use is limited to the user's Claude connectors.
- **Accessibility:**
  - readable sans-serif with an optional dyslexia-friendly font
  - line length of about 70 characters or less
  - generous spacing
  - no meaning carried by colour alone
  - full keyboard operation
  - light and dark themes
  - summary panels of 5–7 rows before "show more"
  - neutral, non-brand visual design

## Testing Decisions

- **What makes a good test:** it exercises behaviour through the public application layer and asserts on observable results: files on disk (front matter and body), computed read models, and returned errors. It never asserts on internal functions, private helpers or rendering details. Tests use temporary data roots and synthetic records only, never the real data root.
- **Seam S1, primary (existing):** the application facade, constructed with the Markdown object store over a temp root, the in-memory index and the mock calendar and AI. Covered there:
  - draft adoption: routing by origin, name resolution, ambiguity, failures, idempotency, partial files
  - patch drafts: auto-apply, review routing, conflict, undo
  - new Review Item types
  - work-order generation and the enrichment state machine
  - meeting-material adoption
  - Daily Focus with overrides and the effective Top 3
  - the decision and open-point lifecycles
  - attendee matching, name derivation and display labels
  - sensitivity exclusion
  - Area validation
  - Agent Index contents
  - the prerequisite fixes (path diagnostics, duplicate blocking, revision check, external-change audit)
  - backup schedule triggers
  - the calendar stale cache
  - Prior art: the vertical-slice, capture-knowledge, entity-crud, note-draft-conflict, duplicate-meetings, system-health and backup integration tests.
- **Skill examples as fixtures:** every example draft and patch in the skills pack is a CI fixture fed through S1 adoption. CI fails if any example stops adopting as documented, so the skill text and the code can't drift.
- **Seam S2, minimal (new):** browser tests (Playwright) for three flows only: the Today brief overlay with live status, accepting a Review Item, and adopting a draft from the Inbox view. Display rules are covered at S1, so S2 stays thin.
- **Not code-testable:** the Claude routines and skills (prompts). Each ships with a written dry-run checklist executed against a synthetic data root before first real use.
- **Performance:** a synthetic 10,000-object fixture checks the NFR timings at S1.
- **CI** adds the browser tests, schema validation of the synthetic fixtures, and the skill-fixture job.

## Out of Scope

- Phase B (blocked by the Phase A exit gate): personal Areas migration and the `actions.md` personal rows (#10), recurring tasks, Belongings (#9), personal calendar, Home Assistant, learning intake (podcasts, YouTube, books).
- The in-app LLM provider and API-key setup (#5, deferred). One-click in-app AI processing.
- Email and Slack extraction as task sources. Inbox triage stays in Steve.
- PDF, document, audio and video ingestion. Semantic or vector search.
- Calendar write access, and creating calendar events for tasks.
- Slack write-back (replies changing LifeOS). Phone push notifications. A mobile or PWA client.
- Organization and client linking for external people, and any further external-people features.
- Obsidian-specific features (Bases, graph views, wikilink compatibility).
- Hosted, multi-user or simultaneous editing. Splitting the vault (reviewed separately on 31 October 2026).
- Goals and Habits. Running finance, investing or health in LifeOS.
- Todoist (parked). Jira coexists and is never written from LifeOS.

## Further Notes

- **Glossary additions for `CONTEXT.md`:**
  - **Inbox Draft:** an agent-written file in `_inbox/` awaiting adoption. Not an object. (Avoid: draft task, which is a Review Item.)
  - **Adoption:** the application turning an Inbox Draft into objects or Review Items.
  - **Patch Draft:** an Inbox Draft that changes an existing object.
  - **Work Order:** an app-written request for an agent run (enrichment, replan).
  - **Enrichment:** collecting post-meeting material and proposals.
  - **Agent Index:** the derived, disposable summary files agents read.
  - **Daily Focus:** the agent-written morning brief object.
  - **Focus Override:** the user's app-owned changes to the day's Top 3.
  - **Origin:** how an object came to exist.
  - **Sensitivity:** whether agents and exports may use an object.
  - **External person:** a person whose email domain is not internal.
- **Policy assumption:** sending work meeting content to Claude is acceptable because the provider does not train on company data (the user's statement). Whether client contracts allow third-party processing of client meeting content is `[TBD - confirm with Eagle Eye IT/legal]`.
- **To verify:**
  - whether cloud routines can use the Gong and Slack connectors `[TBD - verify]`
  - whether macOS file-watch events fire reliably for Drive-synced files (restart and full rescan is the fallback) `[TBD - verify on Rahul's Mac]`
- **Exit plan:** copy the data folder and the latest verified backup to a personal location, re-enter OAuth credentials in Settings on the new machine, and point the data root there. This is part of the 31 October 2026 data-root review.
- **Dated reminders:** data-root and employer-account review by **31 Oct 2026**. CI check on or after **19 Oct 2026** (the `ubuntu-latest` move to Ubuntu 26). The user still needs to connect the Gong and Slack connectors in Claude.
- **Superseded charting decisions (map #1):** direct agent writes, the in-app Claude API, and the Markor/FolderSync Android capture. Resolved here: #4 (Object Contract), #5 (deferred), #7 (Phase A sources: Calendar, Meet/Drive, Gong, Gmail summaries; Slack is output only; Jira, Confluence and Aha! stay outside), #8 (exit gate plus quality gate).
- **Design document:** Solution Design v0.5 should be bumped to v0.6 to reflect this spec once tickets land.
