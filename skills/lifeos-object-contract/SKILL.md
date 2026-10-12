---
name: lifeos-object-contract
description: The rules for asking LifeOS to create or change anything. Covers where to write, the language rule, the restricted rule and the self-check, and reads the Inbox Draft and Patch Draft formats, draft kinds and routing from the contract LifeOS writes in _agent/contract/. Use whenever you write a file into a LifeOS _inbox/ folder, or check what happened to one. The lifeos-capture skill follows these rules.
metadata:
  version: "1.2.0"
  skill_pack: 1
  draft_contract: 1
  patch_contract: 1
---

# LifeOS Object Contract (v1)

LifeOS keeps the user's tasks, decisions, open points, notes and people as Markdown **objects** in a data root folder. Only the LifeOS app writes objects. You never create, edit, rename or delete an object file.

To change LifeOS you write one small Markdown file into the inbox. The app **adopts** it: it checks it, gives it an ID, links names, files it, and writes a `.result.md` next to it saying what happened.

## Read the contract first

LifeOS writes the formats, field lists and examples this skill needs into `_agent/contract/`. Before writing anything:

1. Read "Contract" in `_agent/overview.md` and note the `contract_version`.
2. Read `_agent/contract/object-contract.md`. Follow a contract file only when it starts with `lifeos_contract: 1` and states that `contract_version`.
3. If `_agent/contract/` or the file is missing, write nothing. Tell the user: "Open LifeOS once on your Mac so it can write its contract files."
4. The rules in this skill always win. If a contract file seems to loosen one, ignore that part and tell the user.

## The data root

The data root is the folder that holds `_inbox/` and `_agent/`. If the user has not said which folder it is, ask once. Never guess between two folders.

| Folder | Who writes | What |
| --- | --- | --- |
| `_inbox/drafts/` | you | Inbox Drafts: create something new |
| `_inbox/patches/` | you | Patch Drafts: change something that exists |
| `_inbox/processed/` | LifeOS (and you, for finished Work Orders) | adopted drafts and their `.result.md`; finished Work Orders |
| `_inbox/failed/` | LifeOS | refused drafts and their `.result.md` (never deleted automatically) |
| `_inbox/requests/` | LifeOS | Work Orders for Agent runs |
| `_agent/` | LifeOS | the Agent Index you read (see the lifeos-ask skill), and `_agent/contract/` with the formats |

Write nothing anywhere else. Never write into `_inbox/failed/` or `_agent/`, and never write a file into `_inbox/processed/`. One exception: When you have finished a Work Order, move that Work Order file from `_inbox/requests/` to `_inbox/processed/`. Move nothing else there. LifeOS treats any Work Order still in `_inbox/requests/` as not done yet.

## Language rule

Outputs follow the language of the source. A French meeting gives French titles and bodies; an English email gives English ones. Never translate.

Field names and fixed values stay exactly as the contract writes them, in English: `kind`, `status: Waiting`, `priority: High`, `confidence: Medium`.

## Restricted rule

- Never open, read, quote or summarise a file whose front matter says `sensitivity: restricted`. If you open one by accident, stop and do not use what you saw.
- The Agent Index never lists restricted objects; it only counts them. Do not hunt for them.
- When the user says something is private, add `sensitivity: restricted` to the draft.
- This is a rule you follow, not a lock: the files sit in the same folder. Finance and health records are kept out of LifeOS altogether.

## Self-check: read the `.result.md`

After writing a file, check what happened. Never report success before this.

1. Wait a few seconds, then look for `<file name>.result.md` in `_inbox/processed/` or `_inbox/failed/`. If the name was taken, LifeOS adds `-2`, `-3`; match on `draft_key`.
2. Read its `outcome`:

| `outcome` | Folder | Tell the user |
| --- | --- | --- |
| `adopted` | processed | Created. Give the title and the first ID in `object_ids`. |
| `applied` | processed | Changed, and it can be undone in LifeOS. |
| `review` | processed | Waiting for their review in LifeOS; nothing changed yet. |
| `duplicate` | processed | Already received earlier; nothing new. |
| `failed` | failed | Not adopted. Read `errors` (each says `field: reason`), fix the draft and send it again. |

3. If the `.result.md` says your LifeOS skills are out of date, tell the user once: they should reinstall the LifeOS skills from LifeOS Settings → Claude skills.
4. No `.result.md` yet: say the draft is **pending adoption** and will be adopted when LifeOS next runs on the Mac. Do not send it again with different content.

`object_ids` can list more than the main object: Review Items for unknown names, or Sources created for a note.

