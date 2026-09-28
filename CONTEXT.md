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
A non-human actor (e.g. a Claude agent such as Steve) that reads and writes LifeOS objects on the user's behalf. An Agent is not a Person and cannot own commitments without the user accepting them.
_Avoid_: Bot, assistant, AI user

**Object Contract**:
The written rules an Agent must follow to create or change a LifeOS object directly as a file, including the Object Envelope and which changes must be proposed as Review Items.

**Object Envelope**:
The common front-matter fields every LifeOS object carries (identity, type, schema version, revision, title, lifecycle timestamps).

**Review Item**:
A proposed commitment or meaning-changing edit awaiting the user's accept, edit or reject. Not authoritative until accepted.
_Avoid_: Suggestion, draft task

### Files

**Asset**:
A binary file (image, PDF, recording) attached to a note or source. Not a physical possession.
_Avoid_: Attachment, possession
