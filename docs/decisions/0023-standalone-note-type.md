# ADR 0023: Standalone Note is a third note type

- Status: Accepted
- Date: 2026-10-14
- Source: user decision of 2026-10-14, grilling PB-034 (create a note without a meeting)
- Related: ADR 0002 (file names), ADR 0010 (Sensitivity), ADR 0021 (one Note per recurring occurrence)

## Context

Notes can only be created from a Calendar event (`meeting-note`, needs `meeting_id`) or adopted from the Inbox or Review (`knowledge-note`, needs at least one `source_ids`). The user needs notes with no meeting: thinking notes on a project or client, and calls that never reached the calendar.

Alternatives:

- Make `source_ids` optional on `knowledge-note`. Rejected: a Knowledge note means "distilled from a Source"; dropping that blurs the term and the filters built on it.
- Allow `meeting-note` without `meeting_id`. Rejected: breaks the glossary meaning of Meeting Note and every rule that joins a Meeting Note to its Meeting record (restricted meeting, enrichment, series view).
- Create a placeholder Meeting record. Rejected: fake meetings would appear in calendar and enrichment flows.

## Decision

- **Type.** A new note type `standalone-note` ("Standalone Note"): no `meeting_id`, no required Source. It carries the same context fields as a Meeting Note: `primary_project_id`, `primary_client_id`, `primary_product_id`, `people_ids`, plus envelope `sensitivity`. Origin is `app`.
- **Place.** Files go in `notes/` with the usual name `YYYY-MM-DD-HHMM-<slug(title)>--<id>.md` (ADR 0002).
- **Creation.** A "New note" button on the Notes tab opens the editor with the full header. Header changes are held until the first real edit, which writes the file and then applies them, the same pattern as a Calendar event's first edit. An abandoned "New note" writes nothing.
- **Title.** Auto-filled as `Note <date time>` and renamable; the file name does not change on rename.
- **Agents.** Standalone Notes appear in the Agent Index like other notes; restricted ones are left out. Skills cannot create them yet (backlog Inbox idea).
- **No conversion.** A Standalone Note never becomes a Meeting Note.

## Consequences

- The schema, index, Notes list, search and Agent Index must accept a third note type; existing files are untouched.
- Code that assumes "note = meeting-note or knowledge-note" must be checked when building.
- Adding Agent creation later needs a new Inbox Draft kind and contract change, not a schema change.
