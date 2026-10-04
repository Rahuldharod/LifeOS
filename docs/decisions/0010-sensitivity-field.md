# ADR 0010: `sensitivity` on the Object Envelope

- Status: Accepted
- Date: 2026-10-04
- Source: Phase A PRD (spec #21)
- Supersedes: nothing in map #1; it is new. It replaces the implicit assumption that every object may be shared with Agents.

Every object may carry `sensitivity: normal | restricted`. Missing means `normal`.

Restricted objects are excluded from the Agent Index (counted only), from Daily Focus inputs, from Work Orders and from Slack, and the interface shows a lock badge.

This is a policy instruction, not a technical lock: the files sit in the same Drive-synced folder and skills are told not to read them. The PRD states this limitation openly. Categories that need real protection (finance, health) are linked out of LifeOS, not run inside it.

The same envelope change adds `origin` (`app | user-dictated | agent-extracted | calendar | imported | external`, missing means `app`, set once and never changed) and validates `area` against the six agreed values (legacy values warn in System Health instead of failing).
