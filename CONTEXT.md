# LifeOS

A single system for running one person's professional and personal life: calendar, meetings, tasks, knowledge and upkeep, stored as typed Markdown objects.

## Language

### Life domains

**Area**:
One broad life domain an object belongs to; exactly one per object, carried as a tag. Values: work, maintenance, household, learning, personal-projects, personal-growth.
_Avoid_: Domain, category, life area

**Maintenance** (Area):
Upkeep of things the user owns or runs, typically recurring (home systems, devices, appliances, vehicles).
_Avoid_: Repairs, home automation (that is one source of maintenance work, not the Area)

**Household** (Area):
Chores, errands and life paperwork that are not upkeep of a specific owned thing.
_Avoid_: Life admin, chores

**Learning** (Area):
Taking in external knowledge (podcasts, videos, books, articles) and distilling it into Knowledge Notes.

**Personal growth** (Area):
Reflection and self-development work. Goals and Habits are deliberately not modelled.
_Avoid_: Self-improvement

**Belonging**:
A physical thing the user owns or runs and may need to maintain (device, appliance, home system, vehicle). The subject of Maintenance work.
_Avoid_: Asset, possession, equipment

### Actors

**Agent**:
A non-human actor (e.g. a Claude agent such as Steve) that reads the Agent Index and writes Inbox Drafts on the user's behalf. An Agent never writes objects directly (ADR 0007), is not a Person and cannot own commitments without the user accepting them.
_Avoid_: Bot, assistant, AI user

**Object Contract**:
The written rules an Agent must follow to ask for a LifeOS object to be created or changed: the Inbox Draft and Patch Draft formats, the draft kinds, how Adoption routes them, and which changes always become Review Items.

**Object Envelope**:
The common front-matter fields every LifeOS object carries (identity, type, schema version, revision, title, lifecycle timestamps).

**Review Item**:
A proposed commitment or meaning-changing edit awaiting the user's accept, edit or reject. Not authoritative until accepted.
_Avoid_: Suggestion, draft task

**Inbox Draft**:
An Agent-written file in `_inbox/` awaiting Adoption. Not an object.
_Avoid_: Draft task (that is a Review Item)

**Adoption**:
The application turning an Inbox Draft into objects or Review Items: it assigns IDs, resolves names, validates, files and routes.
_Avoid_: Import, sync

**Patch Draft**:
An Inbox Draft that changes an existing object rather than creating one.

**Work Order**:
An app-written request in `_inbox/requests/` for an Agent run, such as Enrichment or a replan.
_Avoid_: Job, task (a Task is a user commitment)

