---
lifeos_contract: 1
contract_version: 1
---

# LifeOS contract: enrichment

The Work Order, where material is found, how to compare it with the note, and the `meeting-material` draft, for the **lifeos-enrichment** skill. The policy gate and the skip rules stay in the skill and always win.

## The Work Order

A Markdown file in `_inbox/requests/`. Its front matter:

| Field | Meaning |
| --- | --- |
| `lifeos_work_order` | contract version, `1` |
| `kind` | `enrichment` |
| `work_order_id` | the Work Order's ID |
| `requested_at` | when the user pressed the button |
| `window_start`, `window_end` | the 48-hour window searched |
| `meetings` | one entry per meeting, below |

Each entry in `meetings`:

| Field | Meaning |
| --- | --- |
| `meeting_id` | the LifeOS meeting ID; absent when LifeOS has no meeting yet |
| `calendar_event_id` | the Google Calendar event ID; always there |
| `calendar_id` | the calendar the event is on |
| `title`, `starts_at`, `ends_at`, `timezone` | the event |
| `attendee_emails` | attendees' addresses (restricted people are left out) |
| `note_path` | The user's meeting note, relative to the data root; absent when they wrote none |
| `existing_sources` | material already linked: `id`, `source_type`, `path`, `url`, `external_id` |
| `missing_material` | what is still missing; fetch only these |
| `recurrence_occurrence_id` | immutable provider occurrence identity; present for a recurring occurrence. The entry is that occurrence's own Meeting and `note_path` Note: every occurrence has its own |
| `optional_material` | optional linked material such as `drive-doc`; its absence never leaves Enrichment Partial |

Restricted meetings are never in a Work Order. A meeting inside a Legacy shared Note (an older Note that several occurrences share) gets no new Work Order entry, and LifeOS never writes into that Note. A draft for such a meeting that is already in flight is still adopted, onto the meeting only.

## Where the material is

Fetch what `missing_material` lists, plus linked material named in `optional_material`. Match material to the meeting by calendar event, time and attendees, never by title alone.

| Kind | Where | `external_id` | `url` |
| --- | --- | --- | --- |
| `meet-transcript` | The calendar event's attachments (Google Calendar), else Google Drive: the Google Doc named after the meeting with "Transcript" | Drive file ID | the Doc link |
| `meet-recording` | The calendar event's attachments, else the "Meet Recordings" folder in Google Drive | Drive file ID | the video link |
| `gong-call` | The **Gong connector**: the call at the meeting's time with the same attendees. Use its transcript and brief | Gong call ID | the Gong call link |
| `gong-summary-email` | **Gmail**: the Gong summary email for that call, sent after the meeting | Gmail message ID | the message link |
| `drive-doc` | Optional extra listed in `optional_material`: a Drive doc attached to the event, such as Gemini notes or slides | Drive file ID | the Doc link |

When a kind does not exist, say so with `unavailable`:

- **List it as unavailable only when you looked in the right place and it is not there.** For example: the meeting was not recorded, or Gong has no call at that time.
- **Do not list it when you could not look.** A connector that is not connected, an access error or a timeout means "missing". Leave it out of both `sources` and `unavailable`. LifeOS keeps the meeting `partial` and asks again next time.
- A kind can never be in both `sources` and `unavailable`.

## Compare with the note

Every proposal needs `missed_in_notes`: did the user's notes for this occurrence already capture it?

1. Read front matter first. If it is restricted, stop. Read only the Note at the entry's `note_path`: for a recurring occurrence it is that occurrence's own Note, so never open another occurrence's Note. With no `note_path`, read nothing and treat the occurrence as having no user notes.
2. For each task, decision or open point you found in the material:
   - `missed_in_notes: false` when the note already says the same thing, even in other words or another language.
   - `missed_in_notes: true` when the note does not mention it, or only part of it (for example the task but not its owner or date).
   - `missed_in_notes: true` when there is no `note_path`.
   - When unsure, use `true`. The user would rather check one extra item than miss one.
3. Propose only real tasks, decisions and open points. Not small talk, not things already done in the meeting.

## The draft

One `meeting-material` Inbox Draft per meeting, in `_inbox/drafts/`. File name `YYYY-MM-DD-HHMM-enrich-short-slug.md`.

