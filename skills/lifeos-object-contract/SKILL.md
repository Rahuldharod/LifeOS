---
name: lifeos-object-contract
description: The rules for asking LifeOS to create or change anything. Defines the Inbox Draft and Patch Draft file formats, the draft kinds, how LifeOS routes them, the language rule, the restricted rule and the self-check. Use whenever you write a file into a LifeOS _inbox/ folder, or check what happened to one. The lifeos-capture skill follows these rules.
metadata:
  version: "1.0.0"
  draft_contract: 1
  patch_contract: 1
---

# LifeOS Object Contract (v1)

LifeOS keeps Rahul's tasks, decisions, open points, notes and people as Markdown **objects** in a data root folder. Only the LifeOS app writes objects. You never create, edit, rename or delete an object file.

To change LifeOS you write one small Markdown file into the inbox. The app **adopts** it: it checks it, gives it an ID, links names, files it, and writes a `.result.md` next to it saying what happened.

## The data root

The data root is the folder that holds `_inbox/` and `_agent/`. If Rahul has not said which folder it is, ask once. Never guess between two folders.

| Folder | Who writes | What |
| --- | --- | --- |
| `_inbox/drafts/` | you | Inbox Drafts: create something new |
| `_inbox/patches/` | you | Patch Drafts: change something that exists |
| `_inbox/processed/` | LifeOS | adopted drafts and their `.result.md` |
| `_inbox/failed/` | LifeOS | refused drafts and their `.result.md` (never deleted automatically) |
| `_inbox/requests/` | LifeOS | Work Orders for Agent runs |
| `_agent/` | LifeOS | the Agent Index you read (see the lifeos-ask skill) |

Write nothing anywhere else. Never write into `_inbox/processed/`, `_inbox/failed/` or `_agent/`.

## Writing a file

- One draft or patch per file. Write the whole file in one go.
- File name: lower-case, no spaces, ends in `.md`, never starts with `.`, never ends in `.result.md`. Use `YYYY-MM-DD-HHMM-short-slug.md`.
- The file is front matter between `---` lines, then an optional Markdown body.
- LifeOS waits until a file is 2 seconds old before reading it, and retries a file it cannot parse once in case it is still syncing.
- Adoption runs only while the LifeOS app on the Mac is running. Until then the file waits; nothing is lost.

## Inbox Draft format (`lifeos_draft: 1`)

Required on every draft:

| Field | Value |
| --- | --- |
| `lifeos_draft` | `1` |
| `kind` | one of the kinds below |
| `draft_key` | any unique text you choose, e.g. `phone-2026-10-04-0915-sizing-deck` |
| `origin` | `user-dictated` or `agent-extracted` (see Routing) |
| `title` | the object's title, in the source language |
| `captured_at` | when Rahul said it or the material was captured: ISO 8601 with `Z` or an offset, e.g. `2026-10-04T09:15:00+02:00`, or a plain date `2026-10-04` |

Never include `operation_id`: LifeOS generates it. A draft carrying one is refused.

Optional on every kind: `area` (`work`, `maintenance`, `household`, `learning`, `personal-projects`, `personal-growth`), `sensitivity` (`normal` or `restricted`), `subjects` and `tags` (lists of text). The body is the narrative: context, what was said.

### Kinds

| Kind | Extra fields | Names it may reference |
| --- | --- | --- |
| `task` | `status` (`Inbox` default, `Next`, `Waiting`, `Done`, `Cancelled`), `priority` (`High`, `Medium`, `Low`), `due_on` (`YYYY-MM-DD`) **or** `due_at` (date-time with offset) plus `due_timezone`, `expected_output` | `project`, `client`, `product`, `people`, `owner`, `waiting_for` (needs `status: Waiting`), `meeting` |
| `decision` | `decision_text` (defaults to the title), `decided_at` (defaults to `captured_at`) | `project`, `client`, `product`, `people`, `meeting` |
| `open-point` | none (always created open) | `project`, `client`, `product`, `people`, `owner`, `meeting` |
| `knowledge-note` | `sources`: one or a list of source IDs, exact source titles or URLs. With no sources, the body is kept as the idea's own source | none |
| `source` | `url` (http or https) and/or pasted text in the body; `occurred_at` | none |
| `person` | `email` or `emails`, `given_name`, `family_name`, `organization_name`, `job_title`, `aliases`, `is_external` | none |
| `meeting-material` | written by the enrichment skill only | `meeting` |
| `daily-focus` | written by the daily focus skill only | none |

