# ADR 0008: Agent-first AI; the in-app LLM provider is deferred

- Status: Accepted
- Date: 2026-10-04
- Source: Phase A PRD (spec #21)
- Supersedes: the map #1 charting decision to build an in-app Claude API provider (#5) in Phase A.

All AI work in Phase A (meeting enrichment, extraction, the morning brief, chat answers) is done by Claude through skills, using the user's own subscription and connectors (Calendar, Drive, Gmail, Gong, Slack). LifeOS does not call an LLM.

The `AiProvider` port stays, backed by the deterministic mock for tests. When an in-app provider returns, it plugs in there, and the cost research (#2) is the reference.

Why: the user already pays for Claude and has the connectors that hold the material (transcripts, recordings, Gong). Building API-key setup, prompt management and cost controls in the app would duplicate that for no gain in Phase A.

Consequence: LifeOS asks for agent work by writing **Work Orders** to `_inbox/requests/`, and receives results as Inbox Drafts (ADR 0007).
