# Processing App Feedback

Follow this when the user says "process app feedback". Format and reasoning: ADR 0022. Done means every feedback file is a backlog row in a merged docs PR, and the files are then deleted.

## Where feedback lives

One file per item in `<LIFEOS_DATA_ROOT>/_inbox/feedback/`. It is not a LifeOS object: do not use `ObjectStore`.

| Field | Meaning |
| --- | --- |
| `label` | `bug` or `feature` |
| `captured_at` | When the user submitted it |
| `page`, `object` | Where in the app; `object` is an optional `lifeos://` link |
| `device` | Which Mac or device |
| `app_version` | App version, `YY.MM.DD.N` (ends `-dev+<commit>` off main; older files say `0.1.0`) |
| `app_commit` | Git commit the app ran from (older files may only have `app_version`) |
| body | The user's text as typed |

If `LIFEOS_DATA_ROOT` is unset in your shell, ask the user for it. Never guess a path.

## Steps

1. Create a worktree from `origin/main` and a branch `docs/app-feedback-<date>`. Never use the main checkout.
2. Read every file in the folder (`ls`, then read each). Reading is the only data-root access during promotion; do not change any file there yet.
3. Take the next free PB ID: the highest `PB-0xx` anywhere in `docs/product-design/Product Backlog.md`, plus one. Skip the PB-015/016 collision; never reuse an ID.
4. Add one row per item to the **Inbox** table of `docs/product-design/Product Backlog.md`:

   | Column | Value |
   | --- | --- |
   | Captured | The feedback date, `YYYY-MM-DD`, in the user's local time zone. `captured_at` is UTC (`Z`): convert it. The filename already shows local time |
   | Idea | `[Bug] PB-0xx — …` or `[Feature] PB-0xx — …`, from `label` |
   | Source / context | Page, device, `app_version` and `app_commit`; for example `App Feedback: Tasks page, laptop, 26.10.14.2 (a1b2c3d)` |

5. Rewrite each item in plain words. Never paste the user's text. Replace client names with "a client" and real emails with `example.com` addresses. The repo is Git history; real data stays out (`AGENTS.md`).
6. Open a docs PR to `main`. In the body, list every rewrite (original wording against new wording) so the user can check the privacy changes. Do not merge it.
7. After the user merges the PR, delete the processed feedback files from `_inbox/feedback/`. The data guard hook blocks agent writes outside `_inbox/`, so this delete is allowed because the folder is under `_inbox/`. Never move the files to `_inbox/processed/`. Delete only the files you promoted; a file that arrived meanwhile stays.

## Session nudge

`scripts/hooks/feedback-nudge.mjs` runs at session start and prints how many files wait. It only counts. When `LIFEOS_DATA_ROOT` is not in the hook's environment it asks an interactive zsh for it (3 s timeout). It is silent when the root or folder is missing or anything fails.
