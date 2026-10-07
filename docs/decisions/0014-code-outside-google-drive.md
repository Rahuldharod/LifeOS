# ADR 0014: Code outside Google Drive; data located by LIFEOS_DATA_ROOT

- Status: Accepted
- Date: 2026-10-07
- Supersedes: ADR 0001 (code and data as sibling folders inside `LifeOS App/`)

## Context

ADR 0001 kept the Git repository in `LifeOS App/code`, next to `LifeOS App/data`, inside Google Drive. The code folder grew to hundreds of thousands of small files (`node_modules`, build output, agent worktrees under `.claude/worktrees`, which reached 73 worktrees and 13 GB). Google Drive cannot ignore subfolders, and "online only" does not stop the upload. Two Macs share the data; the desktop is often left running while the laptop is used.

## Decision

- **Code** lives in `~/Developer/LifeOS` on each Mac and moves between them through GitHub only.
- **Data** stays in Google Drive. Every process finds it only through `LIFEOS_DATA_ROOT`, set in `~/.zshrc`. There is no default path, and the app does not load `.env` (a stale `.env` could silently point at the wrong folder).
- **Backups** go to `LIFEOS_BACKUP_ROOT`, default `~/LifeOS-backups`: local to each Mac, outside Drive, not synced.
- **Startup guard.** The server and `scripts/reconcile-meetings.mts` refuse to start unless the data root holds `.lifeos/schema.md`. They exit non-zero with a message naming the path checked. A wrong or empty path (typo, Drive not mounted) can then never become a new, empty vault that later syncs over the real one. `pnpm dev` adds the marker to `.dev-data/`.
- **Worktree cleanup.** `scripts/prune-worktrees.mjs` runs at the end of each Claude Code session (project hook in `.claude/settings.json`). It removes a worktree under `.claude/worktrees` only when it has no uncommitted or untracked files, its commit is in an `origin/*` branch, and nothing in it changed for 2 hours. It never uses `--force` and never deletes branches; offline, it keeps everything. A session-start check warns above 10 worktrees. Agents must push before reporting back (AGENTS.md).
- **Data guard hook.** `scripts/hooks/data-guard.mjs` is a Claude Code `PreToolUse` hook, registered in each user's `~/.claude/settings.json`. It blocks file edits and shell writes inside the data folder outside `_inbox/`, enforcing ADR 0007 for agents that run on the user's Macs.

## Consequences

- A new Mac needs the three environment variables and the marker file before LifeOS starts (README, "Set up a Mac").
- The stable app's existing data root must contain `.lifeos/schema.md`, which the app itself never wrote before this ADR. It is created once by hand when moving to this layout.
- `.dev-data/` is no longer in Drive, so phone-based skill dry-runs need a Drive-visible test folder.
- The data guard is a guardrail for agents on these Macs, not a security boundary: cloud agents and other tools are not covered, and its shell analysis is heuristic.
