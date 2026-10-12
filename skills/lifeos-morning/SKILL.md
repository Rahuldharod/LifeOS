---
name: lifeos-morning
description: The LifeOS morning routine. On workday mornings it reads the LifeOS Agent Index, today's calendar and pending drafts, writes the Daily Focus brief as a daily-focus Inbox Draft (what the user owes, Top 3, waiting and decisions, meeting prep, day shape, defer candidates), then sends the user a read-only 5-line Slack DM. Never includes restricted items and does no inbox triage. Use when a scheduled routine runs "LifeOS morning", when the user asks for his Daily Focus, or when a replan Work Order says "run LifeOS replan".
metadata:
  version: "1.1.0"
  skill_pack: 1
  draft_contract: 1
  agent_index_contract: 1
---

# LifeOS morning routine

Each workday morning you write the user's **Daily Focus** brief into the LifeOS inbox, then send them a short Slack DM. LifeOS adopts the brief and shows it on its Today page, with live status on top.

Follow the **lifeos-object-contract** skill for every file you write. Read the index the way the **lifeos-ask** skill does.

## What this routine never does

- **No restricted items.** Never open, quote or count by name anything marked `sensitivity: restricted`. Use only objects listed in `_agent/`; restricted ones are never listed there.
- **No inbox triage.** Do not read or summarise email, Slack or Jira. That stays in Steve's separate brief.
- **No writes except one draft and one DM.** Never edit objects, `_agent/` files or settings. The DM goes to the user only, and it is read-only: no questions, no buttons, nothing to reply to.
- **No secrets.** Never put links with tokens, email bodies or passwords in the brief or the DM.

## When it runs

| Setting | Default | Where |
| --- | --- | --- |
| Brief time | **06:00** | `settings/today.md` → `brief_time` |
| Time zone | **Europe/Paris** | `settings/today.md` → `brief_time_zone` |
| Days | Monday to Friday | `settings/today.md` → `brief_days` |
| Max must-dos (Top 3 size) | 3 (1 to 5) | `settings/daily-focus.md` → `max_must_dos` |

The user changes these in LifeOS **Settings**. Read only the front matter of these two files. If a file is missing, use the default.

If today (in the brief time zone) is not one of the brief days, stop and send nothing.

## Steps

1. **Find the data root**: the folder holding `_inbox/` and `_agent/`. A scheduled run has it in its prompt. Never guess between two folders.
2. **Check today's date and time** in the brief time zone. This is `focus_on`.
3. **Read the Agent Index.** Start with `_agent/overview.md`. If `generated_at` is more than 24 hours old, still write the brief, but start the body with "Index is N days old: open LifeOS to refresh." If `_agent/` is missing, stop and send the DM line "LifeOS index missing; no brief today."
4. **Read what you need:**
   - `_agent/tasks.md`: overdue, today, upcoming and undated tasks.
   - `_agent/waiting-on.md`, `_agent/open-points.md`, `_agent/decisions.md`: what to chase or settle.
   - `_agent/meetings.md`: today's meetings ("Next 7 days").
   - `_agent/pending-adoption.md`: drafts sent but not adopted. They are not facts yet. If a `daily-focus` draft for today is already pending, stop: do not write a second one (unless this is a replan).
5. **Read today's calendar** with the calendar connector, for the day shape only. Skip declined and all-day events. Never copy event titles into the brief: name a meeting only when it is listed in `_agent/meetings.md`. If the calendar cannot be read, use today's meetings from `_agent/meetings.md` and say so in the body.
6. **Build the sections** (table below). Use IDs exactly as the index gives them.
7. **Write the body**: about 250 to 300 words, never more than 300. Order: I owe → Top 3 → waiting and decisions → meeting prep → day shape. Short lines, plain words.
8. **Run the self-check** (below). Fix every problem before writing.
9. **Write the draft** to `_inbox/drafts/YYYY-MM-DD-HHMM-daily-focus.md`, in one go.
10. **Check the `.result.md`** as the Object Contract says. No result yet means **pending adoption** (the Mac is off). That is fine: the brief is adopted when LifeOS next runs.
11. **Send the Slack DM** (format below), then stop.

