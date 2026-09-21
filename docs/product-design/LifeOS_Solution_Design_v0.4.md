# LifeOS

*Personal Knowledge & Work Management System*

*Solution Design Document*

> **Purpose**
> A practical design baseline for building a personal operating system that connects calendar events, meeting notes, decisions, open questions, tasks, projects, products, clients and people - while remaining portable, traceable and compatible with Obsidian.

| **Version** | 0.4 |
| --- | --- |
| **Date** | 20 September 2026 |
| **Status** | Living design baseline - updated for a Markdown-first, database-free backend |
| **Primary use** | Guide implementation decisions, scope the MVP, and serve as the versioned source of truth for future design changes |
| **Code repository** | [Rahuldharod/LifeOS](https://github.com/Rahuldharod/LifeOS) (`git@github.com:Rahuldharod/LifeOS.git`) |
| **Revision summary** | Replaces SQLite as the authoritative store with one Markdown file per domain object, adds a database-free in-memory indexing model, defines Google Drive synchronization and two-computer handoff safeguards, retains modular application/data-layer boundaries, records the provisional Tiptap decision, and identifies the canonical GitHub repository. |

### Revision note: v0.4

Version 0.4 intentionally supersedes the SQLite-first persistence decisions in v0.3. `LifeOS_Backend_Schema_v0.1.sql` remains a historical design artifact and a useful catalogue of fields and constraints, but it is no longer the executable backend baseline. The corresponding requirements are translated in this document into Markdown front-matter contracts, validation rules, indexes and repeatable file operations.

## Design intent

The system should reduce the effort required to capture, classify and rediscover information. The user captures naturally; the system infers context, proposes structure, preserves provenance, and resurfaces the right information at the right time.

## 00   Document map

This document consolidates the agreed design and the recommendations that emerged from the design discussion. Items marked as baseline are treated as current decisions; items marked proposed remain open to refinement.

Versioning rule: this document is the living design source of truth. Any future decision that changes the agreed design should be reflected here and the document version incremented.

| **Section** | **Topic** | **Purpose** |
| --- | --- | --- |
| 01 | Vision & goals | What the system is intended to achieve |
| 02 | Design principles | Rules that keep the solution coherent as it grows |
| 03 | Information model | Core entities, definitions and relationships |
| 04 | User workflows | Meeting, AI processing, tasks and voice capture |
| 05 | Workspaces & navigation | Home, calendar, tasks, projects and context pages |
| 06 | PARA, Zettelkasten & Obsidian | How established PKM methods fit into the system |
| 07 | Storage & architecture | Markdown object store, assets, synchronization and future migration path |
| 08 | MVP & roadmap | What to build first and what to defer |
| 09 | Decisions, risks & open questions | What is settled and what remains to decide |
| 10 | Backend implementation baseline | Markdown object contracts, file operations, application layers, secrets and repository boundaries |
| 11 | Appendix | Reference object examples and end-to-end traces |

> **Core idea**
> LifeOS is not a folder system and not only a note-taking app. It is a connected information system in which notes remain human-readable, structured objects remain queryable, and the same underlying information can be viewed through different lenses.

## 01   Vision & goals

### 1.1 Vision

Create a personal operating system that connects knowledge, meetings, calendar, tasks and context across professional and personal life. The system should make it easy to capture information in the moment and later transform that information into structured, actionable and traceable knowledge.

### 1.2 Primary outcomes

- Start the day with a clear view of what matters now: overdue work, due-today tasks, high-priority upcoming work, waiting items and relevant meetings.
- Move from a calendar event to a meeting workspace in one click, with a pre-populated note and all available context.
- Capture meeting notes freely without having to classify every sentence while the conversation is happening.
- Use AI after the meeting to combine personal notes with transcripts, recordings and linked material, then propose a summary, decisions, actions and open points.
- Turn confirmed actions into tasks that remain linked to their original meeting, project, client, product and people.
- Retain a durable history of decisions and open questions without rereading full meeting notes.
- Support both professional and personal contexts using the same underlying model.
- Keep knowledge portable and readable outside the application, including through Obsidian.

### 1.3 Scope boundary

The initial design focuses on two connected loops: (1) calendar -> meeting -> structured outputs -> task/dashboard, and (2) source -> raw capture -> knowledge synthesis -> linked knowledge. Email and Slack remain target sources but are deferred until the core meeting/task loop is reliable. Knowledge Notes and source ingestion are part of the target model from the start, while more autonomous maintenance can be phased in later.

### 1.4 What the system is not

- Not a replacement for every source application. Calendar, email and Slack remain source systems; LifeOS extracts and organizes what deserves attention.
- Not a hierarchy of folders that encodes relationships. Relationships are represented explicitly through IDs and links.
- Not an AI black box that silently invents commitments or rewrites meaning. AI may automatically enrich context, but AI-generated commitments and destructive or meaning-changing knowledge edits require user confirmation.
- Not a full-featured Word/Notion-style editor. The editing requirement is intentionally restrained: headings, bullets, bold, italic, underline and embedded assets.

## 02   Design principles

| **Principle** | **Design implication** |
| --- | --- |
| Capture first, classify later | During meetings or quick capture, minimize friction. Classification and structuring should happen through context inheritance and AI-assisted post-processing. |
| Link, do not file | A task, decision or note should exist once and be linked to projects, clients, products, people and sources. Views filter the same object rather than creating copies. |
| Inherit context by default | Items created from a meeting inherit the meeting's project, client, product and relevant people. Voice or manual capture should infer context where possible and ask for review only when uncertain. |
| Provenance is first-class | Every AI-extracted item should retain a source reference so the user can trace why a task or decision exists. |
| AI enriches; the user confirms commitments | AI may automatically add links, provenance and context where evidence is strong. Tasks, decisions, deadlines, ownership changes, closures and meaning-changing edits require confirmation. |

### 2.1 Design principles (continued)

| **Principle** | **Design implication** |
| --- | --- |
| One object, many views | A task can appear in Today, a project page, a client page, a person page and Waiting On without duplication. |
| Portable knowledge | Narrative content should remain accessible as Markdown and assets so it can be read with Obsidian or other tools. Preserve original sources separately from synthesized Knowledge Notes so distilled knowledge remains traceable to evidence. |
| Local-first, multi-device-ready | Store authoritative user data as portable Markdown and assets that can be synchronized between the user's computers. Preserve ports and stable IDs so a hosted database can be introduced later without redesigning the domain model. |
| Calm dashboard | Surface actionable information, not raw inbox counts. The home screen should reduce cognitive load rather than reproduce external noise. |
| Separate code, data and secrets | Git versions application code, schemas, tests and documentation. User Markdown, assets, logs and local runtime state live outside the repository. Credentials live in the operating-system secret store and are referenced indirectly. |
| Proposals are not facts | AI suggestions remain in a review queue until accepted. Only accepted proposals create or modify authoritative domain records. |
| Evidence is addressable | Provenance should identify both the source and, where possible, the supporting page, timestamp, paragraph, message or character range. |

> **Important architectural guardrail**
> PARA should be a navigation and organization lens on top of the data model - not the data model itself. Encoding products, clients, people and decisions as PARA folders would make cross-cutting relationships brittle.

## 03   Information model

### 3.1 Core entities

| **Entity** | **Definition** | **Key attributes** | **Typical links** |
| --- | --- | --- | --- |
| Meeting | A calendar event where people discuss one or more topics. | Title/topic, date/time, attendees, project/client/product context, external calendar ID | Canonical meeting note, people, sources, tasks, decisions, open points |
| Note | Human-readable Markdown content. Meeting Notes and Knowledge Notes are distinct note types; each has a stable identity. | Stable ID, type, title, date, Markdown path, front-matter metadata | Meeting or knowledge context, project, client, product, person, sources/assets |
| Task | A concrete action that should produce an output and has an owner. | Title, owner, status, priority, due date, expected output | Project/client/product, source meeting, people, dependencies |
| Decision | A resolved choice or conclusion connected to a topic or project. | Decision text, date, context, optional rationale | Project/client/product, meeting, people, source |
| Open point | An unresolved question or topic requiring further exploration. | Question/topic, status, importance, optional owner | Project/client/product, meeting, source; may lead to task/decision |
| Project | A scoped body of work around a topic, normally with a defined outcome and optional start/end dates. | Name, objective, success condition, status, dates | Client, product, meetings, tasks, decisions, open points, people |
| Product | A long-lived product that can have build work and deployments across multiple clients. | Name, description, lifecycle/status | Projects, clients, decisions, notes, people |
| Client | An ongoing organization/context with multiple workstreams and projects. | Name, context, status | Projects, products, requirements, tasks, decisions, people |
| Person | A participant or stakeholder used to connect meetings, tasks and history. | Name, organization, role, contact/reference info | Meetings, 1:1 notes, tasks, decisions, waiting items |
| Source | The provenance record behind a piece of structured information. | Source type, URL/pointer, external ID, timestamp | Transcript, recording, calendar invite, document, note, future email/Slack |
| Asset | A pasted or attached file referenced by a note. | File path, media type, original filename | Note/source; stored in the managed assets area |
| Knowledge Note | A reusable, distilled concept, learning, observation or research synthesis that can outlive the context in which it was captured. | Stable ID, title, Markdown body, subjects/topics, tags, area tag, created/updated, source links | Other knowledge notes, sources, projects, products, clients, people, meetings |

### 3.2 Relationship model

| **Relationship** | **Meaning** |
| --- | --- |
| Meeting -> Note | Each meeting has exactly one canonical meeting note. Other outputs become independent structured objects or Knowledge Notes linked to the relevant context. |
| Meeting -> Person | Many-to-many relationship representing attendees and other stakeholders. |
| Meeting -> Project / Client / Product | Optional contextual links. When present, they drive inheritance into extracted tasks, decisions and open points. |
| Project -> Client | A client can have many projects; a project normally belongs to one primary client in the professional context. |
| Project -> Product | A product can have many projects, including client deployments or build work. |
| Task -> Person | Each task has an owner. Tasks owned by the user appear in My Tasks; others can appear in Waiting On / delegated views. |
| Decision / Open point -> Context | Both should link directly to the relevant project/client/product rather than living only inside a meeting note. |
| Structured item -> Source | Every AI-extracted item can retain one or more provenance links back to a note, transcript or other source. |
| Person -> 1:1 history | Person pages aggregate past meetings, notes, decisions and outstanding items for ongoing conversations. |
| Source -> Knowledge Note | Raw source material can produce one or more synthesized Knowledge Notes while the original source remains preserved and traceable. |
| Knowledge Note -> Subject / Context | Knowledge Notes carry subject/topic metadata and may link to projects, products, clients, people, meetings and other notes without being filed inside those entities. |
| Area / Subject -> Tag metadata | Area remains a tag. Subjects/topics are also metadata rather than first-class entities initially; they support filtering and Obsidian navigation without adding schema complexity. |

### 3.3 Recommended identity rule

> **Stable IDs over filenames**
> Every first-class object should have a stable ID (for example a UUID). Filenames, folder names and display titles may change; relationships should not depend on them. This is what allows shallow folders, renaming and future database migration without breaking links.

### 3.4 Shared object contract

Every first-class Person, Client, Product, Project, Meeting, Note, Task, Decision, Open Point, Source, Review Item and relevant system record is represented by one Markdown file. Each file contains a common YAML front-matter envelope with an immutable UUIDv7 ID, object type, schema version, revision, title and lifecycle timestamps. Type-specific fields live in the same front matter; narrative content lives in the Markdown body.

Relationships reference stable IDs rather than paths, filenames or titles. The application validates referential integrity while building its in-memory index and reports duplicate IDs, missing targets and invalid types through a System Health view. Knowledge Notes remain first-class objects with `type: knowledge-note`; no database row is required to establish their identity.

## 04   User workflows

### 4.1 Meeting lifecycle

| **Step** | **Expected behavior** |
| --- | --- |
| 1. Select | Open the Calendar view and click a meeting/event. |
| 2. Create note | Choose New Note. If no note exists, create the meeting's single canonical note and pre-populate it with meeting name, date/time, people and any known project/client/product context. |
| 3. Capture freely | Write in a single free-form notes area using restrained rich formatting. Do not force manual classification while the meeting is in progress. |
| 4. Enrich | When processing is triggered, use authenticated connector access to retrieve available meeting transcript, recording references and linked Drive documents associated with the event. |
| 5. Process with AI | Compare the user's notes with the transcript/material and propose a meeting summary, decisions, actions and open points. Highlight potentially missed items. |
| 6. Preserve provenance | Each proposed item retains its source and, where available, an exact source fragment such as a transcript timestamp, page, paragraph, section, message or character range. |
| 7. Review | Persist AI-generated commitments as Markdown Review Item objects and present a fast accept, edit or reject flow. Context enrichment may be applied automatically when strongly supported; commitments do not become authoritative Tasks, Decisions or Open Points until accepted. |
| 8. Publish | Confirmed items become structured objects and automatically appear in the relevant task, project, client, product and person views. |

### 4.2 Meeting note template

The meeting page can display several structured sections, but note-taking should still start in one natural capture area. The template below is the recommended baseline:

- Meeting metadata: title, date/time, attendees, client, product, project.
- Notes: the primary live capture area.
- Summary: populated or proposed after AI processing.
- Decisions: structured objects surfaced in the page, not duplicated prose.
- Actions: structured tasks surfaced in the page.
- Open points: unresolved questions surfaced in the page.
- References: transcript, recording, calendar event, linked documents and other sources.

> **Editing detail**
> Standard Markdown covers headings, bullet lists, bold and italic. Underline is not part of standard Markdown; preserve portability by storing underline as minimal inline HTML (for example <u>text</u>) or an equivalent editor extension that Obsidian can render.

### 4.3 Task lifecycle

Tasks often originate in meetings, but they can also be created manually, by voice, from a personal thought, or later from email/Slack. The creation source should not change the task model.

| **Stage** | **Behavior** |
| --- | --- |
| Capture | Meeting extraction, manual entry, text Quick Capture (including external speech-to-text), or future email/Slack extraction. |
| Infer context | Inherit or infer project/client/product/person links. Do not require the user to reclassify obvious context. |
| Review proposal | AI-generated or ambiguous actions become Review Item Markdown objects with proposed fields, field-level evidence and a confidence label. They do not exist as authoritative Tasks yet. |
| Plan | Accepted tasks move into Next or a date-driven view. The user can set priority and due date. |
| Execute / wait | User-owned work remains in My Tasks. Delegated work has another owner; user-owned blocked work may identify a separate waiting-for person. |
| Complete / cancel | Done and Cancelled are distinct terminal states. Both remain linked to their project, source and history rather than disappearing. |

### 4.4 Task fields

| **Field** | **Requirement** | **Purpose** |
| --- | --- | --- |
| Title | Required | Short action-oriented description |
| Status | Required | Inbox, Next, Waiting, Done, Cancelled |
| Owner | Required | User or another person |
| Waiting for | Optional | A separate person when an owner remains responsible but progress depends on somebody else; permitted only in Waiting status |
| Due date/time | Optional | Either a date-only `due_on`, or `due_at` plus timezone for a precise deadline; never both |
| Priority | Optional | High / Medium / Low. Priority represents importance; due date represents urgency. |
| Project | Optional / inherited | Primary project context |
| Client | Optional / inherited | Can be inherited through project/meeting context |
| Product | Optional / inherited | Can be inherited through project/meeting context |
| Source | Recommended | Meeting/note/transcript/text capture/etc. |
| Expected output | Optional | What completion should produce |
| Dependencies | Optional | Other tasks or decisions that block completion |

### 4.5 Voice/text capture

Speech recognition is outside the LifeOS scope. Voice can be converted to text by the user's chosen speech-to-text model before insertion. LifeOS receives the resulting text through Quick Capture and applies the same extraction, context-inheritance and review rules as any other text input.

### 4.6 Knowledge ingestion lifecycle

LifeOS should preserve the distinction between captured source material and distilled knowledge. Articles, PDFs, web clips, documents, transcripts, emails or personal captures may enter a raw inbox, be processed by AI, and produce one or more reusable Knowledge Notes. The raw source remains preserved and every synthesis keeps provenance links.

Recommended flow: Source -> Raw Inbox -> AI processing -> Knowledge Note(s) -> links to subjects/topics, projects, products, clients, people and related knowledge.

## 05   Workspaces & navigation

### 5.1 Primary navigation

| **Workspace** | **Primary purpose** |
| --- | --- |
| Home / Today | Daily command center and focus view |
| Calendar | Events and entry point into meeting workspaces |
| Tasks | My Tasks, Waiting On and context-based views |
| Projects | Project cockpits combining work, decisions, meetings and open questions |
| Clients | Ongoing client context across multiple projects/products |
| Products | Long-lived product context across build work and deployments |
| People | 1:1 history, outstanding commitments and involvement |
| Knowledge | Knowledge Notes, raw sources, topic/subject views, backlinks and linked research across contexts |
| Inbox | Items requiring review, classification or confirmation |
| Quick capture | Always-available text entry point; voice is converted to text externally before capture |

### 5.2 Home / Today

The home screen should answer one question: what needs my attention now? It should not reproduce email or Slack inboxes.

- Overdue tasks.
- Tasks due today.
- High-priority upcoming tasks.
- AI-suggested Top 3 focus items, each with a visible reason; the user can pin or replace suggestions.
- Next meetings, with relevant outstanding tasks, open points and recent context for preparation.
- Waiting On items grouped by person where useful.
- Review inbox for newly extracted or uncertain structured items.
- Open questions that are blocking progress or relevant to today's meetings.
- Quick capture for text; voice input arrives through external speech-to-text.

### 5.3 AI focus suggestions

The AI can suggest a daily Top 3 by considering due dates, manual priority, dependencies, upcoming meetings and project importance. It should always expose the reason for a suggestion rather than presenting an unexplained ranking.

### 5.4 Calendar / meeting workspace

- Meeting metadata and contextual links at the top.
- Live Markdown-based note editor as the primary workspace.
- Previous context: recent decisions, open points and outstanding tasks related to the meeting context or attendees.
- Post-processing sections for summary, decisions, actions and open points.
- Source references and provenance for extracted items.
- Accept / edit / reject controls for AI suggestions.

### 5.5 Tasks workspace

- Default My Tasks view: only tasks owned by the user.
- Useful groupings: overdue, today, upcoming and priority.
- Waiting On / delegated view for work owned by others but relevant to the user's projects.
- Filters or saved views by project, client, product and person.
- Task detail panel with source, related meeting, context and activity/history.
- List-first design. Boards are not required for the initial version.
- Optional later views: Focus/Today, Blocked and Someday.

### 5.6 Project workspace

- Objective, success condition, status, dates, client, product and key people.
- Current next actions.
- Open questions.
- Recent decisions.
- Upcoming and recent meetings.
- Waiting On / people-related commitments.
- A future "Brief me on this project" capability that synthesizes linked information into a current narrative.

### 5.7 Client, product and person pages

These pages are roll-up views over the same connected model, not separate copies of information. A client page can aggregate active projects, requirements, decisions and actions. A product page can show build and deployment work across clients. A person page can show 1:1 history, tasks, waiting items, decisions and recent meetings.

## 06   PARA, Zettelkasten & Obsidian

### 6.1 PARA as a view

| **PARA element** | **LifeOS implementation** |
| --- | --- |
| Projects | Maps directly to the Project entity and its active work. |
| Areas | Long-lived responsibility domains such as work, family, home or finances. Area remains a tag, not a first-class entity. |
| Resources | Knowledge Notes and preserved source material organized by subjects/topics, tags and links rather than deep folders. |
| Archives | An archived state applied across projects, notes and other objects rather than a separate physical storage hierarchy. |

### 6.2 Zettelkasten influence

Zettelkasten contributes the idea that useful knowledge should be atomic, linkable and rediscoverable beyond the context in which it was captured. LifeOS therefore treats Knowledge Notes as first-class reusable objects that can link to people, products, projects, clients, meetings, sources and other notes. Backlinks and related-note views should be generated from metadata and explicit links rather than folder placement.

### 6.3 Role of Obsidian

Obsidian is a first-class alternate interface into the Markdown knowledge layer, not the engine of LifeOS. LifeOS owns operational state, connectors, AI workflows and dashboards; Obsidian remains valuable for reading, editing, backlinks, graph-style navigation and metadata-driven views such as Obsidian Bases.

- Meeting and Knowledge Notes remain directly readable in Obsidian; contextual pages can also be represented as Markdown when a human-readable narrative is useful.
- Pasted screenshots and files are copied into a managed assets folder and linked from the Markdown note.
- Stable object IDs in front matter allow LifeOS to reconnect links and rebuild indexes even if a file is renamed.
- Operational state such as task status, ownership, AI confidence and processing state is stored in the appropriate object's front matter. The application owns these fields and validates edits made through Obsidian or another external editor.

### 6.4 Metadata model

Type describes what an item is (for example meeting-note or knowledge-note). Area is a broad life-domain tag (for example work, home, family, personal). Subject/topic describes what the content is about (for example Retail Media, Product Management or Home Automation). Subjects/topics remain metadata rather than first-class entities initially.

## 07   Storage & architecture

### 7.1 Markdown-first storage model

| **Layer** | **Authority** | **Examples** |
| --- | --- | --- |
| Markdown files | Authoritative store for every first-class domain object and its operational state | Tasks, projects, meetings, decisions, open points, people, Knowledge Notes, sources, review items and audit records |
| YAML front matter | Authoritative machine-readable fields within each Markdown object | Stable ID, type, schema version, revision, status, dates, ownership, relationships and provenance locators |
| Markdown body | Authoritative human-readable narrative | Notes, descriptions, summaries, rationale, source text and synthesized knowledge |
| Asset files | Authoritative binary content | Images, PDFs, recordings and other attachments |
| In-memory index | Derived and disposable | Lookups by ID/type/status/date, backlinks, Today views, calendar results and validation diagnostics |

There is no authoritative database in the initial implementation. The complete operational state must be recoverable by scanning the Markdown object store and asset directories. A local cache or search index may be introduced later only if it is disposable and can be rebuilt without loss from the files.

### 7.2 Canonical ownership rule

> Markdown is the single source of truth for both narrative and structured state. Do not keep a second authoritative representation in browser storage, a local database, Tiptap JSON or a generated index.

Relationships are stored in one direction wherever possible. For example, a Task carries its `project_id`; a Project does not maintain a competing authoritative list of task IDs. Project task lists, backlinks and roll-ups are calculated from the derived index. This rule reduces cross-file writes and prevents duplicated relationships from drifting apart.

### 7.3 Common Markdown object envelope

Every first-class object uses these common front-matter fields:

| **Field** | **Requirement** | **Purpose** |
| --- | --- | --- |
| `id` | Required, immutable UUIDv7 | Stable identity independent of filename and path |
| `type` | Required, controlled value | Selects the object contract and validation rules |
| `schema_version` | Required integer | Allows safe, versioned file migrations |
| `revision` | Required positive integer | Supports optimistic concurrency and conflict detection |
| `title` | Required | Human-readable display name |
| `created_at` | Required UTC timestamp | Creation history |
| `updated_at` | Required UTC timestamp | Last authoritative change |
| `updated_by_device` | Required | Identifies the writing installation |
| `archived_at` | Optional | Soft archive state |
| `deleted_at` | Optional | Tombstone for synchronized deletion; physical deletion is deferred |
| `area` | Optional | One broad life-domain value |
| `subjects` | Optional list | Subject/topic classification |
| `tags` | Optional list | Ordinary flexible tags |

Type-specific fields such as task status, owner, deadline, meeting time, source locators or AI confidence appear in the same front matter. Paths are always relative to the LifeOS root. Unknown fields are preserved during reads and writes to protect forward compatibility and external-editor content.

### 7.4 LifeOS data-root structure

```text
LifeOS/
    people/
    clients/
    products/
    projects/
    meetings/
    tasks/
    decisions/
    open-points/
    knowledge/
    sources/
    review-items/
    recurring-items/
    audit/
    assets/
    archive/
    .lifeos/
        schema.md
        session.md
        operations/
```

The hierarchy is intentionally shallow. Folders communicate object type and improve human navigation; they do not encode relationships. The root lives in the user's Google Drive data location and is kept outside the Git repository. Each computer configures its own absolute root path, while files store only portable relative paths and stable IDs.

For My Drive, mirrored storage is preferred because the files remain ordinary local files and are always available offline. If the chosen location is an actual Google Shared Drive, which is streamed rather than mirrored, the LifeOS directory must be marked available offline before the application uses it.

### 7.5 Two-computer synchronization and handoff

The supported v0.4 operating mode is one user on two trusted computers with sequential use. Both installations run locally against their synchronized copy of the same Google Drive data root. No central LifeOS service is required for this mode.

Safe handoff procedure:

1. Finish and close LifeOS on the current computer.
2. Confirm that Google Drive reports synchronization complete.
3. Move to the other computer and wait for incoming synchronization to complete.
4. Start LifeOS; it rescans changed files and validates the index before allowing writes.

`.lifeos/session.md` records the current device ID, start time, last activity and lease expiry as an advisory warning. Because a cloud-synchronized lease can arrive late, it is not the sole safety mechanism. Every save also checks the current file revision and content hash against the version originally opened. A mismatch creates a conflict for review instead of overwriting either version.

Simultaneous editing is not supported in the initial version. If it becomes a requirement, add a dedicated synchronization or collaboration service rather than relying on shared-folder locking.

### 7.6 File-operation guarantees

- Parse and validate front matter before accepting a write.
- Reread the target and compare revision plus original content hash immediately before saving.
- Write to a temporary file in the same directory, flush and atomically replace the target.
- Increment `revision`, update `updated_at` and record `updated_by_device` on authoritative changes.
- Preserve unknown front-matter fields and unsupported Markdown constructs.
- Keep recoverable prior versions for application-initiated writes.
- Use tombstones/archive state before physical deletion so an older device cannot silently resurrect deleted content.
- Give every multi-file command an immutable `operation_id` and make it idempotent.
- Store incomplete-operation manifests under `.lifeos/operations/`; startup recovery may safely finish or compensate them.
- Never silently choose a winner when Google Drive or an external editor produces conflicting content.

### 7.7 Local application architecture

| **Component** | **Responsibility** |
| --- | --- |
| User interface | React browser application. It calls application use cases and never writes the data root directly. |
| Application services | Use-case orchestration, context inheritance, proposal acceptance, repeatable multi-file operations, conflict handling and backup coordination. |
| Domain layer | Technology-independent entities and rules for tasks, meetings, notes, decisions, open points, projects, provenance and confirmation. |
| Ports/interfaces | ObjectStore, AssetStore, IndexStore, SecretStore, connector, AI-provider, audit and backup contracts. |
| Markdown object adapter | Parses, validates and atomically persists typed Markdown objects; preserves unknown fields and body syntax. |
| In-memory index adapter | Builds disposable lookups, backlinks, saved views and integrity diagnostics by scanning front matter. |
| File watcher/reconciler | Detects LifeOS, Obsidian and Google Drive changes and refreshes affected objects without silent overwrites. |
| AI processing layer | Provider-agnostic summarization, extraction, classification and knowledge synthesis. AI creates Markdown Review Item proposals; accepted proposals create or update authoritative Markdown objects. |
| Integration adapters | Google Calendar/Meet/Drive first; Slack and email later. Provider IDs and synchronization state are stored in connector-related Markdown system objects, never in secrets. |
| Secret storage | OAuth tokens, API keys and signing material live in the operating-system secret store on each computer. Markdown stores only opaque secret references. |
| Search | Front-matter indexes plus body-text search initially. Any later full-text or vector index is derived and rebuildable. |

### 7.8 Editor architecture

Tiptap remains provisional. It edits the Markdown body only; application forms edit managed front-matter fields. A raw Markdown mode is mandatory. Before adoption, the editor must pass save/reopen tests covering Obsidian syntax, headings, lists, task lists, tables, code blocks, links, inline HTML, pasted assets and external edits. Tiptap JSON must never become a second source of truth.

If lossless round-tripping cannot be demonstrated, use a Markdown-native editor such as CodeMirror as the primary editor, with rich preview as a separate presentation layer.

### 7.9 Backup and recovery

Google Drive synchronization is not the only backup. LifeOS periodically creates versioned, read-only snapshots or archives containing the Markdown root, assets and a checksum manifest. Retain multiple generations and run automated restoration tests. Secrets remain excluded because they are reconnected through each computer's Keychain.

### 7.10 Future hosted architecture

If LifeOS becomes a simultaneous multi-user or always-online product, introduce PostgreSQL behind the existing ObjectStore/repository ports and move assets to object storage. Markdown remains an import/export and portability format. Authentication, tenant isolation, authorization, encryption and merge behavior must be designed before that transition. Stable IDs and explicit object contracts make this a controlled migration, but it is not automatic.

## 08   MVP & roadmap

### 8.1 MVP - prove the core loop

- Browser-based local application using typed Markdown objects, a raw-source area, managed assets and a rebuildable in-memory index; no authoritative database.
- Modular-monolith codebase with explicit domain, application, ports and infrastructure boundaries; user data remains outside the Git repository.
- Versioned Markdown object schemas and validators implementing stable identity, lifecycle, relationship and provenance rules.
- Two-computer sequential-use workflow through Google Drive, with startup validation, advisory session markers, revisions, hashes, atomic writes and visible conflict handling.
- Calendar view with event selection and creation of a pre-populated meeting note.
- Basic rich Markdown editor with pasted image/asset handling.
- Core entities: meetings, canonical meeting notes, Knowledge Notes, tasks, decisions, open points, projects, products, clients, people and sources.
- Basic raw-source ingestion that preserves the original source and can create linked Knowledge Notes after AI processing.
- Post-meeting AI processing using the note plus any accessible transcript/linked material.
- Durable Markdown Review Item objects for proposed actions, decisions, open points, links and meaning-changing edits; authoritative objects are created only after acceptance.
- Evidence-level provenance through sources, source fragments and object-source links.
- Task workspace with Inbox, Next, Waiting, Done and Cancelled; owner, optional waiting-for person, due date or time, priority and contextual links.
- Home / Today dashboard with overdue, due today, upcoming priority work, waiting items, next meetings and quick capture.
- Project, client, product and person roll-up pages.
- Text Quick Capture. Voice support is provided externally through speech-to-text and arrives in LifeOS as text.
- macOS Keychain-backed connector and API secrets; Markdown may store only opaque secret references.
- Private GitHub repository containing application code, object schemas, tests and documentation, with user Markdown, assets, logs, backups and secrets excluded.

### 8.2 Phase 2 - external attention sources

- Email and Slack integration as sources of potential actions and context.
- AI extracts candidate actions from messages; the dashboard does not show raw unread-message counts.
- Saved task views, recurring tasks, Blocked/Someday views.
- Improved project/person briefings and richer meeting-preparation context.
- Knowledge maintenance suggestions: possible backlinks, duplicate/contradiction detection, stale knowledge flags and periodic synthesis. No autonomous destructive edits.
- Obsidian Bases or equivalent metadata-driven views over Type, Area, Subject/Topic and related entity links.
- Hosted deployment or simultaneous multi-user synchronization if sequential two-computer usage has validated the workflow.

### 8.3 Later capabilities

- Semantic search / embeddings across the knowledge base.
- "Brief me" summaries for projects, clients, products or people.
- More automated context enrichment and low-risk maintenance where evidence is strong; commitments and meaning-changing edits remain confirmation-gated.
- Advanced notification and follow-up logic across Waiting On items.
- Broader personal-life integrations, if they add clear value without turning the dashboard into another inbox.

> **Scope discipline**
> The highest-value proof is not whether the system can integrate every source. It is whether the calendar -> meeting -> structured outputs -> task/dashboard loop feels easier than the user's current workflow.

## 09   Decisions, risks & open questions

### 9.1 Decision log

| **Status** | **Decision** |
| --- | --- |
| Baseline | Use a connected entity model rather than PARA folders as the system foundation. |
| Baseline | Use typed Markdown files as the complete authoritative data layer while retaining Obsidian as an alternate interface. |
| Superseded by v0.4 | Store structured/queryable state authoritatively in SQLite. `LifeOS_Backend_Schema_v0.1.sql` is retained as a historical field-and-constraint reference only. |
| Baseline | Start without an authoritative database. Build disposable in-memory indexes from Markdown and preserve ports for a future PostgreSQL migration if simultaneous multi-user hosting is required. |
| Baseline | Use shallow folders and stable IDs; do not encode relationships through directory nesting. |
| Baseline | Meeting note capture remains free-form during the meeting; AI structures content afterward. |
| Baseline | AI can use personal notes plus accessible transcript/recording/linked sources. |
| Baseline | Preserve provenance for AI-extracted items. |
| Baseline | AI may automatically enrich context; AI-generated commitments require confirmation. Destructive or meaning-changing knowledge edits also require confirmation. |
| Baseline | Task status vocabulary begins with Inbox, Next, Waiting and Done. |
| Baseline | Tasks created from context inherit project/client/product information where possible. |
| Baseline | My Tasks focuses on user-owned work; Waiting On provides visibility into commitments owned by others. |
| Baseline | The dashboard surfaces what deserves attention rather than reproducing full email or Slack inboxes. |
| Baseline | Email and Slack are phase 2 sources after the core calendar/meeting/task loop is proven. |
| Baseline | Tasks are list-first; boards are not an MVP requirement. |
| Baseline | The dashboard may use AI to suggest a Top 3, but every suggestion shows a reason and remains overridable. |
| Baseline | Task priority scale is High / Medium / Low; due date remains a separate urgency signal. |
| Baseline | Area remains a tag and is not a first-class entity. |
| Baseline | Use Type, Area, Subject/Topic and Tags as distinct metadata dimensions; Subjects/Topics remain metadata initially. |
| Baseline | Each meeting has exactly one canonical meeting note. |
| Baseline | Knowledge Note is a first-class reusable domain object for distilled concepts, learnings and research synthesis. |
| Baseline | Preserve raw source material separately from processed Knowledge Notes and keep provenance links between them. |
| Baseline | Markdown front matter is authoritative for stable identity, relationships and changing operational state; the Markdown body is authoritative for narrative content. |
| Baseline | The local MVP is a browser-based localhost application bound to the local machine; desktop wrapping is optional later. |
| Baseline | Voice recognition is outside LifeOS; external speech-to-text produces text that LifeOS then processes. |
| Baseline | The LifeOS Markdown data root and assets synchronize through Google Drive for sequential use on two trusted computers. The application also retains independent versioned backups with checksums. |
| Baseline | Authenticated connector access is the intended route for Google Calendar/Meet/Drive context; connector implementation and permission details are adapter concerns. |
| Baseline | LifeOS remains LLM-provider agnostic; MCP may be used but is not a core architectural dependency. |
| Baseline | Maintain an audit trail of AI/agent operations so users can see what the system read, proposed and changed. |
| Baseline | Use a common Markdown object envelope for every first-class domain object so links, tags, provenance and audit records share stable identity and validation rules. |
| Baseline | Use application-generated UUIDv7 text values for durable, portable and roughly time-ordered IDs. |
| Baseline | Represent Knowledge Notes as first-class Markdown objects with `type: knowledge-note`. |
| Baseline | Permit one Area and multiple Subjects and ordinary Tags per object. Area, Subject and Tag remain distinct tag kinds. |
| Baseline | Keep the local MVP single-user without speculative workspace/tenant columns; introduce tenancy and authorization before any hosted or shared deployment. |
| Baseline | Keep one primary project/client/product context on frequently queried domain records and use `entity_links` for secondary relationships. Project context is strongest; conflicting inherited context requires an explicit override. |
| Baseline | Add Cancelled as an explicit task status. Do not represent abandoned work as Done or deletion. |
| Baseline | Separate task ownership from `waiting_for_person_id` so delegated work and user-owned blocked work remain distinguishable. |
| Baseline | Store pending AI changes as Markdown Review Item objects; proposals do not create or modify authoritative commitments until accepted. |
| Baseline | Preserve evidence-level provenance in Markdown fields, including page, timestamp, message, paragraph, section or character-range locators. |
| Baseline | Separate AI execution-history Markdown objects from append-only authoritative audit objects. |
| Baseline | Track object revisions and original content hashes, reconcile external edits, missing files, renames and conflicts, and never overwrite silently. |
| Baseline | Map provider-specific IDs and synchronization state through connector-related Markdown objects rather than provider-specific domain fields. |
| Baseline | Store OAuth tokens, API keys and signing secrets in each computer's operating-system secret store; Markdown stores only opaque secret references. |
| Baseline | Use the private GitHub repository `git@github.com:Rahuldharod/LifeOS.git` for code, schemas, tests and documentation only. Keep user Markdown, assets, logs, backups and secrets outside Git. |
| Baseline | Structure the MVP as a modular monolith with UI, application, domain, ports and infrastructure boundaries. The UI, connectors and AI providers never write authoritative storage directly. |
| Baseline | Support one user on two trusted computers through sequential Google Drive synchronization; simultaneous editing is explicitly out of scope for the initial release. |
| Baseline | Store each first-class object in one Markdown file and store relationships in one authoritative direction wherever possible. |
| Baseline | Build query views and backlinks from a disposable in-memory index that can always be rebuilt from Markdown. |
| Baseline | Make every multi-file operation idempotent and recoverable through an operation ID and incomplete-operation manifest. |
| Baseline | Keep Tiptap provisional, require raw Markdown editing, and reject it if lossless Obsidian-compatible round-tripping cannot be demonstrated. |

### 9.2 Key risks and mitigations

| **Risk** | **Mitigation** |
| --- | --- |
| AI creates false commitments | Require review for extracted tasks/decisions/open points; preserve source links and confidence/uncertainty cues. |
| Too much manual classification | Use meeting context inheritance, voice parsing and an inbox only for uncertain items. |
| Duplicate sources of truth | Keep both narrative and structured state authoritative in the same Markdown object; indexes, browser caches and editor representations remain disposable. |
| Folder structure becomes brittle | Keep folders shallow and use IDs/relationships for cross-cutting organization. |
| External integrations are incomplete | Treat source access as an adapter capability; the core model should work even when a transcript or recording is unavailable. |
| Dashboard becomes noisy | Show actions and attention candidates, not raw streams or unread counts. |
| Scope expands too early | Validate the meeting-to-task loop before email, Slack, cloud sync or semantic search. |
| Sensitive professional/personal data mix | The data root is synchronized through the user's Google Drive account without a LifeOS-specific encryption layer. Confirm that this meets organizational policy; define encryption and separation rules before storing restricted work data. |
| AI rewrites or prunes knowledge incorrectly | Allow automatic enrichment and suggestions, but require confirmation for deletion, merging, factual replacement, decision changes, closing open points or other meaning-changing edits. |
| Google Drive has not completed handoff synchronization | Require a close/sync/wait/open workflow, show the active device/session warning and rescan changed files before enabling writes. |
| OAuth or API credentials leak through files or Git | Store secrets in Keychain, keep only opaque references in Markdown, redact logs, commit `.env.example` only, ignore local environment files and enable GitHub push protection. Rotate any credential that reaches Git history. |
| Obsidian, Drive and LifeOS change the same file | Compare revision and original content hash before saving; preserve both variants and surface a conflict instead of silently choosing a winner. |
| Links create orphaned or invalid IDs without foreign keys | Validate the complete object graph at startup and incrementally after changes; show duplicates, broken links and type mismatches in System Health. |
| Backups exist but cannot be restored | Version the Markdown root, assets and checksum manifest together, retain multiple generations and run periodic automated restore tests. |
| Provider-specific behavior contaminates the domain model | Isolate external accounts, IDs, URLs, ETags and cursors in connector adapters and connector-related Markdown objects. |
| Multi-file operation stops halfway | Use immutable operation IDs, atomic per-file writes, incomplete-operation manifests and idempotent startup recovery. |
| Tiptap rewrites valid Markdown | Require round-trip tests and raw mode; replace Tiptap with a Markdown-native editor if it cannot preserve supported and unknown syntax. |

### 9.3 Open design questions

- Should Subject/Topic metadata use a controlled vocabulary, free-form values, or a hybrid model with AI-assisted normalization?
- Which raw-source capture paths should be prioritized after the meeting vertical slice: pasted text, uploaded PDF/document, web clip, email or another source?
- What cadence and scope should future maintenance agents use for backlink suggestions, contradiction detection, stale-item review and synthesis?
- Does synchronizing professional information through the selected Google Drive account comply with applicable employer and client policies?
- When hosted, what authentication, encryption, credential storage and separation rules are required for professional versus personal information?

### 9.4 Recommended next design steps

1. Scaffold the private GitHub modular-monolith repository at `git@github.com:Rahuldharod/LifeOS.git` with web, server, domain, application, contracts and infrastructure packages.
1. Convert the v0.1 SQL field inventory into versioned Markdown object schemas, YAML validators and representative fixtures; mark the SQL artifact superseded without deleting it.
1. Implement ObjectStore, IndexStore, AssetStore and SecretStore ports before adding UI workflows.
1. Implement UUIDv7 identities, schema versions, revisions, content hashes, atomic writes, tombstones and graph validation.
1. Implement the Keychain-backed SecretStore on each computer before storing any Google or AI-provider credential.
1. Implement Google Drive handoff diagnostics, advisory session state and visible conflict resolution.
1. Create low-fidelity wireframes for Home/Today, Calendar/Meeting, Tasks, Project, Knowledge/Raw Inbox and Review Inbox pages.
1. Verify basic authenticated Google Calendar/Meet/Drive connector access, external-reference mapping and note/asset handling.
1. Build the first vertical slice: select calendar event -> create canonical note -> process note -> create review item -> accept extracted task -> see task on Today and Project pages.
1. Add the second vertical slice: add raw source -> locate supporting source fragment -> propose Knowledge Note -> accept note -> retrieve it through Subject/Context views.
1. Add a snapshot/restore test covering the Markdown root, assets and checksum manifest, plus a clean index rebuild test.
1. Test both flows with real work before adding Slack/email, autonomous maintenance or hosted deployment.

> **Definition of success for the next prototype**
> A real meeting can be captured without extra cognitive load, processed into trustworthy structured outputs, and those outputs automatically reappear in the right daily and project contexts without manual duplication.

## 10   Markdown backend implementation baseline

### 10.1 Object conventions

| **Concern** | **Baseline** |
| --- | --- |
| IDs | Application-generated UUIDv7 text; identity never depends on a filename, title or provider ID. |
| Timestamps | UTC ISO 8601 text with a `Z` suffix. Retain a named IANA timezone when local interpretation matters. |
| Date-only values | ISO `YYYY-MM-DD`; do not convert date-only deadlines into artificial midnight timestamps. |
| Booleans | YAML booleans `true` and `false`; quoted lookalikes are rejected by validation. |
| Variable metadata | Nested YAML is allowed only in explicitly defined fields such as provider metadata, proposal payloads, field evidence and audit snapshots. |
| Paths | Relative to the LifeOS data root; never persist machine-specific absolute paths in portable records or front matter. |
| Deletion | Soft delete through `deleted_at`; physical deletion is a separate maintenance operation after the synchronization retention period. |
| Archiving | Universal `archived_at`; entity status represents business state and does not duplicate Archive. |
| Concurrency | `revision`, the originally read content hash and `updated_by_device` support optimistic conflict detection. |
| Credentials | Markdown stores only an opaque `secret_ref`; the secret value lives in the operating-system secret store. |

### 10.2 Markdown object inventory

The versioned object schemas define allowed fields, required fields, controlled values and cross-object validation. The following fields supplement the common envelope from section 7.3.

| **Object type** | **Principal type-specific fields** |
| --- | --- |
| `person` | given_name, family_name, organization_name, job_title, timezone, identifiers, avatar_asset_id, is_self |
| `client` | status, summary, website_url, primary_contact_person_id |
| `product` | status, description, owner_person_id |
| `project` | status, objective, success_criteria, owner_person_id, primary_client_id, primary_product_id, start_on, target_end_on, completed_at |
| `meeting` | status, starts_at, ends_at, timezone, is_all_day, location, join_url, organizer_person_id, attendee_ids, primary_project_id, primary_client_id, primary_product_id, external_refs |
| `meeting-note` | meeting_id, people_ids, primary context IDs, source_ids, asset_ids |
| `knowledge-note` | source_ids, related_object_ids, area, subjects, tags |
| `task` | status, priority, owner_person_id, waiting_for_person_id, expected_output, due_on, due_at, due_timezone, completed_at, cancelled_at, dependency_ids, primary context IDs, source_meeting_id, source_ids |
| `decision` | status, decision_text, rationale, decided_at, supersedes_decision_id, primary context IDs, source_meeting_id, source_ids |
| `open-point` | status, importance, owner_person_id, due_on, resolved_at, closed_at, resolution_summary, resolution_decision_id, primary context IDs, source_meeting_id, source_ids |
| `source` | source_type, source_uri, asset_id, external_refs, mime_type, content_sha256, occurred_at, captured_at, ingestion_status, fragments |
| `review-item` | review_type, target_object_type, target_object_id, proposed_fields, field_evidence, confidence_label, status, agent_run_id, resolved_object_id, reviewed_at, rejection_reason, operation_id |
| `agent-run` | operation, provider, model, prompt_version, status, timestamps, input_summary, output_summary, token/cost metrics, error, correlation_id, related_object_ids |
| `audit-event` | occurred_at, actor_type, actor_ref, action, object_id, agent_run_id, correlation_id, before, after, metadata |
| `connector-account` | provider, account_label, external_account_id, status, secret_ref, scopes, last_sync_at |
| `sync-run` | connector_account_id, resource_type, status, timestamps, cursors, record counts, error |
| `daily-focus` | focus_on, ranked task selections, selection_type, rationale, is_pinned, agent_run_id |
| `recurring-item` | target_type, recurrence rule, timezone, next occurrence, template fields, status |

Assets remain binary files with their identity and metadata carried by the referencing object's asset entry or, when independently addressable, a small `asset` Markdown object.

### 10.3 Critical validation and lifecycle rules

- Every first-class object has exactly one Markdown file and one globally unique ID.
- Exactly one person may have `is_self: true`; My Tasks resolves through this stable person ID.
- Each meeting has at most one canonical meeting note, enforced by graph validation.
- Knowledge Notes are first-class Markdown objects with `type: knowledge-note`.
- Each object may have at most one Area and any number of Subjects and ordinary Tags.
- Task priority is nullable High, Medium or Low. Task status is Inbox, Next, Waiting, Done or Cancelled.
- `due_on` and `due_at` are mutually exclusive; a timed deadline also requires `due_timezone`.
- A waiting-for person is allowed only when the task is in Waiting status.
- Completed and cancelled timestamps must agree with task status.
- Task dependency self-links, decision self-supersession and generic entity self-links are prohibited.
- Review items retain proposed fields and field evidence as validated YAML; acceptance performs an idempotent, recoverable file operation.
- Source fragments belong to their source, and object evidence links may reference only a fragment from the same source.
- Provider account/type/external-ID tuples are unique across the in-memory graph so connector retries remain idempotent.
- Duplicate IDs, broken references, type mismatches and invalid lifecycles block affected writes and appear in System Health.
- Computed backlinks and roll-ups are never written back as competing authoritative relationships.

### 10.4 Application and data-layer separation

```text
Browser UI
    -> Application use cases
        -> Domain rules
        -> ObjectStore / IndexStore / AssetStore / SecretStore / Connector / AI ports
            -> Typed Markdown object adapter
            -> In-memory index and graph validator
            -> Filesystem asset adapter
            -> macOS Keychain adapter
            -> Google and future connector adapters
            -> OpenAI, Claude, Gemini or local-model adapters
```

The UI never writes Markdown directly. Connectors return normalized input but never write authoritative objects directly. AI providers create proposals, not commitments. Application use cases coordinate validation, repeatable multi-file operations, atomic per-file writes, evidence links and audit events. Domain code has no dependency on Markdown parsing, files, Google Drive, Keychain or a model provider.

### 10.5 Private GitHub repository structure

```text
lifeos/
    apps/
        web/
        server/
    packages/
        domain/
        application/
        contracts/
        object-store-markdown/
        index-memory/
        assets-filesystem/
        connectors/
        ai/
        secrets/
        shared/
    schemas/
        objects/
        fixtures/
    tests/
        unit/
        integration/
        fixtures/
    docs/
        architecture/
        decisions/
    .github/
        workflows/
            ci.yml
    .env.example
    .gitignore
    README.md
```

Canonical repository:

- SSH: `git@github.com:Rahuldharod/LifeOS.git`
- Web: <https://github.com/Rahuldharod/LifeOS>

Git contains code, versioned object schemas, synthetic fixtures, tests, documentation and example configuration. It excludes `.env` files, user Markdown, assets, raw sources, backups, logs, temporary files, local indexes and real personal or client content. GitHub push protection should be enabled before the first meaningful push. CI validates all synthetic objects, rebuilds an index from fixtures, checks relationship integrity, runs file-operation recovery tests and executes unit, integration and browser tests.

### 10.6 Secret-storage contract

The local macOS implementation uses Keychain for OAuth access/refresh tokens, API keys, session-signing keys and future encryption keys. Use a stable service name such as `com.lifeos.local` and distinct account keys such as `google:<account-id>:refresh-token`. Work credentials should be configured as non-synchronizing when organizational policy requires them to remain on the device. Each computer establishes its own local secret entries for the same opaque references.

`secret_ref` is an opaque lookup identifier. It must never contain the credential value. Secrets must not appear in Markdown, config files, command arguments, logs, backups, Git history or AI prompts. A local `.env` file is permitted only as a temporary development fallback and must be ignored; `.env.example` contains names and placeholders only. GitHub Actions uses repository/environment secrets only when necessary and prefers OpenID Connect for supported cloud deployments.

### 10.7 Indexing and validation baseline

- Scan front matter first and load Markdown bodies on demand.
- Index by ID, type, status, date, owner, context IDs, source IDs and tags.
- Build reverse relationships and backlinks from authoritative forward references.
- Watch the data root and incrementally revalidate changed files.
- Perform a full graph validation on startup, after schema migration and during backup verification.
- Treat all search, calendar and backlink indexes as disposable and rebuildable.
- Quarantine no file silently: malformed or unsupported objects remain visible in System Health with a precise diagnostic.
- Migrate through numbered schema transformations, backing up affected files and recording the applied operation before rewriting them.

### 10.8 Provisional technical stack

| **Layer** | **Baseline** |
| --- | --- |
| Interface | React + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui + Lucide |
| Navigation | React Router |
| API state | TanStack Query; it is not the authoritative datastore |
| Editor | Tiptap only if round-trip acceptance tests pass; raw Markdown mode required |
| Calendar | FullCalendar Standard behind an adapter |
| Local service | Node.js + TypeScript + Fastify, bound to localhost by default |
| Persistence | Typed Markdown ObjectStore + filesystem assets + rebuildable in-memory IndexStore |
| Validation | Shared versioned runtime schemas for front matter and API contracts |
| Verification | Type checking, Vitest, integration tests and Playwright |

The Fastify service may serve the built Vite application on one local origin. The React UI communicates through versioned API contracts and never receives filesystem paths that it can write directly. The prototype should use the same contracts with a mock API rather than creating a separate browser-local persistence model.

### 10.9 Historical SQL artifact

`LifeOS_Backend_Schema_v0.1.sql` is superseded as of solution design v0.4. It remains valuable as a reviewed inventory of fields, lifecycle checks, provenance requirements and relational constraints. Implementation should translate those requirements into the Markdown schemas and graph validator; it must not create an active SQLite database unless a later architecture decision explicitly reintroduces a disposable cache or authoritative database.

## 11   Appendix - reference object examples

### 11.1 Example note front matter (proposed)

```yaml
---
id: 01995d52-7baf-7c21-9c96-9c5d2f6a32ac
type: meeting-note
schema_version: 1
revision: 3
title: Weekly Product Review
created_at: 2026-09-20T08:00:00Z
updated_at: 2026-09-20T10:15:00Z
updated_by_device: rahul-macbook
meeting_id: 01995d4e-a934-70e5-a5a6-85e31541a91f
primary_project_id: 01995d49-d7de-7be8-a1b6-68a8eb899e56
primary_product_id: 01995d46-f155-7193-8d1d-320aac6cc766
primary_client_id: 01995d43-264b-7974-9020-1b109e6bf813
people_ids:
  - 01995d3e-912b-7357-8aa6-9816c1ad90a5
area: work
subjects:
  - Retail Media
  - Experimentation
tags:
  - weekly-review
---
```

```markdown
# Notes
- Free-form meeting capture ...
```

Front matter is authoritative for identity, context and operational state. Application-managed fields are validated on load and save; external changes are imported only when valid and are never allowed to overwrite a newer revision silently.

### 11.2 Example meeting-to-output trace

| **Object / stage** | **Example** |
| --- | --- |
| Meeting | Weekly Product Review - 20 Sep |
| User note | Free-form note contains "Joel to confirm audience sizing by Friday". |
| Transcript source | Transcript segment corroborates owner and timing. |
| AI proposal | Task: Confirm audience sizing; Owner: Joel; Due: Friday; Project: inferred from meeting. |
| Review | User accepts or edits the task. |
| Result | Task appears in Waiting On, the project page, Joel's person page and the meeting page; source remains traceable. |

### 11.3 Example raw-source to Knowledge Note trace

Raw source: A PDF, article, transcript or captured text is stored in the raw source area with a Source record and stable provenance.
AI synthesis: The processor identifies reusable concepts and proposes one or more Knowledge Notes, each with Subjects/Topics, context links and source evidence.
Result: The original source remains intact; the Knowledge Note is readable in Obsidian and retrievable from LifeOS through topic, project, product, client, person and related-note views.
