# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one root `CONTEXT.md` glossary covers the whole system. The pnpm packages under `apps/` and `packages/` are architecture layers, not separate bounded contexts.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the domain glossary (Area, Belonging, Agent, Object Envelope, Review Item, Asset, …).
- **`docs/decisions/`**: this repo's ADRs (e.g. `0001-code-data-separation.md`). Read the ones that touch the area you're about to work in. Wherever a skill refers to `docs/adr/`, use `docs/decisions/` instead.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/decisions/
│   ├── 0001-code-data-separation.md
│   └── 0002-human-readable-object-filenames.md
├── apps/
└── packages/
```

New ADRs continue the existing numbering in `docs/decisions/` (`NNNN-kebab-case-title.md`).

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids (e.g. say **Belonging**, not "asset" or "possession"; **Review Item**, not "suggestion").

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (advisory device lease), but worth reopening because…_