| Field | Value |
| --- | --- |
| `lifeos_draft` | `1` |
| `skill_pack` | `1` |
| `kind` | `meeting-material` |
| `draft_key` | `enrich-` plus the `calendar_event_id`, plus the date and time of this run |
| `origin` | `agent-extracted` (always) |
| `title` | `Material for` and the meeting title |
| `captured_at` | when you fetched the material, with an offset |
| `meeting` | the entry's `calendar_event_id` (or `meeting_id`) |
| `calendar_id` | the entry's `calendar_id`, when there is one |
| `recurrence_occurrence_id` | copy exactly from the Work Order for a recurring occurrence |
| `sources` | the material you found: `source_type`, `url`, `external_id`, `occurred_at`, and optional `title`, `provider`, `retrieved_at` and `provider_revision`; LifeOS defaults `retrieved_at` to `captured_at` |
| `unavailable` | kinds you checked and found do not exist |
| `summary_confidence` | `High`, `Medium` or `Low` |
| `summary_evidence` | for a recurring summary, at least one `{ source, locator, quote? }`; the source must be linked to this occurrence and the locator is its timestamp, page or other position |
| `proposals` | tasks, decisions and open points, below |
| body | the proposed meeting summary, in the meeting's language |

Each proposal:

| Field | Value |
| --- | --- |
| `kind` | `task`, `decision` or `open-point` |
| `title` | in the meeting's language |
| `confidence` | `High`, `Medium` or `Low` |
| `missed_in_notes` | `true` or `false` (see above) |
| `evidence` | at least one `{ field, source, locator, quote }`. For a recurring occurrence, the source must be linked to that occurrence and the locator is the timestamp or page. `quote` is the exact words |
| optional | `key` (a stable name, so a re-run is recognised), `body`, and task fields such as `due_on`, `owner`, `people`, `status`, `waiting_for` |

Do not put `meeting`, `origin`, `draft_key` or `operation_id` on a proposal. People default to the meeting's attendees.

Re-runs are safe. LifeOS verifies the occurrence identity before writing, recognises Sources by provider and external ID, and recognises proposals by `key`, so nothing is added twice. One Source may be linked to several occurrences without being copied. LifeOS writes Sources, the summary and proposals to the occurrence's own Meeting only, never into a Note, so you never write or expect a Materials block. A draft from an older Work Order that still has `occurrence_section_id` is accepted and the field is ignored; do not write it in new drafts.

## Examples

Every example is tested against the real LifeOS adoption code. The comment above each one says what LifeOS does with it.

All material found for a meeting with no note yet. LifeOS creates the meeting, links 4 sources and sets it `enriched`:

<!-- fixture: {"name": "enrichment-all-material", "folder": "drafts", "vault": "meetings", "outcome": "adopted", "creates": ["meeting", "source", "source", "source", "source", "review-item", "review-item"], "fields": {"type": "meeting", "title": "Pilot review"}, "meeting": {"enrichment_state": "enriched", "enrichment_missing_material": []}, "proposals": [{"target_object_type": "task", "missed_in_notes": true, "confidence_label": "High"}]} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: meeting-material
draft_key: enrich-evt-example-pilot-review-2026-10-04-0830
origin: agent-extracted
title: Material for Pilot review
captured_at: 2026-10-04T08:30:00+02:00
meeting: evt-example-pilot-review
calendar_id: work
summary_confidence: High
sources:
  - source_type: meet-transcript
    url: https://drive.example.com/docs/transcript-pilot-review
    external_id: drive-file-transcript-pilot-review
    occurred_at: 2026-10-03T14:00:00+02:00
  - source_type: meet-recording
    url: https://drive.example.com/videos/recording-pilot-review
    external_id: drive-file-recording-pilot-review
    occurred_at: 2026-10-03T14:00:00+02:00
  - source_type: gong-call
    url: https://gong.example.com/call/7781
    external_id: gong-call-7781
    occurred_at: 2026-10-03T14:00:00+02:00
  - source_type: gong-summary-email
    url: https://mail.example.com/message/gong-summary-7781
    external_id: gmail-message-gong-summary-7781
    occurred_at: 2026-10-03T15:10:00+02:00
proposals:
  - kind: task
    key: pilot-store-list
    title: Send Joel the pilot store list
    confidence: High
    missed_in_notes: true
    due_on: 2026-10-07
    evidence:
      - field: title
        source: https://drive.example.com/docs/transcript-pilot-review
        locator: "00:18:40"
        quote: "Can you send me the store list by Tuesday?"
