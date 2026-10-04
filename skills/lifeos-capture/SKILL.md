---
name: lifeos-capture
description: Captures things into Rahul's LifeOS by writing Inbox Drafts and Patch Drafts - tasks, decisions, open points, knowledge notes, sources, and changes to existing items (mark done, new due date, add a note). Use when Rahul says "remind me to", "add a task", "note that we decided", "open point", "save this article", "mark it done", "move it to Friday", or asks to pull actions out of an email, transcript or document into LifeOS.
metadata:
  version: "1.0.0"
  draft_contract: 1
  patch_contract: 1
---

# LifeOS capture

Turn what Rahul says, or what you find in material he gives you, into files in the LifeOS inbox. The LifeOS app adopts them. You never write object files yourself.

The full rules are in the **lifeos-object-contract** skill. This skill is the everyday how-to, and every example here is tested against LifeOS.

## Steps

1. **Find the data root**: the folder holding `_inbox/` and `_agent/`. Ask once if you do not know it.
2. **Decide new or change.**
   - Something new → an Inbox Draft in `_inbox/drafts/`.
   - A change to something that exists → a Patch Draft in `_inbox/patches/`. Look it up in `_agent/tasks.md` (or the matching index file) and use its `id`.
3. **Decide the origin.**
   - Rahul said it himself → `origin: user-dictated`. It is created directly.
   - You extracted it from an email, transcript, document or chat → `origin: agent-extracted`, with `confidence` and `evidence`. It becomes a Review Item for Rahul.
4. **Write one file per item.** Name it `YYYY-MM-DD-HHMM-short-slug.md`. Use a new `draft_key` per item, e.g. `phone-2026-10-04-0915-sizing-deck`.
5. **Keep the source language.** French in, French out. Field names and fixed values (`Waiting`, `High`) stay in English.
6. **Respect restricted.** Never read files marked `sensitivity: restricted`. If Rahul says an item is private, add `sensitivity: restricted`.
7. **Self-check.** Read the `.result.md` in `_inbox/processed/` or `_inbox/failed/` and tell Rahul the outcome in one line. If there is none yet, say it is pending adoption.

## Choosing the kind

| Rahul says or the material shows | Kind |
| --- | --- |
| something to do | `task` (`status: Waiting` plus `waiting_for` when someone else owes it) |
| something agreed or chosen | `decision` |
| a question still open, to settle later | `open-point` |
| an idea or lesson worth keeping | `knowledge-note` |
| an article, video or document to keep | `source` |

Dates: use `due_on: YYYY-MM-DD` for a day. Work out "Friday" from today's date, and check today's date first.

## Examples: new items

A dictated task, linked by name to a project and a person:

<!-- fixture: {"name": "capture-task-dictated", "folder": "drafts", "outcome": "adopted", "creates": ["task"], "fields": {"type": "task", "title": "Send Camille the promo calendar", "status": "Inbox", "origin": "user-dictated", "priority": "Medium", "due_on": "2026-10-09"}} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: phone-2026-10-04-0920-promo-calendar
origin: user-dictated
title: Send Camille the promo calendar
captured_at: 2026-10-04T09:20:00+02:00
priority: Medium
due_on: 2026-10-09
project: Spring Promo
people: [Camille Dubois]
---
She needs it for the store briefing.
```

Language rule: dictated in French, kept in French. A task waiting on someone:

<!-- fixture: {"name": "capture-task-french-waiting", "folder": "drafts", "outcome": "adopted", "creates": ["task"], "fields": {"type": "task", "title": "Relancer Camille sur le budget promo", "status": "Waiting"}} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: phone-2026-10-04-0940-relance-budget
origin: user-dictated
title: Relancer Camille sur le budget promo
captured_at: 2026-10-04T09:40:00+02:00
status: Waiting
waiting_for: Camille
client: Example Grocer
---
Elle doit confirmer le budget avant jeudi.
```

A name LifeOS does not know is never guessed. The task is created, and a Review Item asks Rahul which project he meant:

