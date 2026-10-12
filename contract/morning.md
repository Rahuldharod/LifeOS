---
lifeos_contract: 1
contract_version: 1
---

# LifeOS contract: morning routine

The draft fields, the Slack DM lines, replan and the tested examples for the **lifeos-morning** skill. The never-does list, the self-check and the DM rules stay in the skill and always win.

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

## Replan

LifeOS **Refresh** writes a `replan` Work Order to `_inbox/requests/`. When the user says "run LifeOS replan", or a scheduled run finds one:

1. Follow its body. Use its `focus_on`.
2. Write a new brief with a new `draft_key` and the current `generated_at`. The newer one wins.
3. When you have finished a Work Order, move that Work Order file from `_inbox/requests/` to `_inbox/processed/`. Move nothing else there.
4. Do not send a Slack DM for a replan.

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