---
Joel reviewed the first pilot week. Redemption is ahead of plan in the Lyon stores. The user owes Joel the pilot store list by Tuesday.
```

A meeting with the user's note. Only the transcript exists so far; the meeting was not recorded. The launch date is already in their note, the coupon cap is not. LifeOS sets the meeting `partial` because Gong is still missing:

<!-- fixture: {"name": "enrichment-partial-with-note", "folder": "drafts", "vault": "meetings", "outcome": "adopted", "creates": ["source", "review-item", "review-item", "review-item"], "fields": {"type": "source", "source_type": "meet-transcript"}, "meeting": {"enrichment_state": "partial", "enrichment_missing_material": ["gong-call", "gong-summary-email"], "enrichment_unavailable_material": ["meet-recording"]}, "proposals": [{"target_object_type": "decision", "missed_in_notes": false}, {"target_object_type": "open-point", "missed_in_notes": true}]} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: meeting-material
draft_key: enrich-evt-example-steering-2026-10-04-0840
origin: agent-extracted
title: Material for Spring promo steering
captured_at: 2026-10-04T08:40:00+02:00
meeting: evt-example-steering
summary_confidence: Medium
sources:
  - source_type: meet-transcript
    url: https://drive.example.com/docs/transcript-steering
    external_id: drive-file-transcript-steering
    occurred_at: 2026-10-02T10:00:00+02:00
unavailable: [meet-recording]
proposals:
  - kind: decision
    key: launch-date
    title: Spring promo launches on 3 March
    confidence: High
    missed_in_notes: false
    decision_text: The spring promo launches on 3 March.
    evidence:
      - field: title
        source: https://drive.example.com/docs/transcript-steering
        locator: "00:04:10"
        quote: "So we lock the third of March for the launch."
  - kind: open-point
    key: coupon-cap
    title: Do we cap digital coupons per shopper?
    confidence: Medium
    missed_in_notes: true
    evidence:
      - field: title
        source: https://drive.example.com/docs/transcript-steering
        locator: "00:27:55"
        quote: "We still need to decide whether there is a cap per shopper."
---
The team confirmed the 3 March launch. The coupon cap per shopper is still open.
```

Nothing exists: you checked every place and found no material. Listing it all as `unavailable` sets the meeting `enriched`, so LifeOS stops asking:

<!-- fixture: {"name": "enrichment-nothing-exists", "folder": "drafts", "vault": "meetings", "outcome": "adopted", "creates": [], "meeting": {"enrichment_state": "enriched", "enrichment_unavailable_material": ["meet-transcript", "meet-recording", "gong-call", "gong-summary-email"]}, "proposals": []} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: meeting-material
draft_key: enrich-evt-example-steering-2026-10-04-0850
origin: agent-extracted
title: Material for Spring promo steering
captured_at: 2026-10-04T08:50:00+02:00
meeting: evt-example-steering
unavailable: [meet-transcript, meet-recording, gong-call, gong-summary-email]
---
```

Refused: every proposal must say whether the note already covers it.

<!-- fixture: {"name": "enrichment-failed-no-missed-flag", "folder": "drafts", "vault": "meetings", "outcome": "failed", "error": "missed_in_notes: missing"} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: meeting-material
draft_key: enrich-evt-example-pilot-review-2026-10-04-0900
origin: agent-extracted
title: Material for Pilot review
captured_at: 2026-10-04T09:00:00+02:00
meeting: evt-example-pilot-review
proposals:
  - kind: task
    title: Send Joel the pilot store list
    confidence: High
    evidence:
      - source: https://drive.example.com/docs/transcript-pilot-review
        locator: "00:18:40"
---
```

Refused: the meeting's note is restricted. LifeOS never enriches a restricted meeting. You should have skipped it before fetching anything:

<!-- fixture: {"name": "enrichment-failed-restricted", "folder": "drafts", "vault": "meetings", "outcome": "failed", "error": "is restricted"} -->
```markdown
---
lifeos_draft: 1
skill_pack: 1
kind: meeting-material
draft_key: enrich-evt-example-one-to-one-2026-10-04-0910
origin: agent-extracted
title: Material for One-to-one with Joel
captured_at: 2026-10-04T09:10:00+02:00
meeting: evt-example-one-to-one
unavailable: [gong-call]
---
```
