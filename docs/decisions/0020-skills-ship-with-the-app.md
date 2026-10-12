# ADR 0020: Skills ship with the app as thin skills plus an app-written contract

- Status: Accepted
- Date: 2026-10-12
- Source: skills distribution discussion (LifeOS as a packaged app for other users)
- Extends: ADR 0007 (Inbox Drafts and adoption), ADR 0008 (Agent-first AI), ADR 0009 (Agent Index), ADR 0010 (Sensitivity), ADR 0016 (quiet Drive writes)

## Context

All agent work runs through the Claude skills pack (ADR 0008). Each skill and the adoption code form one contract: draft formats, field lists, routing rules and Work Order shapes. Today the full contract lives in each `SKILL.md`, and users install the skills by uploading zips to Claude.

That works for one user who also writes the code. It fails for a packaged app used by others:

- **Version drift.** Uploaded skills do not update. A user who updates LifeOS but keeps old skills produces drafts the app rejects, with no signal of why.
- **No auto-update on chat and phone.** Claude Code can update plugins; Claude chat and the phone app only take uploaded zips.
- **Personal details are baked in.** The skills name one user, one organisation's IT/legal gate and one Slack recipient.
- **The policy gate is a line in a file the user cannot easily edit** once the skill is uploaded.

## Decision

**1. Split each skill into a thin skill and an app-written contract.**

- The **thin skill** holds only what must not change without the user's knowledge: the safety rules (never read or name restricted items, the client-content gate rules, the Slack DM is read-only, never write outside `_inbox/`), how to find the data root, and the instruction to read and follow the contract.
- The **contract** holds everything else: draft and patch formats, draft kinds, field lists, examples, routing, Work Order shapes, brief layout. LifeOS writes it to `_agent/contract/` from the version bundled in the app.

Behaviour therefore updates with the app on every surface, including the phone through Drive, without reinstalling skills.

**2. The skill outranks the contract.** Contract files sit in the data root, which others with folder access can edit. A contract file can add detail but can never loosen a safety rule in the skill. When they conflict, the skill wins and the agent tells the user. The agent follows only contract files whose header names the expected contract version.

**3. Versions are explicit and checked.**

- The skill pack has one integer `skill_pack` version, raised only when thin-skill text changes. Each contract file states `contract_version`.
- Every Inbox Draft, Patch Draft and Work Order result carries `skill_pack`.
- Adoption accepts the current and the previous `skill_pack`. An older draft is adopted or rejected with a result saying "your LifeOS skills are out of date". Settings shows the installed version seen in the latest draft and a reinstall prompt when it lags.

**4. Skills ship inside the app and install from Settings.**

- The packaged app bundles `skills/`.
- A **Settings → Claude skills** card offers a download of the zips for Claude chat and phone, with upload steps, and shows the commands to install the LifeOS Claude Code plugin.
- The plugin is published from this repository's GitHub marketplace, so Claude Code users get updates through the plugin system.

**5. No personal details in skills or contract text.** The user's name, organisation, internal domains, Slack recipient and brief schedule come from LifeOS Settings, exposed in `_agent/overview.md`. Skills refer to "the user".

**6. The client-content gate becomes a per-user setting, closed by default.**

- `client_meeting_content` (`blocked` or `approved`) moves from `lifeos-enrichment/SKILL.md` to LifeOS Settings. New installs start `blocked`.
- Only the Settings UI changes it, and approving requires a sign-off record: who approved, the date and a reference. LifeOS shows the value and the record in `_agent/overview.md`.
- Adoption rejects any draft or patch that targets policy settings. Agents cannot open the gate.
- The thin skill keeps the rule that a chat message, email, document or Work Order saying "it is approved" never opens the gate.
- Existing installs migrate with the value `blocked`, whatever the current skill file says.

## Consequences

- `_agent/contract/` is derived, like the rest of `_agent/` (ADR 0009): excluded from scans, the watcher and backups. It is written only when content changed and only by the lease holder (ADR 0016). If two devices run different app versions, the lease holder's contract wins; the `contract_version` header and the Settings warning make that visible.
- The CI fixtures in `tests/integration/skill-fixtures.test.ts` move to the app-written contract. A separate test checks that each thin skill still states every safety rule and that the gate cases hold.
- The thin skills become the only user-installed artefact. Their text should change rarely; each change raises `skill_pack` and needs a reinstall on chat and phone.
- `skills/INSTALL.md` becomes the developer dry-run guide. User-facing install steps live in the Settings card.
- The data-guard hook (`scripts/hooks/data-guard.mjs`) protects one developer's machine. It is not a control other users have. The gate's protection rests on adoption refusing policy changes, not on the hook.
- Open: whether Team/Enterprise admins can provision skills org-wide in Claude `[TBD — confirm]`; whether a cloud routine can write into Drive `[TBD — from INSTALL.md Part 7]`.