## The draft

Front matter fields, as LifeOS checks them:

| Field | What to put |
| --- | --- |
| `skill_pack` | `1` |
| `kind` | `daily-focus` |
| `origin` | `agent-extracted` |
| `title` | `Daily Focus YYYY-MM-DD` |
| `draft_key` | `routine-YYYY-MM-DD-HHMM-daily-focus` (a new one each run) |
| `captured_at`, `generated_at` | now, with the time-zone offset |
| `focus_on` | today, `YYYY-MM-DD` |
| `i_owe` | tasks the user owes: overdue, due today, and actions from yesterday's meetings. Each: `task_id`, `overdue` (true or false) |
| `top3` | 1 up to **max must-dos** tasks (never more than 5). Each: `task_id`, `why_today` (required), `if_then` ("If it is 9:00, then I…": when, where, how long) |
| `waiting_and_decisions` | aged waiting-on tasks, open points and recent decisions to act on. Each: `object_id`, `age_days` (whole days) |
| `meeting_prep` | up to 3 of today's key meetings. Each: `meeting_id` (from `_agent/meetings.md`), `context`, `ask` (the user's ask) |
| `day_shape` | `meeting_hours` and `free_hours` for the working day, information only |
| `defer_candidates` | 0 to 3 tasks to consider deferring, only when must-dos do not fit the free hours. Each: `task_id`, `reason`. Never a meeting. Never applied for them |

Choosing the Top 3: what is overdue or due today first, then High priority, then what unblocks someone else. Size it to the free hours. Each `why_today` says why today and not tomorrow.

Free hours: the working day is 09:00 to 18:00 in the brief time zone, minus meeting time. `[TBD — make working hours a LifeOS setting]`

A newer brief for the same date replaces the older one in LifeOS. The user's pins, swaps and dismissals on Today are kept separately and survive a new brief.

## Self-check before writing

Check each line. Fix the draft until all pass.

1. **Every ID is listed.** Each `task_id`, `object_id` and `meeting_id` appears as `id: <ID>` in an `_agent/` file you read this run. Remove any entry whose ID does not. Restricted objects are never listed, so this keeps them out. It also catches typos.
2. **Sizes.** `top3` has 1 to max must-dos entries, each with `why_today`. `meeting_prep` and `defer_candidates` have at most 3 entries.
3. **Body.** 300 words or fewer. It names only items in the sections or the index, and never "(restricted)".
4. **Language.** Titles stay as the index writes them. Never translate.

LifeOS itself accepts a brief that points at a restricted item: Today hides it and counts it. So this check is the only thing that keeps restricted items out of your brief and DM.

## The Slack DM

Send it to the user themselves, as a direct message from the Slack connector. Exactly 5 lines:

