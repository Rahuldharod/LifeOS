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
The Agent-written morning brief object for one date: what the user owes, the Top 3 with why-today, waiting and decisions, meeting prep and day shape.
_Avoid_: Daily plan, agenda

**Focus Override**:
The user's app-owned changes (pin, replace, dismiss) to one date's Top 3.

**Origin**:
How an object came to exist: app, user-dictated, agent-extracted, calendar, imported or external. Set once, never changed.
_Avoid_: Source (a Source is an object)

**Sensitivity**:
Whether Agents and exports may use an object: normal or restricted.
_Avoid_: Privacy level, confidentiality

**External person**:
A Person whose email domain is not one of the internal domains; shown as "Name - ext".
_Avoid_: Guest, contact

### Files

**Asset**:
A binary file (image, PDF, recording) attached to a note or source. Not a physical possession.
_Avoid_: Attachment, possession