**App Feedback**:
A Bug or Feature note about LifeOS itself, typed into the app's feedback button. Not an object: it never appears in Notes or the Agent Index, and it gets a backlog ID only when promoted into the Product Backlog.
_Avoid_: Inbox item, idea (the backlog's Inbox is where it lands after promotion)

**App version**:
The calendar version of the LifeOS code that is running, as `YY.MM.DD.N`: the Paris date of a merge to main and which merge of that day it was (`26.10.14.2`). A build of anything other than main adds `-dev+` and its commit (`26.10.14.2-dev+abc1234`). The UI and the server each have one, and they can differ until `update-app` runs.
_Avoid_: Version (alone), release, build number; not a Version copy, schema version, Skills pack version or contract version

**Work Order filing rule**:
The one exception to "Agents never write into `_inbox/processed/`": when an Agent finishes a Work Order, it moves that file from `_inbox/requests/` to `_inbox/processed/`, and nothing else. A Work Order still in `requests/` counts as not done.

**Skills pack**:
The Claude skills in `skills/` (Object Contract, capture, ask, enrichment, morning) that Agents follow. Every example in them is adopted by the real code in CI, so skill text and code cannot drift.
_Avoid_: Prompts, plugins

**Enrichment**:
Collecting post-meeting material (transcripts, recordings, Gong calls, emailed summaries) and the proposals drawn from it.

**Agent Index**:
The derived, disposable summary files in `_agent/` that Agents read instead of scanning every object.
_Avoid_: Cache, export

**Daily Focus**:
The Agent-written morning brief object for one date: what the user owes, the Top 3 with why-today, waiting and decisions, meeting prep and day shape. Its Top 3 may list up to 5 items; Today shows at most **Max must-dos**.
_Avoid_: Daily plan, agenda

**Focus Override**:
The user's app-owned changes to one date's Top 3: pin, unpin, replace, dismiss, restore (un-dismiss) and reset.

**Max must-dos**:
The synced setting (1–5, default 3) for how many items Today's Top 3 shows, whether from the brief or the priority rule. Pinned tasks count towards it.
_Avoid_: Top 3 limit

**Origin**:
How an object came to exist: app, user-dictated, agent-extracted, calendar, imported or external. Set once, never changed.
_Avoid_: Source (a Source is an object)

**Sensitivity**:
Whether Agents and exports may use an object: normal or restricted. Restricted objects show a lock badge in the app and are left out of the Agent Index, Work Orders and the brief. A Review Item is restricted when anything it was drawn from is.

**Restricted meeting**:
A meeting that is restricted itself or whose meeting note is restricted. Every exclusion of a meeting uses this one rule.
_Avoid_: Privacy level, confidentiality

**External person**:
A Person whose email domain is not one of the Internal domains; shown as "Name - ext".
_Avoid_: Guest, contact

### Files

**Asset**:
A binary file (image, PDF, recording) attached to a note or source. Not a physical possession.
_Avoid_: Attachment, possession

### People

**Self person**:
The one Person who is the user. Every address in **My email addresses** resolves to it, so the user is never duplicated as an attendee.
_Avoid_: Me, owner (owner is a task field)

**Internal domains**:
The synced setting listing the email domains of the user's own organisations. With none set, nobody is marked External.

**Unreviewed person**:
A Person LifeOS created automatically (from a calendar invite or an adopted draft) that the user has not yet confirmed. Shown with the text "unreviewed" until the user confirms or saves it. A merge suggestion always involves at least one unreviewed person.
_Avoid_: New contact, pending person

**Display label**:
How a Person is shown everywhere: first name, or full name when another live person shares the first name, plus " - ext" for an External person.

### Interface language

**Reference data**:
Projects, Clients, Products and People: records maintained in Settings and reached contextually from the work they describe.
_Avoid_: Entities, master data

**Global Search**:
The search available from every workspace for live Tasks, Calendar events and Notes. It includes restricted records and excludes archived and deleted records; when a Calendar event has a Meeting Note, only the Meeting Note appears.
_Avoid_: Universal search, vault search

**Global Capture**:
The task-only capture available from every workspace without leaving the current page. It extends Quick Capture with optional task context but does not infer other object types.
_Avoid_: Quick Capture (the Today entry point), smart capture

**My Tasks**:
The default Tasks view: live tasks owned by the Self person. It shows unfinished work unless the user explicitly filters for Done or Cancelled tasks.
_Avoid_: Tasks linked to me, my linked tasks

**Waiting on others**:
The Tasks view containing the user's own Waiting tasks that identify another person in `waiting_for_person_id`.
_Avoid_: Waiting On, delegated tasks

**Other people's tasks**:
The Tasks view containing live tasks owned by anyone other than the Self person. It shows unfinished work unless the user explicitly filters for Done or Cancelled tasks.
_Avoid_: All tasks, delegated tasks

**Task owner**:
The Person responsible for a Task. Ownership determines its Tasks view, not permission: the sole LifeOS user may edit or complete any Task.
_Avoid_: Assignee, task user

**Reopen status**:
The unfinished status a Task held immediately before completion, retained so Undo or reopening can restore it. A legacy completed Task without one reopens as Next.
_Avoid_: Previous status, undo status

**Waiting since**:
The instant a Task most recently entered Waiting, used to surface the oldest waits first. A legacy Waiting Task without it falls back to its last-updated time.
_Avoid_: Waiting age, updated time

### Meetings and enrichment

**Calendar event**:
An occurrence supplied by a connected calendar. Opening one is a read-only preview and creates no LifeOS object.
_Avoid_: Meeting object, appointment

**Meeting record**:
The internal LifeOS object created on the first edit of a Calendar event, anchoring its Meeting Note, enrichment and event identity. The interface continues to present the Calendar event rather than exposing this implementation record as a separate destination.
_Avoid_: Calendar event, meeting page

**Meeting Note**:
A Note linked to a Meeting record and initiated from a Calendar event. It can be edited from the Calendar event workspace or opened independently in Notes.
_Avoid_: Meeting, calendar note

**Standalone Note**:
A Note the user starts from the Notes tab, with no Meeting record and no Source. It carries the same Project, Client, Product, People and Sensitivity as a Meeting Note and never turns into one (ADR 0023).
_Avoid_: Ad-hoc note, manual note, plain note

**Recurring series**:
The Calendar occurrences that share one provider recurrence identity. Each occurrence keeps its own Meeting record and its own Meeting Note; the series is shown together but never stored together (ADR 0021).
_Avoid_: Repeated meeting, recurring Meeting record

**Series view**:
What opening a recurring occurrence shows: its own Meeting Note plus the Notes of the 4 most recent earlier occurrences, newest first, each saved to its own file. Each Note keeps its own Sensitivity.
_Avoid_: Series document, recurring document

**Legacy shared Note**:
A Meeting Note that merged several occurrences into sections under the superseded ADR 0019. It is kept as is and displayed for each Meeting in its `meeting_ids`; new occurrences get their own Notes.
_Avoid_: Recurring Meeting Note (retired term)

**External meeting notes**:
A document outside LifeOS containing notes for a Calendar occurrence, such as Google or Gemini notes. It is linked as a Source and may inform proposals, but its full content is not copied into the Meeting Note.
_Avoid_: Meeting Note, imported notes

**Enrichment state**:
Where a meeting is in Enrichment: none, requested, enriched, partial or gave up. The meeting page shows it in text as **Not requested**, **Requested**, **Enriched**, **Partial** or **Gave up**, with the material still missing or found unavailable.

**Client-content gate**:
The switch at the top of the enrichment skill that decides whether client meetings may be enriched. It stays `blocked` until IT/legal sign-off; only an edit to the skill file opens it. A meeting counts as client unless every attendee's domain is an Internal domain; with no Internal domains set, every real meeting counts as client.
_Avoid_: Client filter, policy flag

**Offline calendar**:
What Today and the calendar view show when Google Calendar cannot be reached (network, sign-in or Keychain denied): the meetings already stored in LifeOS, under an "Offline" banner with the last sync time and a Retry. Not a separate cache, and never demo meetings.
_Avoid_: Stale cache, cached events

**Meeting material**:
The Inbox Draft kind an Agent writes after Enrichment: Sources, an optional summary, proposals with evidence, and material checked and found `unavailable`.

**Summary section**:
The accepted meeting summary, kept in the meeting body between `lifeos:summary:start` and `lifeos:summary:end` markers. The meeting note is never changed.

### Safety and recovery

**Live**:
Neither deleted (`deleted_at`) nor archived (`archived_at`). Lists, rollups and name matching show live objects only. An identifier (object ID, email, URL) also reaches an archived object, so it is reused rather than duplicated; only deleted objects are gone.

**Version copy**:
A copy of an object kept in `.lifeos/versions/` on each save; the last 10 per object are kept (ADR 0012). The newest is the **baseline** for spotting edits made outside the app.
_Avoid_: Backup (a Backup is a whole-vault snapshot)

**Operation journal**:
The record in `.lifeos/operations/` written before the first file of a multi-file step, so startup recovery can finish or undo it (ADR 0013).

**Replay-safe**:
A step that ends in the same files whether it runs once, twice at once, or again after a crash.

**Off-Drive copy**:
The weekly copy of the newest verified Backup to a folder outside Google Drive (an external disk, say); four are kept. Each Mac sets its own folder.
_Avoid_: Second backup, sync

**Clean stop**:
How LifeOS stops: refuse new writes, let adoption finish, take the stop Backup, then release the device lease, all within 60 seconds.

**Recorded intent**:
A user choice (such as rejecting a Review Item) journalled before any undo write. Recovery honours it over the operation it undoes.

### Editor

**Unproven formatting**:
The text label Visual mode shows on a note that holds Markdown the editor would rewrite when saved (for example `-` bullets or `---` rules). Meaning is kept but the bytes may change; Markdown mode keeps the note exactly as written.
_Avoid_: Broken formatting, unsupported Markdown
