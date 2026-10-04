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
Whether Agents and exports may use an object: normal or restricted. Restricted objects show a lock badge in the app and are left out of the Agent Index, Work Orders and the brief.

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

**Display label**:
How a Person is shown everywhere: first name, or full name when another live person shares the first name, plus " - ext" for an External person.

### Meetings and enrichment

**Enrichment state**:
Where a meeting is in Enrichment: none, requested, enriched, partial or gave up.

**Meeting material**:
The Inbox Draft kind an Agent writes after Enrichment: Sources, an optional summary, proposals with evidence, and material checked and found `unavailable`.

**Summary section**:
The accepted meeting summary, kept in the meeting body between `lifeos:summary:start` and `lifeos:summary:end` markers. The meeting note is never changed.

### Safety and recovery

**Live**:
Neither deleted (`deleted_at`) nor archived (`archived_at`).

**Version copy**:
A copy of an object kept in `.lifeos/versions/` on each save; the last 10 per object are kept (ADR 0012). The newest is the **baseline** for spotting edits made outside the app.
_Avoid_: Backup (a Backup is a whole-vault snapshot)

**Operation journal**:
The record in `.lifeos/operations/` written before the first file of a multi-file step, so startup recovery can finish or undo it (ADR 0013).

**Replay-safe**:
A step that ends in the same files whether it runs once, twice at once, or again after a crash.

**Recorded intent**:
A user choice (such as rejecting a Review Item) journalled before any undo write. Recovery honours it over the operation it undoes.
