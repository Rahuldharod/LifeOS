# LifeOS coding standards

Read during review, not implementation. The reviewer checks every rule below against the diff, plus the non-negotiable rules in `AGENTS.md`. Typecheck, lint, tests and the browser suite are enforced by the pre-push hook and CI; do not re-check them by hand.

A finding is **hard** (block the merge) or **soft** (note it and move on). Each rule says which.

## Decisions

- **Hard.** A diff that settles a lasting choice (a stored format, a sync or device boundary, a privacy rule, a new background job, a retention period) has an ADR in `docs/decisions/`, or the PR names the existing ADR it follows. A device-only value stored as a synced setting breaks ADR 0005.
- **Soft.** New domain terms appear in `CONTEXT.md`.

## Persistence and recovery

- **Hard.** A fix to a hash, revision or conflict path covers every caller, not just the one in the bug report. Check with a search for the function (`updateBody`, `expectedHash`, the conflict controller), and expect one test per editor path (notes, meeting notes, entity forms).
- **Hard.** Recovery code closes the operation before it writes the audit record, and replayed IDs come from the journal, not from a call counter. Use the ADR 0013 helpers.
- **Hard.** Store instants as ISO 8601 UTC. Keep the source timezone metadata; apply the user's timezone only for day boundaries and display.
- **Hard.** Managed image links stay relative in persisted Markdown, so the repository works on both devices.

## Secrets and privacy

- **Hard.** Status and list endpoints never call `SecretStore.get`; they report presence from metadata.
- **Hard.** Tests use the test secret store and temporary roots, never the real Keychain or data root.
- **Hard.** Restricted items stay restricted on every new path that copies or derives from them (Review Items, exports, briefs).

## Tests

- **Hard.** Tests that depend on today's date or on wall-clock speed use fixed dates or fake timers, not real time.
- **Hard.** A test failure called "flaky" either gets fixed in the diff or has a GitHub issue linked in the PR.
- **Soft.** Persistence, connector, recovery and cross-layer changes come with an integration test in `tests/integration`.

## Shape

- **Soft.** New routes, handlers and use cases register in their own module rather than growing `apps/web/src/main.tsx`, `apps/server/src/main.ts` or `packages/application/src/index.ts`; those files are merge-conflict hot spots.
- **Soft.** The diff matches the surrounding naming, comment density and idiom.
- **Soft.** No feature-by-feature documentation pages, and no docs restating what tests and code already show.
