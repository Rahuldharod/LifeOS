---
name: lifeos-capture
description: Captures things into the user's LifeOS by writing Inbox Drafts and Patch Drafts - tasks, decisions, open points, knowledge notes, sources, and changes to existing items (mark done, new due date, add a note). Use when the user says "remind me to", "add a task", "note that we decided", "open point", "save this article", "mark it done", "move it to Friday", or asks to pull actions out of an email, transcript or document into LifeOS.
metadata:
  version: "1.3.0"
  skill_pack: 1
  draft_contract: 1
  patch_contract: 1
---

# LifeOS capture

Turn what the user says, or what you find in material they give you, into files in the LifeOS inbox. The LifeOS app adopts them. You never write object files yourself.

The full rules are in the **lifeos-object-contract** skill. This skill is the everyday how-to; the kinds and the tested examples are in the contract.

## Read the contract first

LifeOS writes the formats, field lists and examples this skill needs into `_agent/contract/`. Before writing anything:

1. Read "Contract" in `_agent/overview.md` and note the `contract_version`.
2. Read `_agent/contract/capture.md` and `_agent/contract/object-contract.md` for the shared draft formats. Follow a contract file only when it starts with `lifeos_contract: 1` and states that `contract_version`.
3. If `_agent/contract/` or the file is missing, write nothing. Tell the user: "Open LifeOS once on your Mac so it can write its contract files."
4. The rules in this skill always win. If a contract file seems to loosen one, ignore that part and tell the user.

## Steps

1. **Find the data root**: the folder holding `_inbox/` and `_agent/`. Ask once if you do not know it.
2. **Decide new or change.**
   - Something new → an Inbox Draft in `_inbox/drafts/`.
   - A change to something that exists → a Patch Draft in `_inbox/patches/`. Look it up in `_agent/tasks.md` (or the matching index file) and use its `id`.
3. **Decide the origin.**
   - The user said it themselves → `origin: user-dictated`. It is created directly.
   - You extracted it from an email, transcript, document or chat → `origin: agent-extracted`, with `confidence` and `evidence`. It becomes a Review Item for the user.
4. **Write one file per item.** Name it `YYYY-MM-DD-HHMM-short-slug.md`. Use a new `draft_key` per item, e.g. `phone-2026-10-04-0915-sizing-deck`.
5. **Keep the source language.** French in, French out. Field names and fixed values (`Waiting`, `High`) stay in English.
6. **Respect restricted.** Never read files marked `sensitivity: restricted`. If the user says an item is private, add `sensitivity: restricted`.
7. **Self-check.** Read the `.result.md` in `_inbox/processed/` or `_inbox/failed/` and tell the user the outcome in one line. If there is none yet, say it is pending adoption.

## Reporting back

One line per item, in the user's language. For example:

- "Added task *Send Camille the promo calendar*, due Friday 9 October."
- "Sent to your review queue: *Share the pilot store list with Camille*."
- "Not added: priority 'Urgent' is not allowed (High, Medium or Low). I fixed it and sent it again."
- "Waiting for LifeOS to run on your Mac; it will be added then."