1. `LifeOS · <weekday> <day> <month>`
2. `Top 3: <title> · <title> · <title>` (titles from the index, the brief's Top 3 order)
3. `I owe: <count> (<overdue count> overdue)` (the `i_owe` entries, and how many have `overdue: true`)
4. `Day: <meeting_hours> h meetings · <free_hours> h free`
5. `Brief: LifeOS Today (http://127.0.0.1:4310) · _inbox/drafts/<file name>`, adding `(pending adoption)` when there is no `.result.md` yet

Rules: nothing restricted, no other titles, no questions, no inbox items. If Slack is not connected or the send fails, the brief still counts: say so in the routine's run log and stop. Never retry with a different channel or person.

## Replan

LifeOS **Refresh** writes a `replan` Work Order to `_inbox/requests/`. When the user says "run LifeOS replan", or a scheduled run finds one:

1. Follow its body. Use its `focus_on`.
2. Write a new brief with a new `draft_key` and the current `generated_at`. The newer one wins.
3. When you have finished a Work Order, move that Work Order file from `_inbox/requests/` to `_inbox/processed/`. Move nothing else there.
4. Do not send a Slack DM for a replan.

## Running it on a schedule

The user sets this up themselves. Steps are in `skills/INSTALL.md`, Part 7.

| Option | When | Notes |
| --- | --- | --- |
| **Cloud routine (preferred)** | Runs even when the Mac is off | Needs the Drive connector to read `_agent/` and write `_inbox/drafts/`, plus Calendar and Slack. `[TBD — verify cloud routines can use Slack/Gong connectors]` `[TBD — verify a cloud routine can write files into Drive]` |
| **Desktop scheduled task (fallback)** | Runs only when the Mac is awake and Claude desktop is open | Reads and writes the data root directly through the Filesystem extension |

Schedule: the brief time and days set in LifeOS Settings (default: workdays at 06:00 Europe/Paris). If the scheduler only takes UTC, convert it: for example 06:00 Paris is 04:00 UTC in summer (CEST) and 05:00 UTC in winter (CET): check after each clock change. When the user changes the brief time in Settings, they must change the schedule too; this skill cannot.

## Examples

Every example below is tested against the real LifeOS code with synthetic data. The comment above each says what LifeOS and the self-check do with it.

A busy Monday (5.5 hours of meetings), so one task is offered for deferral:

<!-- fixture: {"name": "morning-brief-busy-monday", "folder": "drafts", "outcome": "adopted", "creates": ["daily-focus"], "fields": {"type": "daily-focus", "focus_on": "2026-10-05", "day_shape": {"meeting_hours": 5.5, "free_hours": 3.5}}, "selfCheck": "pass"} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: daily-focus
draft_key: routine-2026-10-05-0600-daily-focus
origin: agent-extracted
title: Daily Focus 2026-10-05
captured_at: 2026-10-05T06:00:00+02:00
generated_at: 2026-10-05T06:00:00+02:00
focus_on: 2026-10-05
i_owe:
  - task_id: 0192f000-0000-7000-8000-000000000101
    overdue: true
  - task_id: 0192f000-0000-7000-8000-000000000102
    overdue: false
  - task_id: 0192f000-0000-7000-8000-000000000103
    overdue: false
top3:
  - task_id: 0192f000-0000-7000-8000-000000000101
    why_today: Joel needs it for Friday's review and it is 3 days late
    if_then: If it is 08:30, then I open the deck at my desk for 45 minutes
  - task_id: 0192f000-0000-7000-8000-000000000102
    why_today: Due today, and the steering call needs the number
    if_then: If the weekly call ends, then I approve it before 11:00
  - task_id: 0192f000-0000-7000-8000-000000000103
    why_today: Due today; Camille briefs the stores on Wednesday
waiting_and_decisions:
  - object_id: 0192f000-0000-7000-8000-000000000201
    age_days: 6
  - object_id: 0192f000-0000-7000-8000-000000000401
    age_days: 4
meeting_prep:
  - meeting_id: 0192f000-0000-7000-8000-000000000502
    context: The 12-store pilot was decided on 1 October; the store list is still open
    ask: Agree who picks the pilot stores, and by when
day_shape:
  meeting_hours: 5.5
  free_hours: 3.5
defer_candidates:
  - task_id: 0192f000-0000-7000-8000-000000000105
    reason: Due Friday; the venue can be booked on Wednesday with no risk
---
## I owe (3, 1 overdue)
- Send Joel the sizing deck: 3 days late.
- Approve the Spring Promo budget: due today.
- Draft the pilot store list: due today.

## Top 3
1. Sizing deck. Joel needs it for Friday. 08:30 at your desk, 45 minutes.
2. Spring Promo budget. Approve it before 11:00, after the weekly call.
3. Pilot store list. Camille briefs the stores on Wednesday.

## Waiting and decisions
- Camille to confirm the store count: 6 days. Chase her.
- Which stores join the pilot? Open 4 days. Settle it at steering.

## Meeting prep
- Spring Promo steering (14:00). The 12-store pilot is decided. Your ask: agree who picks the stores, and by when.

## Day shape
5.5 hours of meetings, 3.5 hours free. A heavy day: keep the Top 3 small.

## Consider deferring
- Book the supplier day venue: Wednesday is fine.
```

The DM for that brief:

<!-- slack-dm: {"brief": "morning-brief-busy-monday"} -->
```text
LifeOS · Monday 5 October
Top 3: Send Joel the sizing deck · Approve the Spring Promo budget · Draft the pilot store list
I owe: 3 (1 overdue)
Day: 5.5 h meetings · 3.5 h free
Brief: LifeOS Today (http://127.0.0.1:4310) · _inbox/drafts/2026-10-05-0600-daily-focus.md
```

A light Tuesday with max must-dos set to 4 in Settings: four Top 3 items, no meetings, nothing to defer:

<!-- fixture: {"name": "morning-brief-light-tuesday", "folder": "drafts", "outcome": "adopted", "creates": ["daily-focus"], "fields": {"type": "daily-focus", "focus_on": "2026-10-06", "day_shape": {"meeting_hours": 0, "free_hours": 9}}, "selfCheck": "pass", "maxMustDos": 4} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: daily-focus
draft_key: routine-2026-10-06-0600-daily-focus
origin: agent-extracted
title: Daily Focus 2026-10-06
captured_at: 2026-10-06T06:00:00+02:00
generated_at: 2026-10-06T06:00:00+02:00
focus_on: 2026-10-06
i_owe:
  - task_id: 0192f000-0000-7000-8000-000000000101
    overdue: true
  - task_id: 0192f000-0000-7000-8000-000000000102
    overdue: true
top3:
  - task_id: 0192f000-0000-7000-8000-000000000101
    why_today: 4 days late, and Joel's review is on Friday
    if_then: If it is 09:00, then I finish the deck before anything else
  - task_id: 0192f000-0000-7000-8000-000000000102
    why_today: A day late; finance is waiting
  - task_id: 0192f000-0000-7000-8000-000000000105
    why_today: A free day is the time to book the venue for Friday
  - task_id: 0192f000-0000-7000-8000-000000000104
    why_today: No meetings today, so there is room to read
    if_then: If it is 16:00, then I read it for 30 minutes with a coffee
waiting_and_decisions:
  - object_id: 0192f000-0000-7000-8000-000000000201
    age_days: 7
  - object_id: 0192f000-0000-7000-8000-000000000301
    age_days: 5
day_shape:
  meeting_hours: 0
  free_hours: 9
---
## I owe (2, 2 overdue)
- Send Joel the sizing deck: 4 days late.
- Approve the Spring Promo budget: 1 day late.

## Top 3 (4 today)
1. Sizing deck, first thing at 09:00.
2. Spring Promo budget. Finance is waiting.
3. Book the supplier day venue.
4. Loyalty pricing paper, 30 minutes at 16:00.

## Waiting and decisions
- Camille to confirm the store count: 7 days. Chase her today.
- Pilot runs in 12 stores: decided 5 days ago. Tell the store teams.

## Day shape
No meetings, 9 hours free.
```

Wrong: the Top 3 names a restricted task. LifeOS would still adopt it (Today hides it and counts it), so the self-check must catch it: the ID is not listed in `_agent/`. Remove the entry and choose another task.

<!-- fixture: {"name": "morning-brief-restricted-caught", "folder": "drafts", "outcome": "adopted", "creates": ["daily-focus"], "fields": {"type": "daily-focus", "focus_on": "2026-10-05"}, "selfCheck": "fail"} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: daily-focus
draft_key: routine-2026-10-05-0605-daily-focus-wrong
origin: agent-extracted
title: Daily Focus 2026-10-05
captured_at: 2026-10-05T06:05:00+02:00
generated_at: 2026-10-05T06:05:00+02:00
focus_on: 2026-10-05
i_owe:
  - task_id: 0192f000-0000-7000-8000-000000000101
    overdue: true
top3:
  - task_id: 0192f000-0000-7000-8000-000000000199
    why_today: Due today
  - task_id: 0192f000-0000-7000-8000-000000000101
    why_today: Joel needs it for Friday's review
day_shape:
  meeting_hours: 5.5
  free_hours: 3.5
---
## Top 3
1. Due today.
2. Sizing deck for Joel.
```