<!-- fixture: {"name": "capture-task-unknown-project", "folder": "drafts", "outcome": "adopted", "creates": ["task", "review-item"], "fields": {"type": "task", "title": "Draft the autumn loyalty brief"}} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: phone-2026-10-04-1005-autumn-brief
origin: user-dictated
title: Draft the autumn loyalty brief
captured_at: 2026-10-04T10:05:00+02:00
project: Autumn Loyalty
---
```

A private task, kept out of the Agent Index and the morning brief:

<!-- fixture: {"name": "capture-task-restricted", "folder": "drafts", "outcome": "adopted", "creates": ["task"], "fields": {"type": "task", "sensitivity": "restricted"}} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: phone-2026-10-04-1015-private-call
origin: user-dictated
title: Call the notary back
captured_at: 2026-10-04T10:15:00+02:00
area: household
sensitivity: restricted
---
```

A dictated decision:

<!-- fixture: {"name": "capture-decision-dictated", "folder": "drafts", "outcome": "adopted", "creates": ["decision"], "fields": {"type": "decision", "status": "active", "decision_text": "The spring promo launches on 3 March with double points on fresh produce."}} -->
```markdown
---
lifeos_draft: 1
kind: decision
draft_key: desktop-2026-10-04-1100-launch-date
origin: user-dictated
title: Spring promo launches on 3 March
captured_at: 2026-10-04T11:00:00+02:00
decision_text: The spring promo launches on 3 March with double points on fresh produce.
project: Spring Promo
people: [Joel Martin, Camille Dubois]
---
Agreed in the Thursday steering call.
```

A dictated open point:

<!-- fixture: {"name": "capture-open-point-dictated", "folder": "drafts", "outcome": "adopted", "creates": ["open-point"], "fields": {"type": "open-point", "status": "open"}} -->
```markdown
---
lifeos_draft: 1
kind: open-point
draft_key: desktop-2026-10-04-1110-coupon-cap
origin: user-dictated
title: Do we cap digital coupons per shopper?
captured_at: 2026-10-04T11:10:00+02:00
project: Spring Promo
owner: Joel
---
```

An action you extracted from an email. It becomes a Review Item, with your confidence and the evidence:

<!-- fixture: {"name": "capture-task-extracted", "folder": "drafts", "outcome": "adopted", "creates": ["review-item"], "fields": {"type": "review-item", "review_type": "create", "target_object_type": "task", "status": "pending", "confidence_label": "High"}} -->
```markdown
---
lifeos_draft: 1
kind: task
draft_key: email-2026-10-04-1130-store-list
origin: agent-extracted
title: Share the pilot store list with Camille
captured_at: 2026-10-04T11:30:00Z
confidence: High
people: [Camille Dubois]
evidence:
  - field: title
    source: "Email from camille.dubois@example.com, 4 October"
    quote: "Could you send me the list of pilot stores by Wednesday?"
---
Camille asked for the store list in her email of 4 October.
```

A knowledge note from an article Rahul shared. The link becomes a Source:

<!-- fixture: {"name": "capture-knowledge-with-link", "folder": "drafts", "outcome": "adopted", "creates": ["knowledge-note", "source"], "fields": {"type": "knowledge-note"}} -->
```markdown
---
lifeos_draft: 1
kind: knowledge-note
draft_key: phone-2026-10-04-1200-personalised-offers
origin: user-dictated
title: Personalised offers beat blanket discounts
captured_at: 2026-10-04T12:00:00+02:00
area: learning
subjects: [personalisation]
sources: https://example.com/articles/personalised-offers
---
Targeted offers lifted redemption more than store-wide discounts, at lower cost.
```

An idea with no source. The body is kept as its own source:

<!-- fixture: {"name": "capture-knowledge-idea", "folder": "drafts", "outcome": "adopted", "creates": ["knowledge-note", "source"], "fields": {"type": "knowledge-note"}} -->
```markdown
---
lifeos_draft: 1
kind: knowledge-note
draft_key: phone-2026-10-04-1215-points-expiry-idea
origin: user-dictated
title: Remind shoppers before points expire
captured_at: 2026-10-04T12:15:00+02:00
area: work
---
A reminder a week before points expire could bring lapsed shoppers back.
```

