# ADR 0011: Daily Focus is agent-owned; Focus Overrides are app-owned

- Status: Accepted
- Date: 2026-10-04
- Source: Phase A PRD (spec #21)
- Supersedes: the map #1 idea that the app computes the daily plan itself with an in-app model.

The morning routine (a Claude agent) writes the **Daily Focus** brief as a `daily-focus` Inbox Draft; adoption files it as a `daily-focus` object. A newer brief for the same date archives the older one in place. The application never edits a brief.

The user's changes to the Top 3 (pin, replace, dismiss) are stored in a separate app-owned **Focus Override** object, one per date. The effective Top 3 is the brief's Top 3 with the override applied. With no brief, the deterministic rule (priority, then due date) applies.

Why: each object has exactly one writer, so a re-generated brief never wipes the user's choices, and the user's choices never fight the agent's file.

Today shows the brief with live status overlaid from the index (finished tasks struck through, past meetings marked). "Refresh" writes a `replan` Work Order; it does not regenerate the brief in the app.
