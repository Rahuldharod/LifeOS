# ADR 0021: One Note per recurring occurrence, shown together as a series

- Status: Accepted
- Date: 2026-10-12
- Source: user decision of 2026-10-12, after the Weekly Prio overwrite incident
- Supersedes: ADR 0019 (one shared Note per recurring series)
- Extends: ADR 0010 (Sensitivity), ADR 0013 (crash recovery)

## Context

ADR 0019 stored every occurrence of a recurring series as a section of one shared Note. In use, this made one week's edit able to destroy every other week: on 2026-10-12 a browser autosave right after a first edit replaced the whole shared body with the new week's text, and every section rendered empty. The shared body also needs section anchors, text slicing, merge-on-create and a reviewed migration of existing Notes, all of which are fragile.

Each occurrence already has its own Meeting record with the provider series identity, and enrichment is already occurrence-scoped.

## Decision

Each Calendar occurrence has its own Meeting and, after the first edit, its own Meeting Note file. Occurrences are linked by the Meeting's `recurrence_series_id`, not by sharing a Note.

- **Display.** Opening a recurring event in the Calendar shows that occurrence's Note plus the Notes of the 5 most recent earlier occurrences in the same series that have a Note, newest first, collapsed. "Earlier" is relative to the opened occurrence, not to today; a link says when newer occurrences exist. Older occurrences load on request. Opening writes nothing.
- **Series splits.** When the provider reports a previous series (a "this and following" change), the series view continues into it.
- **Cancelled occurrences** appear only when they have a Note, marked cancelled.
- **Notes tab.** Opening a Meeting Note from the Notes tab shows only that Note, with a link to its series view.
- **Editing.** Each displayed Note autosaves to its own file with its own expected-content-hash check and its own save status. Editing a past week never writes, pauses or blocks the current week's file, and the reverse. "Load older" adds 5 more occurrences at a time.
- **Deleting** a Note is offered only on that occurrence's own page, never in the series view.
- **First edit** of a new occurrence creates only that occurrence's Meeting and Note.
- **Sensitivity** applies to one Note only. Restricting one occurrence does not restrict the series; only that Note is withheld from Agent Indexes and Work Orders. The user still sees it in the series view, marked restricted.
- **No carry-forward.** A new occurrence's Note starts empty; it never copies text from an earlier one.
- **Series identity** still comes only from provider recurrence identity. Calendar sync keeps backfilling it on pre-upgrade Meetings by exact event reference; titles, attendees and times are never used to infer a series. Meetings whose provider event no longer exists stay unlinked; a manual link action is backlog, not part of this decision.

## Consequences

- No multi-Note migration is needed: pre-ADR-0019 per-occurrence Notes already have this shape.
- Notes already merged under ADR 0019 (for example Weekly Prio) stay as **legacy shared Notes**. They are not split. In the series view a legacy shared Note appears once, as one editable block labelled with the date range it covers, without per-occurrence sections. New occurrences of that series get their own Notes.
- The reviewed migration (#153), section anchors, section-aware editing, the Materials block inside a section, the series-wide sensitivity rule and section-targeted Work Orders are removed in the same change, not left dormant. Enrichment targets the occurrence's own Note; a legacy shared Note receives no further enrichment.
- Each write touches one Note, so the ADR 0013 multi-file pattern is no longer needed for recurring Note creation.
