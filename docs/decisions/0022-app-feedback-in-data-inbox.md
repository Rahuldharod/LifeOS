# ADR 0022: App Feedback lands in the data inbox, not the code repo

- Status: Accepted
- Date: 2026-10-14
- Source: user decision of 2026-10-14, grilling PB-018 (in-app feedback button)
- Extends: ADR 0007 (Inbox Drafts), ADR 0014 (code outside Google Drive)

## Context

PB-018 asked the feedback button to append a row to the Inbox of `docs/product-design/Product Backlog.md` at runtime. The stable app runs from the main code checkout on each Mac (ADR 0006, ADR 0014). A runtime write there leaves uncommitted changes that block `git pull` and agent branches. Feedback typed on one Mac would never reach the other. Assigning the next PB ID at submit time races between Macs, and the backlog already has a PB-015/016 collision.

Alternatives: append to the repo backlog (above problems), or create a GitHub issue from the server (needs network and a token, fails offline).

## Decision

- **Where.** Each submission is one Markdown file in `<data root>/_inbox/feedback/`, named `YYYY-MM-DD-HHmmss-<device>-<4 random chars>.md` and written atomically. Drive syncs it to both Macs. Adoption does not read this folder.
- **Not an object.** App Feedback never goes through `ObjectStore`, never appears in Notes or the Agent Index, and needs no device lease: each file is new and edited by no one.
- **Format.** Frontmatter `lifeos_feedback: 1`, `label` (bug or feature), `captured_at`, `page`, optional `object` (`lifeos://` link of the open object), `app_version` (the version in the root `package.json`, the single source), `app_commit` (short git commit of the running build), `device`; the body is the user's text as typed.
- **No ID at submit.** A PB ID is assigned only when an Agent promotes the item.
- **Promotion** is a developer task started by the user ("process app feedback"), documented in `AGENTS.md` and `docs/agents/app-feedback.md`, not in the skills pack. The Agent works in a worktree, adds one row per item to the backlog's Inbox table (`[Bug] PB-0xx — …`), rewrites client names and real emails (`a client`, `example.com`) and lists what it changed, and opens a docs PR. It deletes the feedback files only after that PR is merged.
- **Nudge.** The session-start hook reports how many App Feedback files are waiting.
- **Failure.** If the write fails, the dialog stays open with the text and shows the error.

## Consequences

- The code checkout is never written at runtime; the backlog changes only through reviewed PRs.
- Feedback waits in Drive until someone runs promotion; the session-start nudge keeps it visible.
- Deleting promoted files is a data-root delete by an Agent, allowed only because the folder is under `_inbox/` (data guard hook); Drive's bin keeps them 30 days.
