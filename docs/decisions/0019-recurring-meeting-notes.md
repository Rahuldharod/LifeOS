# ADR 0019: One note per recurring series, one meeting record per occurrence

- Status: Accepted
- Date: 2026-10-11
- Source: design-system feature grilling; amended spec #127
- Extends: ADR 0008 (Agent-first AI), ADR 0010 (Sensitivity), ADR 0013 (crash recovery), ADR 0018 (Review Item sensitivity)

## Context

A recurring Calendar series needs one continuous Note that puts the newest occurrence first while preserving the history below it. Collapsing the series into one Meeting record would lose occurrence-specific time, attendees, enrichment state, Sources, proposals and recovery identity; keeping one unrelated Note per occurrence would lose the continuous working document.

## Decision

LifeOS keeps one internal Meeting record per Calendar occurrence and links every occurrence in a recurrence series to one Recurring Meeting Note. The Note contains stable, independently addressable occurrence sections ordered newest first; opening an occurrence writes nothing, and its section becomes authoritative on the first user edit or when an explicit enrichment run finds material.

Calendar recurrence identity and the immutable original occurrence time identify the series and section. Rescheduling an occurrence retains its section. A Calendar “this and following” change creates a new series Note linked to the previous one rather than guessing continuity from the title.

Enrichment remains occurrence-scoped. Work Orders identify one occurrence section; the Agent reads only that section, and Sources, summaries, Review Items and enrichment state remain attached to the occurrence Meeting. LifeOS may maintain a generated Materials block in the section, but the Agent never edits the Note directly. Sensitivity applies to the entire shared Note and therefore to every linked occurrence.

## Consequences

- Series-note creation, section creation, migration and generated-block updates are replay-safe multi-file operations under ADR 0013.
- Existing per-occurrence Notes are never merged silently. A reviewed migration preserves their bodies, archives originals only after success and keeps old links resolvable to the matching new section.
- A restricted shared Note excludes the whole series from Agent Indexes and Work Orders.
- Calendar adapters must preserve series identity, occurrence identity, reschedules, cancellations and series splits rather than exposing only expanded event IDs.
