# LifeOS agent instructions

This file is the repository-level operating guide for coding agents. Keep it tool-neutral and update it only when repository boundaries, required commands, or non-obvious engineering rules change.

## Start here

Read these sources in order, loading only what the task needs:

1. `README.md` for setup, repository layout, and connection prerequisites.
2. `docs/product-design/LifeOS_Solution_Design_v0.8.md` for the current product and solution baseline, and `docs/product-design/LifeOS_PRD_Phase-A_v1.0.md` (spec issue #21) for the Phase A build, its build status, build decisions and known gaps. v0.4, v0.6 and v0.7 are kept for history only.
3. `docs/architecture/README.md` for system boundaries and current architecture.
4. The relevant file in `docs/decisions/` for decisions that must not be silently reversed.
5. `docs/architecture/mvp-gap-analysis.md` for the original MVP audit and remaining deferred scope.
6. `docs/product-design/Product Backlog.md` for improvement ideas and prioritization.

There is intentionally no standalone user guide during the MVP. The interface and workflows are changing too quickly to justify maintaining one.

## Repository map

- `apps/web`: React and Vite UI.
- `apps/server`: localhost Fastify API and composition root.
- `packages/domain`: domain types, validation, and identity generation.
- `packages/application`: use cases and adapter ports. Business orchestration belongs here.
- `packages/object-store-markdown`: authoritative Markdown persistence and filesystem reconciliation.
- `packages/index-memory`: disposable, rebuildable index.
- `packages/connectors`: Google Calendar and mock connector adapters.
- `packages/ai`: deterministic mock AI boundary.
- `packages/assets-filesystem`: managed local images and duplicate detection.
- `packages/backup-filesystem`: versioned, checksummed snapshots.
- `packages/secrets`: macOS Keychain and test secret stores.
- `packages/contracts`: API request and response types.
- `packages/shared`: rules both the server and the browser need (no Node dependencies).
- `schemas`: portable schemas and fixtures.
- `skills`: the Claude skills pack (`lifeos-object-contract`, `lifeos-capture`, `lifeos-ask`, `lifeos-enrichment`, `lifeos-morning`) and `INSTALL.md` (install and dry-run steps for the user). Every example draft, patch, brief and gate case in it is a CI fixture (`tests/integration/skill-fixtures.test.ts`, run by plain `pnpm test`); change skill text and adoption code together. Never open the enrichment skill's client-content gate: only the user does that, with the IT/legal sign-off record.
- `tests/integration`: cross-package acceptance tests.
- `docs/product-design`: versioned solution baseline and product backlog.
- `scripts/hooks/data-guard.mjs`: Claude Code hook that blocks agent writes to the data root outside `_inbox/` (registered per user, see README).
- Data root (`LIFEOS_DATA_ROOT`): real user Markdown and assets in Google Drive; outside Git and authoritative. Code lives in `~/Developer/LifeOS`, never in Drive (ADR 0014).
- Backup root (`LIFEOS_BACKUP_ROOT`, default `~/LifeOS-backups`): generated data snapshots, local to each Mac; outside Git.

## Non-negotiable rules

- Markdown files under the data root (`LIFEOS_DATA_ROOT`) are the source of truth. Browser caches and the in-memory index are derived and disposable.
- Keep code, real user data, secrets, logs, and backups out of the same Git history.
- Never place OAuth credentials or tokens in Markdown, source files, fixtures, logs, or commits. Use the `SecretStore` boundary. Status endpoints must not read secret values (each read can show a Keychain prompt).
- Never put real email addresses or company domains in code, tests or docs. Use `example.com` style data; the user's own values live in the Settings cards.
- Write domain objects through application use cases and `ObjectStore`; do not bypass revision and expected-content-hash checks.
- Preserve unknown Markdown frontmatter and body content during round trips.
- External workflows must be idempotent. Meeting creation, review acceptance, and recovery must tolerate retries. Any step that writes more than one file follows the crash-recovery pattern in ADR 0013 and its helpers; do not hand-write another.
- Store instants as ISO 8601 UTC. Preserve source timezone metadata and apply the user-selected timezone only when querying day boundaries or displaying values.
- Managed image links must remain relative in persisted Markdown so the repository works on both devices.
- While developing, do not read or write the real data root, and never edit its files to make a test pass. Tests use temporary roots and synthetic records; manual checks use `.dev-data/`.
- Treat the advisory device lease as a guardrail, not the sole concurrency control. Background work that writes objects runs only while this device holds the lease (`holdsLease()`); after an idle release nothing reclaims it except the user's Take back (ADR 0015).
- The server and maintenance scripts refuse to start unless the data root holds `.lifeos/schema.md` (ADR 0014). Do not add a default data path.

## Commands

Use Corepack because a global `pnpm` installation is not assumed:

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm typecheck
corepack pnpm test --exclude '.claude/**'   # skip test copies inside agent worktrees
corepack pnpm build
```

Two separate runtimes (ADR 0006):

- **Development** (`pnpm dev`): UI `http://127.0.0.1:5174`, API `http://127.0.0.1:4311`, synthetic data in `.dev-data/`, mock calendar. Use this for all coding and manual testing.
- **Stable app** (the user's daily LifeOS): `http://127.0.0.1:4310`, real data from `LIFEOS_DATA_ROOT`, managed with `pnpm start | stop | status | update-app` (see README). Never stop, restart or update it without asking the user; they may be mid-note. Never kill processes by name pattern: the stable server's command line looks like dev's.

One-off maintenance: `pnpm reconcile-meetings` reports duplicate meetings; `--apply` (only with the user's OK, and with the stable app stopped) backs up, then archives extras.

## Change workflow

1. Inspect the relevant port, use case, adapter, schema, and integration test before editing.
2. Make the smallest change that preserves the architecture boundaries above.
3. Add or update an integration test for persistence, connector, recovery, or cross-layer behavior.
4. Run typecheck and the relevant tests; run the production build for UI, server, dependency, or bundling changes.
5. Update documentation only when its stated contract changes:
   - setup or top-level capabilities: `README.md`;
   - boundaries or component responsibilities: architecture README;
   - durable architectural decision: a new ADR;
   - ideas and prioritization: `docs/product-design/Product Backlog.md`;
   - the draft, patch or Work Order contract: the matching `skills/*/SKILL.md` (its examples are tests).

## Worktree lifecycle

Agent worktrees live under `.claude/worktrees/` (ignored by Git) and are temporary (ADR 0014).

- An agent working in a worktree must **commit and push its branch before reporting back**. Nothing may exist only inside a worktree.
- Cleanup is automatic: the project hook in `.claude/settings.json` runs `node scripts/prune-worktrees.mjs --apply --quiet` at session end. It removes a worktree only when it has no uncommitted or untracked files, its commit is on GitHub, and nothing in it changed for 2 hours. It never uses `--force` and never deletes branches.
- `corepack pnpm worktrees:prune` shows what would be removed (dry run); add `--apply` to remove. At session start the hook warns when there are more than 10.

Do not create feature-by-feature documentation pages or duplicate implementation details that are already clear from tests and code.

## Definition of done

- The requested behavior works through the real application boundary, not only in an isolated component.
- Existing Markdown remains readable and round-trippable.
- Failure and retry behavior is explicit for filesystem and external-service operations.
- Typecheck and relevant integration tests pass.
- The production build passes when runtime code changed.
- No real data, generated backups, or secrets appear in the Git diff.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `Rahuldharod/LifeOS`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` glossary plus ADRs in `docs/decisions/`. See `docs/agents/domain.md`.