A reference field a kind does not list is refused, not ignored.

### References by name

Write `project`, `client`, `product`, `owner`, `waiting_for` and `meeting` as one name or ID. Write `people` as a list. People can be named by full name, first name, alias or email. A meeting can be named by its calendar event ID or meeting ID.

LifeOS matches names exactly, ignoring case and accents. It never guesses:

- One match: linked.
- No match, or several: a dictated object is still created, and LifeOS raises a `link-resolution` Review Item for Rahul to pick. On an extracted proposal the name is listed as unresolved.
- Restricted objects are never matched by name, only by ID.

Use the ID from the Agent Index when a name is ambiguous.

## Routing

| `origin` | Use when | What LifeOS does |
| --- | --- | --- |
| `user-dictated` | Rahul told you this himself ("remind me to…", "note that we decided…") | Creates the object directly. A task gets status Inbox and owner Rahul unless named. |
| `agent-extracted` | You found it in material: an email, transcript, document, chat | Raises a create-type **Review Item**. Nothing exists until Rahul accepts it. |

Extracted `task`, `decision`, `open-point` and `knowledge-note` drafts need:

- `confidence`: `High`, `Medium` or `Low`.
- `evidence` (recommended): a list of `{ field, source, locator, quote }`. `field` defaults to `title`. `source` is a source ID, or the exact title or URL of a source, meeting or note. `locator` says where (page, timestamp). `quote` is the exact words.
- An extracted `knowledge-note` also needs at least one source.

`source` and `person` drafts are adopted directly whatever the origin. A person is created as `unreviewed`, and likely duplicates become `person-merge` Review Items. A person whose email is already known is not created twice.

## Patch Draft format (`lifeos_patch: 1`)

| Field | Value |
| --- | --- |
| `lifeos_patch` | `1` |
| `draft_key` | unique text, as for drafts |
| `origin` | `user-dictated` or `agent-extracted` |
| `captured_at` | when Rahul asked for the change |
| target | `id` (preferred, from the Agent Index), or the exact `title` plus `type` (`task`, `decision`, `open-point`…) |
| `set` | field: value pairs to change. `null` clears a field |
| `append_note` | text added at the end of the object's body |

Give `set`, `append_note` or both. In `set`, references use the names above (`owner`, `waiting_for`, `project`…). To supersede a decision use `superseded_by` with the newer decision. To resolve an open point set `status: resolved` with a `resolution_summary` (or `resolution_decision_id`). `id`, `type`, `revision`, `origin`, timestamps and supersede links can never be set.

What happens:

- **Applies on its own** only when `user-dictated` and the target is a task changing `status`, `due_on`, `due_at`, `due_timezone`, `priority` or `waiting_for` (with status Waiting), or when it only appends a note. Rahul can undo it in LifeOS.
- **Becomes an `update` Review Item** for everything else: titles, owners, decision text, any field on a decision, closing or resolving an open point, any `agent-extracted` patch, and any field Rahul changed after `captured_at` (conflict rule).

## Idempotency

- Re-sending the same file with the same `draft_key` is harmless: the result is `duplicate`.
- The same `draft_key` with different content is refused. Use a new `draft_key` for a new capture, and a patch to change something already adopted.
- A draft that **failed** created nothing: fix it and send it again (a new file name is safest).

## Language rule

Outputs follow the language of the source. A French meeting gives French titles and bodies; an English email gives English ones. Never translate.

Field names and fixed values stay exactly as written here, in English: `kind`, `status: Waiting`, `priority: High`, `confidence: Medium`.

## Restricted rule

