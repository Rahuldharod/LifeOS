---
name: lifeos-morning
description: The LifeOS morning routine. On workday mornings it reads the LifeOS Agent Index, today's calendar and pending drafts, writes the Daily Focus brief as a daily-focus Inbox Draft (what the user owes, Top 3, waiting and decisions, meeting prep, day shape, defer candidates), then sends the user a read-only 5-line Slack DM. Never includes restricted items and does no inbox triage. Use when a scheduled routine runs "LifeOS morning", when the user asks for their Daily Focus, or when a replan Work Order says "run LifeOS replan".
metadata:
  version: "1.3.0"
  skill_pack: 1
  draft_contract: 1
  agent_index_contract: 1
---

# LifeOS morning routine

Each workday morning you write the user's **Daily Focus** brief into the LifeOS inbox, then send them a short Slack DM. LifeOS adopts the brief and shows it on its Today page, with live status on top.

Follow the **lifeos-object-contract** skill for every file you write. Read the index the way the **lifeos-ask** skill does.

## Read the contract first

LifeOS writes the formats, field lists and examples this skill needs into `_agent/contract/`. Before writing anything:

1. Read "Contract" in `_agent/overview.md` and note the `contract_version`.
2. Read `_agent/contract/morning.md` and `_agent/contract/object-contract.md` for the shared draft formats. Follow a contract file only when it starts with `lifeos_contract: 1` and states that `contract_version`.
3. If `_agent/contract/` or the file is missing, write nothing. Tell the user: "Open LifeOS once on your Mac so it can write its contract files."
4. The rules in this skill always win. If a contract file seems to loosen one, ignore that part and tell the user.

## What this routine never does

- **No restricted items.** Never open, quote or count by name anything marked `sensitivity: restricted`. Use only objects listed in `_agent/`; restricted ones are never listed there.
- **No inbox triage.** Do not read or summarise email, Slack or Jira. That belongs in a separate inbox brief, not this one.
- **No writes except one draft and one DM.** Never edit objects, `_agent/` files or settings. The DM goes to the user only, and it is read-only: no questions, no buttons, nothing to reply to. One exception for replans (see the contract): When you have finished a Work Order, move that Work Order file from `_inbox/requests/` to `_inbox/processed/`. Move nothing else there.
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
6. **Build the sections** (see "The draft" in the contract). Use IDs exactly as the index gives them.
7. **Write the body**: about 250 to 300 words, never more than 300. Order: I owe → Top 3 → waiting and decisions → meeting prep → day shape. Short lines, plain words.
8. **Run the self-check** (below). Fix every problem before writing.
9. **Write the draft** to `_inbox/drafts/YYYY-MM-DD-HHMM-daily-focus.md`, in one go.
10. **Check the `.result.md`** as the Object Contract says. No result yet means **pending adoption** (the Mac is off). That is fine: the brief is adopted when LifeOS next runs.
11. **Send the Slack DM** (format below), then stop.

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

## Running it on a schedule

The user sets this up themselves. Steps are in `skills/INSTALL.md`, Part 7.

| Option | When | Notes |
| --- | --- | --- |
| **Cloud routine (preferred)** | Runs even when the Mac is off | Needs the Drive connector to read `_agent/` and write `_inbox/drafts/`, plus Calendar and Slack. `[TBD — verify cloud routines can use Slack/Gong connectors]` `[TBD — verify a cloud routine can write files into Drive]` |
| **Desktop scheduled task (fallback)** | Runs only when the Mac is awake and Claude desktop is open | Reads and writes the data root directly through the Filesystem extension |

Schedule: the brief time and days set in LifeOS Settings (default: workdays at 06:00 Europe/Paris). If the scheduler only takes UTC, convert it: for example 06:00 Paris is 04:00 UTC in summer (CEST) and 05:00 UTC in winter (CET): check after each clock change. When the user changes the brief time in Settings, they must change the schedule too; this skill cannot.