A source to keep for later:

<!-- fixture: {"name": "capture-source-link", "folder": "drafts", "outcome": "adopted", "creates": ["source"], "fields": {"type": "source", "source_type": "web-link", "url": "https://example.com/podcasts/retail-media-episode-12"}} -->
```markdown
---
lifeos_draft: 1
kind: source
draft_key: phone-2026-10-04-1230-retail-media-podcast
origin: user-dictated
title: Retail media podcast, episode 12
captured_at: 2026-10-04T12:30:00+02:00
url: https://example.com/podcasts/retail-media-episode-12
area: learning
---
```

## Examples: changes to existing items

Use the `id` from the Agent Index when you have it. These examples use the exact title and type instead.

Move a due date and raise the priority. Applies on its own:

<!-- fixture: {"name": "capture-patch-due-priority", "folder": "patches", "outcome": "applied", "creates": ["task"], "fields": {"due_on": "2026-10-10", "priority": "High"}} -->
```markdown
---
lifeos_patch: 1
draft_key: phone-2026-10-04-1300-sizing-deck-friday
origin: user-dictated
captured_at: 2026-10-04T13:00:00+02:00
title: Send Joel the sizing deck
type: task
set:
  due_on: 2026-10-10
  priority: High
---
```

Add a note to an item. Applies on its own:

<!-- fixture: {"name": "capture-patch-append-note", "folder": "patches", "outcome": "applied", "creates": ["open-point"]} -->
```markdown
---
lifeos_patch: 1
draft_key: phone-2026-10-04-1310-pilot-stores-note
origin: user-dictated
captured_at: 2026-10-04T13:10:00+02:00
title: Which stores join the pilot?
type: open-point
append_note: Joel suggests starting with the 12 Lyon stores.
---
```

Renaming changes meaning, so it waits for Rahul's review:

<!-- fixture: {"name": "capture-patch-rename", "folder": "patches", "outcome": "review", "creates": ["review-item"], "fields": {"type": "review-item", "review_type": "update", "target_object_type": "task", "status": "pending"}} -->
```markdown
---
lifeos_patch: 1
draft_key: phone-2026-10-04-1320-rename-sizing-deck
origin: user-dictated
captured_at: 2026-10-04T13:20:00+02:00
title: Send Joel the sizing deck
type: task
set:
  title: Send Joel the final sizing deck
---
```

Resolving an open point always waits for review. Say how it was settled in `resolution_summary`:

<!-- fixture: {"name": "capture-patch-resolve-open-point", "folder": "patches", "outcome": "review", "creates": ["review-item"], "fields": {"type": "review-item", "review_type": "update", "target_object_type": "open-point"}} -->
```markdown
---
lifeos_patch: 1
draft_key: desktop-2026-10-04-1330-pilot-stores-resolved
origin: user-dictated
captured_at: 2026-10-04T13:30:00+02:00
title: Which stores join the pilot?
type: open-point
set:
  status: resolved
  resolution_summary: The pilot starts in the 12 Lyon stores.
---
```

A change you found in material, not one Rahul asked for, always waits for review:

<!-- fixture: {"name": "capture-patch-extracted", "folder": "patches", "outcome": "review", "creates": ["review-item"], "fields": {"type": "review-item", "review_type": "update"}} -->
```markdown
---
lifeos_patch: 1
draft_key: email-2026-10-04-1340-sizing-deck-done
origin: agent-extracted
captured_at: 2026-10-04T13:40:00Z
title: Send Joel the sizing deck
type: task
set:
  status: Done
---
```

## Reporting back

One line per item, in Rahul's language. For example:

- "Added task *Send Camille the promo calendar*, due Friday 9 October."
- "Sent to your review queue: *Share the pilot store list with Camille*."
- "Not added: priority 'Urgent' is not allowed (High, Medium or Low). I fixed it and sent it again."
- "Waiting for LifeOS to run on your Mac; it will be added then."