- Never open, read, quote or summarise a file whose front matter says `sensitivity: restricted`. If you open one by accident, stop and do not use what you saw.
- The Agent Index never lists restricted objects; it only counts them. Do not hunt for them.
- When Rahul says something is private, add `sensitivity: restricted` to the draft.
- This is a rule you follow, not a lock: the files sit in the same folder. Finance and health records are kept out of LifeOS altogether.

## Self-check: read the `.result.md`

After writing a file, check what happened. Never report success before this.

1. Wait a few seconds, then look for `<file name>.result.md` in `_inbox/processed/` or `_inbox/failed/`. If the name was taken, LifeOS adds `-2`, `-3`; match on `draft_key`.
2. Read its `outcome`:

| `outcome` | Folder | Tell Rahul |
| --- | --- | --- |
| `adopted` | processed | Created. Give the title and the first ID in `object_ids`. |
| `applied` | processed | Changed, and it can be undone in LifeOS. |
| `review` | processed | Waiting for his review in LifeOS; nothing changed yet. |
| `duplicate` | processed | Already received earlier; nothing new. |
| `failed` | failed | Not adopted. Read `errors` (each says `field: reason`), fix the draft and send it again. |

3. No `.result.md` yet: say the draft is **pending adoption** and will be adopted when LifeOS next runs on the Mac. Do not send it again with different content.

`object_ids` can list more than the main object: Review Items for unknown names, or Sources created for a note.

## Examples

Every example below is tested against the real LifeOS adoption code. The comment above each one says what LifeOS does with it.

A dictated task:

<!-- fixture: {"name": "contract-dictated-task", "folder": "drafts", "outcome": "adopted", "creates": ["task"], "fields": {"type": "task", "status": "Inbox", "origin": "user-dictated", "priority": "High", "due_on": "2026-10-09"}} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: desktop-2026-10-04-0915-sizing-deck-v2
origin: user-dictated
title: Send Joel the updated sizing deck
captured_at: 2026-10-04T09:15:00+02:00
priority: High
due_on: 2026-10-09
people: [Joel]
project: Spring Promo
---
Joel asked for the updated sizing deck before Friday's review.
```

A dictated person:

<!-- fixture: {"name": "contract-dictated-person", "folder": "drafts", "outcome": "adopted", "creates": ["person"], "fields": {"type": "person", "review_state": "unreviewed", "given_name": "Ines"}} -->
```markdown
---
lifeos_draft: 1
kind: person
draft_key: desktop-2026-10-04-0930-ines-moreau
origin: user-dictated
title: Ines Moreau
captured_at: 2026-10-04T09:30:00+02:00
email: ines.moreau@example.com
job_title: Category manager
---
Met at the Example Grocer supplier day.
```

A dictated patch that applies on its own:

<!-- fixture: {"name": "contract-patch-done", "folder": "patches", "outcome": "applied", "creates": ["task"], "fields": {"status": "Done"}} -->
```markdown
---
lifeos_patch: 1
draft_key: phone-2026-10-04-1700-sizing-deck-done
origin: user-dictated
captured_at: 2026-10-04T17:00:00+02:00
title: Send Joel the sizing deck
type: task
set:
  status: Done
---
```

Refused: `captured_at` has a time but no `Z` or offset, so the instant is ambiguous.

<!-- fixture: {"name": "contract-failed-no-offset", "folder": "drafts", "outcome": "failed", "error": "captured_at: not an ISO 8601 date-time with Z or an offset"} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: phone-2026-10-04-1010-book-room
origin: user-dictated
title: Book a room for the pilot kick-off
captured_at: 2026-10-04 10:10
---
```

Refused: an extracted draft must say how sure you are.

<!-- fixture: {"name": "contract-failed-no-confidence", "folder": "drafts", "outcome": "failed", "error": "confidence: missing"} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: email-2026-10-04-1100-store-list
origin: agent-extracted
title: Share the pilot store list with Camille
captured_at: 2026-10-04T11:00:00Z
---
From Camille's email of 4 October.
```
