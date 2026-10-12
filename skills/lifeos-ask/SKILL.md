---
name: lifeos-ask
description: Answers questions about the user's LifeOS - open tasks, what they owe or are waiting on, open points, recent decisions, projects, clients, people and meetings - by reading the LifeOS Agent Index in the _agent/ folder. Warns when the index is more than 24 hours old and never reads restricted files. Use when the user asks "what do I owe Joel?", "what's overdue?", "what did we decide about X?", "who is waiting on me?", or any question about his LifeOS data.
metadata:
  version: "1.1.0"
  skill_pack: 1
  agent_index_contract: 1
---

# LifeOS ask

Answer the user's questions from the **Agent Index**: short summary files LifeOS writes into `_agent/` in the data root. Read the index first. Open an object file only when the answer needs detail the index does not have.

This skill only reads. To add or change something, use the **lifeos-capture** skill.

## Steps

1. **Find the data root**: the folder holding `_inbox/` and `_agent/`. Ask once if you do not know it.
2. **Read `_agent/overview.md` first.** It lists the other files, the counts and the pending drafts.
3. **Check freshness.** Every index file has `generated_at` in its front matter. Check today's date and time first. If `generated_at` is **more than 24 hours old**, start your answer with a warning, for example: "Heads-up: the LifeOS index was last updated 2 days ago, so this may be out of date. Open LifeOS on your Mac to refresh it." If `_agent/` is missing or empty, say LifeOS has not written its index yet, and stop.
4. **Read the one file that answers the question** (table below). Each entry has the object's `id`, `path` and key fields.
5. **Open an object only when needed**, at the `path` the index gives (relative to the data root). Before using it, check its front matter. If it says `sensitivity: restricted`, stop and do not use it.
6. **Answer briefly**, in the language the user asked in. Lead with the answer, then a few bullets. Name items by title; add the ID only when the user needs it to act on the item.

## Which file answers what

| Question | File |
| --- | --- |
| Overview, counts, pending drafts, where things live | `_agent/overview.md` |
| My open tasks: overdue, today, upcoming, no date | `_agent/tasks.md` |
| What am I waiting on, from whom, for how long | `_agent/waiting-on.md` |
| Open questions still to settle | `_agent/open-points.md` |
| What did we decide (last 30 days) | `_agent/decisions.md` |
| Active projects, clients and products | `_agent/projects-clients-products.md` |
| Who is someone, their email, internal or external | `_agent/people.md` |
| Meetings from the last 14 days and the next 7 | `_agent/meetings.md` |
| Drafts sent but not adopted yet | `_agent/pending-adoption.md` |

"What do I owe Joel?" needs two files: `_agent/tasks.md` for tasks linked to Joel, and `_agent/meetings.md` for recent meetings with him. Use `_agent/people.md` to tell two people with the same first name apart.

## Rules

- **Restricted is off limits.** The index never lists restricted objects; it says how many it left out ("2 restricted not listed"). You may repeat that count. Never open, quote or summarise a file marked `sensitivity: restricted`, and never search the data root to find one.
- **Only open paths the index gives you.** Do not list or browse object folders to find other files.
- **Pending drafts are not facts yet.** Items in `_agent/pending-adoption.md` have not been adopted. If you mention one, say it is pending.
- **The index is read-only for you.** Never edit `_agent/` files or object files.
- **No guessing.** If the index does not hold the answer, say so and say which file you checked.
- **Keep dates honest.** Say "today", "tomorrow", "3 days overdue" from today's date, and give the date.

## Example

The user: "What's overdue?"

You read `_agent/overview.md` (generated 40 minutes ago), then `_agent/tasks.md`, and answer:

> 2 tasks are overdue:
> - **Send Joel the sizing deck**: due Thursday 2 October, High priority (Spring Promo)
> - **Relancer Camille sur le budget promo**: due Friday 3 October
>
> 1 restricted item is not shown.
