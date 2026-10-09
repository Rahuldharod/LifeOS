# LifeOS

*Personal Knowledge & Work Management System*

*Solution Design Document*

> **Purpose**
> A practical design baseline for building a personal operating system that connects calendar events, meeting notes, decisions, open questions, tasks, projects, products, clients and people - while remaining portable, traceable and compatible with Obsidian.

| **Version** | 0.8 |
| --- | --- |
| **Date** | 4 October 2026 |
| **Status** | Living design baseline - reconciled with the final Phase A build on branch `feature/phase-a-close-21` (commit `00d2306`, not yet merged to `main`) and with the Phase A spec ([#21](https://github.com/Rahuldharod/LifeOS/issues/21), `LifeOS_PRD_Phase-A_v1.0.md`) |
| **Primary use** | Guide implementation decisions, scope the MVP, and serve as the versioned source of truth for future design changes |
| **Code repository** | [Rahuldharod/LifeOS](https://github.com/Rahuldharod/LifeOS) (`git@github.com:Rahuldharod/LifeOS.git`) |
| **Revision summary** | v0.8: records the final Phase A build. The skills pack (five skills, examples tested in CI), automatic backups with a per-Mac off-Drive copy and a safe stop, the History panel with restore, Mark restricted on decisions, open points and meetings, the enrichment state and "unreviewed" marker, the calendar offline fallback, and the editor round-trip suite with the "Unproven formatting" label are built. Launcher, font, dark theme, Playwright and the performance fixture move to Phase B (#90). See the v0.8 revision note. |
| **v0.7 summary** | v0.7: records the Phase A build. Marks what is built on `feature/phase-a-21` (section 12.6), the product decisions taken during the build (13.10) and the known gaps (13.11). Removes the user's real email addresses and company domains: they now live in two Settings cards, **My email addresses** and **Internal domains**. Updates the Keychain helper location (#23) and the Keychain prompt behaviour (#77). See the v0.7 revision note. |
| **v0.6 summary** | v0.6: adopts the decisions of the 3 October 2026 grilling session and the Phase A spec. Agents write Inbox Drafts, which the app adopts; Claude skills replace the in-app AI provider for Phase A; post-meeting enrichment runs through Work Orders; a Daily Focus brief is written by a 06:00 routine and sent as a Slack DM; Claude reads a derived Agent Index; Decisions and Open Points get a workspace; People are matched by email and labelled; `origin` and `sensitivity` fields are added; backups become automatic with an off-Drive copy; work is phased (A: work daily driver, B: personal). See the v0.6 revision note and section 13. |
| **v0.5 summary** | Reconciles v0.4 with the code as built: records what is implemented, partial, mocked or not started (new section 12); replaces the provisional Tiptap decision with the Milkdown-based Markdown-native editor; corrects the data-root layout, file naming, lease, backup, secret-store and technology-stack descriptions; documents the non-persisting calendar-event open, note delete/restore, synced settings and stable-vs-development runtimes; adds the expanded Area vocabulary and agent glossary from `CONTEXT.md`; and refreshes risks, open questions and next steps from the Product Backlog. |

### Revision note: v0.8

Version 0.8 **changes no product intent from the Phase A spec**. It records the final Phase A build (tickets #49–#51, #84–#89, #91–#96) and moves the remaining hardening items to Phase B. Sections that changed carry a **"v0.8"** label. Where v0.8 text and older text disagree, v0.8 wins.

| **Date** | **Change** | **Where** |
| --- | --- | --- |
| 2026-10-04 | Build status updated to the final Phase A build on `feature/phase-a-close-21` (`00d2306`). Skills pack, morning routine and Slack DM (as skills), automatic backups, History panel, calendar offline fallback and editor suite now built. | 12.6 |
| 2026-10-04 | Skills pack built in `skills/`: `lifeos-object-contract`, `lifeos-capture`, `lifeos-ask`, `lifeos-enrichment`, `lifeos-morning`. Every example is adopted by the real code in CI. Install and dry-run by Rahul (`skills/INSTALL.md`). | 12.6, 13.12 |
| 2026-10-04 | Backups: automatic at start, daily and at a clean stop; weekly off-Drive copy (4 kept) to a folder set **per Mac**; failure banner with **Back up now**; stop sequence; one queue shared with adoption (ADR 0004, ADR 0005 amended). | 7.9, 9.1, 13.12 |
| 2026-10-04 | Editor: round-trip suite in CI; **Unproven formatting** label; images never lost; LifeOS's own Summary section round-trips. | 7.8, 13.12 |
| 2026-10-04 | Calendar offline fallback shows meetings already stored in LifeOS (not a separate cache); demo meetings only in mock mode. | 5.4, 9.2, 13.12 |
| 2026-10-04 | Decisions recorded: restore never changes sensitivity or review state; Today's lock follows the note; Slack DM sent to Rahul only; working hours assumed 09:00–18:00 `[TBD]`; client-content gate blocked until IT/legal sign-off `[TBD]`; enrichment refuses when internal domains are unset; Work Order filing rule. | 9.1, 13.12 |
| 2026-10-04 | Phase B scope: macOS launcher and start at login, dyslexia-friendly font, dark theme, Playwright tests and the 10,000-object fixture (#90). | 08, 12.6 |
| 2026-10-04 | Known gaps refreshed: restore button gap closed; new gaps for skills not yet installed, connector questions, offline calendar limits, writes refused during a stop. | 13.13 |
| 2026-10-04 | Glossary: new terms in `CONTEXT.md` (Unreviewed person, Enrichment state labels, Offline calendar, Unproven formatting, Off-Drive copy, Client-content gate, Work Order filing rule, Skills pack). | 3.5 |

### Revision note: v0.7

Version 0.7 **changes no product intent from the Phase A spec**. It records what was built and the decisions taken while building. Sections that changed carry a **"v0.7"** label. Where v0.7 text and older text disagree, v0.7 wins.

| **Date** | **Change** | **Where** |
| --- | --- | --- |
| 2026-10-04 | Phase A build status added: app side built for stories 1–80; skills pack, morning routine, Slack DM, backup schedule, launcher, calendar offline cache and editor suite not built. | 12.6 |
| 2026-10-04 | Build decisions recorded: Top 3 up to 5 items capped by Max must-dos; restricted meetings and lock badges; last 10 version copies; one crash-recovery pattern with "recorded intent wins"; supersede link set once while active; self addresses and internal domains in Settings with a warning; Keychain status without secret reads; link-resolution card with create-and-link; summary between markers; "Show N more" lists. | 9.1, 13.10 |
| 2026-10-04 | Known gaps listed: no restore button for version copies, undo refused when text follows the appended note, calendar sync still reads the Keychain, two-device limits. | 13.11 |
| 2026-10-04 | Real email addresses and company domains removed; replaced by the Settings cards and `example.com` placeholders. | 3.5, 5.7, 9.1 |
| 2026-10-04 | Glossary status column updated from "Planned" to built; new terms added to `CONTEXT.md`. | 3.5 |
| 2026-10-04 | Keychain helper moved to an owner-only folder (#23); status never reads secret values (#77). | 9.2, 10.6 |

### Revision note: v0.6

Version 0.6 **changes product intent**. The changes come from a structured grilling session (3 October 2026, questions Q1-Q41 and conflict resolutions C1-C5). They are specified for build in the Phase A spec: GitHub issue [#21](https://github.com/Rahuldharod/LifeOS/issues/21), with a local copy in `LifeOS_PRD_Phase-A_v1.0.md`. Section 13 summarises the new design. Sections that changed carry a **"v0.6"** label. Where v0.6 text and older text disagree, v0.6 wins.

| **Area** | **Before (v0.5 and map #1)** | **v0.6** |
| --- | --- | --- |
| Agent writes | Agents write final object files under an Object Contract | Agents write **Inbox Drafts** into `_inbox/`. Only the app writes objects (**Adoption**). |
| AI | In-app provider calling the Claude API | **Agent-first**: Claude with the user's subscription and connectors, through skills. The in-app provider is deferred. The `AiProvider` port stays. |
| Post-meeting material | Fetched by the app from Drive (not built) | **Work Orders** from "Enrich last 48h". Claude fetches Meet, Gong and Gmail material. |
| Top 3 | AI suggestion (planned) or the deterministic rule (built) | **Daily Focus** brief from a 06:00 routine, live overlay, app-owned **Focus Override**. The rule remains the fallback. |
| Mobile | Out of scope (later: Markor + FolderSync) | Claude Android app + Drive connector writing Inbox Drafts. Read via the **Agent Index**. |
| Scope | One MVP | **Phase A** (work daily driver) then **Phase B** (personal), behind an exit gate. |
| Migration | Import `actions.md` | Fresh start for work. Personal rows move in Phase B. |

### Revision note: v0.5

Version 0.5 changes no product intent. It brings the document into line with the implementation and with ADRs 0001-0006 in the code repository. Where the code differs from v0.4, the difference is recorded as an **accepted deviation** (section 12.3) or a **gap** (section 12.2), not silently rewritten. Items that could not be confirmed from the code are marked `[TBD - verify]`. The test counts in section 12 are counted from source; the test suite was not executed for this revision.

Where a section below says "As built (v0.5)", that text describes the code. Text without that label remains the design intent.

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
| 12 | Implementation status & deviations | What the code does today against this design, accepted deviations, gaps, the delivered backlog and (v0.7, v0.8) the Phase A build status |
| 13 | Phase A design (v0.6, build notes v0.7 and v0.8) | Inbox Drafts and Adoption, agent-first AI, Enrichment, Daily Focus, Agent Index, People, sensitivity, phasing, success gates, build decisions and known gaps |

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

**v0.6 - phasing.** Delivery is in two phases:
- **Phase A** makes LifeOS the single source of truth for **work** commitments. Its exit gate is 4 consecutive weeks in which every new work action is captured in LifeOS and Steve's morning brief reads from LifeOS.
- **Phase B** (personal areas, recurring upkeep, Belongings, the personal rows of `Actions/actions.md`, personal calendar) opens only after that gate.

Jira coexists for team tickets and is never written from LifeOS. Notion is retired. Todoist is parked.

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
| Agents draft; the app writes (v0.6) | Agents never write authoritative object files. They write Inbox Drafts and read the derived Agent Index. The application validates, adopts, routes and audits every change. |
| Origin decides review (v0.6) | Words the user dictated become objects directly. Anything an agent extracted becomes a Review Item. Meaning-changing edits are always reviewed. |

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

### 3.5 Glossary additions (from `CONTEXT.md`)

The repository keeps a domain glossary in `CONTEXT.md`. The terms below extend this design; they are adopted here so there is one vocabulary.

| **Term** | **Meaning** | **Status in code** |
| --- | --- | --- |
| Area | One broad life domain per object, carried as a tag. Values: `work`, `maintenance`, `household`, `learning`, `personal-projects`, `personal-growth`. | v0.7: validated on new writes; legacy values warn in System Health (#30). |
| Maintenance (Area) | Upkeep of things the user owns or runs, typically recurring. | Vocabulary only. |
| Household (Area) | Chores, errands and life paperwork that are not upkeep of a specific owned thing. | Vocabulary only. |
| Learning (Area) | Taking in external knowledge and distilling it into Knowledge Notes. | Vocabulary only. |
| Personal growth (Area) | Reflection and self-development. Goals and Habits are deliberately not modelled. | Vocabulary only. |
| Belonging | A physical thing the user owns or runs and may need to maintain (device, appliance, home system, vehicle). The subject of Maintenance work. | Not modelled. v0.6: Phase B. The lightweight option is a subject tag (for example `belonging:boiler`). Whether it becomes a full object type is decided in issue #9. |
| Agent | A non-human actor (for example a Claude agent) that reads the Agent Index and writes Inbox Drafts (v0.6: never objects). An Agent is not a Person and cannot own commitments without the user accepting them. | Recorded as `actor_type: agent` on audit events and as `agent-run` objects. |
| Object Contract | The written rules an Agent must follow to create or change an object directly as a file, including the envelope and which changes must be proposed as Review Items. | Partly in `AGENTS.md` and the JSON schemas. v0.6: redefined as the Inbox Draft and Patch Draft formats plus routing rules, versioned with the skills pack. v0.8: `skills/lifeos-object-contract/SKILL.md`, its examples tested in CI. |
| Inbox Draft (v0.6) | An agent-written file in `_inbox/` awaiting adoption. Not an object. | v0.7: built on `feature/phase-a-21`. |
| Adoption (v0.6) | The application turning an Inbox Draft into objects or Review Items: assigning IDs, resolving names, validating, filing and auditing. | v0.7: built on `feature/phase-a-21`. |
| Patch Draft (v0.6) | An Inbox Draft that changes an existing object. | v0.7: built on `feature/phase-a-21`. |
| Work Order (v0.6) | An app-written request for an agent run (enrichment, re-plan). | v0.7: built on `feature/phase-a-21`. |
| Enrichment (v0.6) | Collecting post-meeting material (transcripts, recordings, Gong, documents) and proposing missed items. | v0.7: built on `feature/phase-a-21`. |
| Agent Index (v0.6) | Derived, disposable summary files in `_agent/` that agents read instead of scanning the vault. | v0.7: built on `feature/phase-a-21`. |
| Daily Focus (v0.6) | The agent-written morning brief object for a date. | v0.8: adoption, the Today view and the morning skill (`lifeos-morning`) built; not yet scheduled by Rahul. |
| Focus Override (v0.6) | The user's app-owned pin, replace and dismiss choices for the day's Top 3. | v0.7: built on `feature/phase-a-21`. |
| Origin (v0.6) | How an object came to exist: app, user-dictated, agent-extracted, calendar, imported or external. | v0.7: built on `feature/phase-a-21`. |
| Sensitivity (v0.6) | Whether agents and exports may use an object: `normal` or `restricted`. | v0.7: built on `feature/phase-a-21`. |
| External person (v0.6) | A person whose email domain is not one of the internal domains (a setting, e.g. `example.com`). | v0.7: built on `feature/phase-a-21`. |

**v0.7.** Terms added to `CONTEXT.md` during the build (Self person, Internal domains, Display label, Enrichment state, Meeting material, Restricted meeting, Live, Operation journal, Replay-safe, Recorded intent, Version copy, Max must-dos) are defined there; this table does not repeat them.

**v0.8.** Further terms added to `CONTEXT.md`: Skills pack, Unreviewed person, Offline calendar, Unproven formatting, Off-Drive copy, Clean stop, Client-content gate, Work Order filing rule. Enrichment state now lists the labels the meeting page shows.

The Area set above supersedes the examples in section 6.4 ("work, home, family, personal"). Existing objects that use other values remain valid because the field is not enforced.

**v0.6.** Area becomes validated: new writes must use the vocabulary above. Existing files with other values raise a System Health warning, not a rejection. Validation keeps a later split of work and personal data possible within the single vault.

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

**As built (v0.5) - steps 1 and 2.** Opening a calendar event is a pure read: the server returns the existing meeting workspace or a non-persisted preview, and writes nothing. The meeting and its single canonical note are created only on the user's first real edit, using that text as the initial body. Creation is idempotent and serialized per calendar event; an interrupted creation is finished from an operation journal on restart (PB-020, PB-004). A repair command, `pnpm reconcile-meetings`, reports meetings duplicated for one calendar event and, with `--apply`, backs up and archives the empty extra copies.

**As built (v0.5) - steps 4 to 8.** Steps 5 to 8 run end to end, but the AI is a deterministic mock (see 12.2). Steps 4 and 6 are not implemented for meetings: no transcript, recording or Drive document is fetched, and meeting proposals carry a note-level source link with empty field-level evidence.

**v0.6 - steps 4 to 6 become agent-driven (section 13.3).** Transcripts, recordings and Gong material arrive asynchronously, hours after the meeting. So:
1. The user presses **Enrich last 48h**. The app writes a **Work Order** listing every ended meeting and the material still missing.
2. The user asks Claude to "run LifeOS enrichment". The enrichment skill fetches:
   - Meet transcripts and recordings, via the calendar event and Drive
   - Gong transcripts, via the Gong connector
   - Gong email summaries, via Gmail
3. Claude writes back a `meeting-material` draft per meeting. It contains:
   - Sources with links
   - a proposed summary
   - proposals with evidence locators and a "Not in your notes" flag
4. Adoption turns the draft into Sources and Review Items. The user's note body is never rewritten. An accepted summary is stored on the **meeting** object.

Each meeting carries an enrichment state: `none`, `requested`, `enriched`, `partial` or `gave_up`.

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

**v0.6 - capture paths and review rule.**
- **In the app:** Quick Capture creates an Inbox task owned by the user directly. The text is the user's own, so it needs no review. This confirms the code's behaviour.
- **Away from the Mac:** the user talks to Claude on the Android app, which has the Google Drive connector. The capture skill writes an **Inbox Draft** into `_inbox/drafts/`, and LifeOS adopts it when it next runs.
- **Review rule by origin:**
  - `user-dictated` drafts become objects directly.
  - `agent-extracted` drafts become Review Items.
  - Dictated low-risk changes to existing objects arrive as **Patch Drafts** and apply automatically, with an audit entry and undo. The low-risk fields are status, due date, priority and appended notes.
  - Meaning-changing edits are always reviewed.
- **Language:** agent outputs follow the language of the source.

### 4.6 Knowledge ingestion lifecycle

LifeOS should preserve the distinction between captured source material and distilled knowledge. Articles, PDFs, web clips, documents, transcripts, emails or personal captures may enter a raw inbox, be processed by AI, and produce one or more reusable Knowledge Notes. The raw source remains preserved and every synthesis keeps provenance links.

Recommended flow: Source -> Raw Inbox -> AI processing -> Knowledge Note(s) -> links to subjects/topics, projects, products, clients, people and related knowledge.

**v0.6 - Phase A sources.** Pasted text and web links only. Claude fetches the link text inside the skill and writes a `source` draft. Knowledge Notes the agent extracted go to review; Knowledge Notes the user dictated are created directly. Subjects are free-form and are normalised to an existing subject at adoption. PDFs, documents, audio and video come after Phase A.

## 05   Workspaces & navigation

### 5.1 Primary navigation

| **Workspace** | **Primary purpose** |
| --- | --- |
| Home / Today | Daily command center and focus view |
| Calendar | Events and entry point into meeting workspaces |
| Notes | Latest notes grouped by last-edited day, Open and Deleted tabs, keyword search, restore, and a note header for title and relationship editing (as built) |
| Tasks | My Tasks, Waiting On and context-based views |
| Projects | Project cockpits combining work, decisions, meetings and open questions |
| Clients | Ongoing client context across multiple projects/products |
| Products | Long-lived product context across build work and deployments |
| People | 1:1 history, outstanding commitments and involvement |
| Knowledge | Knowledge Notes, raw sources, topic/subject views, backlinks and linked research across contexts |
| Inbox | Items requiring review, classification or confirmation |
| Quick capture | Always-available text entry point; voice is converted to text externally before capture |
| System | Graph health diagnostics, advisory device lease and backup creation/verification (as built) |
| Settings | Google Calendar and Google Drive OAuth client credentials (write-only, stored in Keychain), calendar selection and default calendar (as built) |
| Decisions & Open Points (v0.6) | List with filters (project, client, product, person, status, date), detail, create, edit, supersede a decision, resolve or close an open point |
| Inbox drafts (v0.6) | Drafts awaiting adoption, failed drafts with path and reason, Adopt now, stale Work Orders |

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

**v0.6 - Daily Focus brief (section 13.4).** A scheduled Claude routine runs at **06:00 Europe/Paris on workdays**. It writes a `daily-focus` object and sends a read-only, 5-line Slack DM to the user.

The brief's section order:
1. **I owe:** due and overdue items, plus yesterday's meeting actions
2. **Top 3:** each with "why today" and an if-then slot
3. **Waiting on and pending decisions:** aged items only
4. **Meeting prep:** at most 3 meetings, each with an "ask"
5. **Day shape:** information only

The brief may add 1–3 "consider deferring" suggestions, for tasks only. It fits one screen.

The Today page:
- Overlays live status on the brief.
- Shows when the brief was generated.
- Offers a Refresh that writes a re-plan Work Order.
- Applies the user's app-owned **Focus Override** (pin, replace, dismiss).
- Falls back to the deterministic rule (priority, then due date) when no brief exists.
- Keeps all other panels computed live.

Inbox triage (email, Slack, Jira) stays in Steve's separate brief.

### 5.4 Calendar / meeting workspace

- Meeting metadata and contextual links at the top.
- Live Markdown-based note editor as the primary workspace.
- Previous context: recent decisions, open points and outstanding tasks related to the meeting context or attendees.
- Post-processing sections for summary, decisions, actions and open points.
- Source references and provenance for extracted items.
- Accept / edit / reject controls for AI suggestions.

**v0.8 - as built.** The meeting page shows its enrichment state in text, with missing and unavailable material and a **Give up** action (#87). The meeting and its note each have a **History** link and **Mark restricted / Mark normal** (#85, #86). When Google Calendar cannot be reached (network, sign-in or Keychain denied), Today and the calendar view list the meetings already stored in LifeOS under "Offline: showing meetings already in LifeOS (last synced …)" with **Retry**; nothing stored is changed while offline (#88, #94).

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

**v0.6 - People (section 13.6).**
- **Matching:** calendar attendees are matched to People by email. Unknown attendees are created with names taken from the email address; the calendar display name wins when there is one. They are flagged `unreviewed`, and merge suggestions are offered but never applied automatically.
- **Labels:** badges and pickers show the first name, or the full name when two people share a first name. People outside the internal domains (a setting, e.g. `example.com`) are external and shown as "Name - ext" in red, with the text always present.
- **Self person:** carries all of the user's work and personal addresses. **v0.7:** the addresses are entered in Settings → **My email addresses** and the internal domains in Settings → **Internal domains**; neither has a default in code. While either is empty, Today and System Health show a warning linking to the card (#54, #76).
- **Scope:** further external-people features come after Phase A.

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

**v0.6 - Obsidian's role.** The user does not use Obsidian today. Obsidian compatibility is a **portability guarantee**: files stay readable and valid outside the app and are friendly to LLMs. It is not a daily interface. Body links between objects use `lifeos://object/<id>` (PB-007), which Obsidian shows as plain text; this is accepted. Obsidian-specific features (Bases, graph views, wikilinks) are out of scope for Phase A.

### 6.4 Metadata model

Type describes what an item is (for example meeting-note or knowledge-note). Area is a broad life-domain tag (for example work, home, family, personal). Subject/topic describes what the content is about (for example Retail Media, Product Management or Home Automation). Subjects/topics remain metadata rather than first-class entities initially. Section 3.5 lists the Area values currently defined for the system (work, maintenance, household, learning, personal-projects, personal-growth).

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
data/                     (sibling of code/ and backups/, outside Git - ADR 0001)
    people/
    clients/
    products/
    projects/
    meetings/             meetings and their canonical meeting notes
    tasks/
    decisions/
    open-points/
    knowledge/
    sources/
    review-items/
    agent-runs/
    audit/
    connectors/           connector-account objects
    sync-runs/
    settings/             app-setting objects, one fixed-name file per group (ADR 0005)
                          v0.7: includes self-emails.md and internal-domains.md
    assets/
    _inbox/               (v0.6) agent-written files awaiting adoption - not objects
        drafts/           new captures and meeting material
        patches/          changes to existing objects
        requests/         app-written Work Orders for agent runs
        processed/        adopted drafts with a .result.md sidecar
        failed/           drafts that failed, with path-aware errors; never auto-deleted
    _agent/               (v0.6) derived, disposable Agent Index; never read back by the app
    .lifeos/
        session.md        advisory device lease
        operations/       incomplete-operation journals
        versions/<object-id>/   prior revisions kept on every guarded write (v0.7: last 10, ADR 0012)
```

**As built (v0.5).** The layout above is what the code writes. Differences from the v0.4 tree: `meetings/` holds both meeting and meeting-note files; `agent-runs/`, `connectors/`, `sync-runs/` and `settings/` are new; `archive/` is not used (archiving sets `archived_at` in place, ADR 0006); `recurring-items/` is not created because no recurring-item workflow exists; `.lifeos/schema.md` is not written by the code; `.lifeos/versions/` is new.

The hierarchy is intentionally shallow. Folders communicate object type and improve human navigation; they do not encode relationships. The root lives in the user's Google Drive data location and is kept outside the Git repository. Each computer configures its own absolute root path, while files store only portable relative paths and stable IDs.

**As built (v0.5).** The default layout is `LifeOS App/code` (Git), `LifeOS App/data` (authoritative Markdown) and `LifeOS App/backups`, as siblings in one Drive folder (ADR 0001). `LIFEOS_DATA_ROOT` and `LIFEOS_BACKUP_ROOT` override the paths. Object filenames follow ADR 0002: `YYYY-MM-DD-HHmm-descriptive-title--full-uuid.md`. The timestamp is the meeting's local time for meetings and notes, and the UTC creation time for other objects; the UUID in front matter, not the filename, remains the identity. Settings files are the one exception and use fixed names so two devices cannot create duplicates (ADR 0005).

For My Drive, mirrored storage is preferred because the files remain ordinary local files and are always available offline. If the chosen location is an actual Google Shared Drive, which is streamed rather than mirrored, the LifeOS directory must be marked available offline before the application uses it.

### 7.5 Two-computer synchronization and handoff

The supported v0.4 operating mode is one user on two trusted computers with sequential use. Both installations run locally against their synchronized copy of the same Google Drive data root. No central LifeOS service is required for this mode.

Safe handoff procedure:

1. Finish and close LifeOS on the current computer.
2. Confirm that Google Drive reports synchronization complete.
3. Move to the other computer and wait for incoming synchronization to complete.
4. Start LifeOS; it rescans changed files and validates the index before allowing writes.

`.lifeos/session.md` records the current device ID, start time, last activity and lease expiry as an advisory warning. Because a cloud-synchronized lease can arrive late, it is not the sole safety mechanism. Every save also checks the current file revision and content hash against the version originally opened. A mismatch creates a conflict for review instead of overwriting either version.

**As built (v0.5).** The lease lasts 5 minutes and is refreshed by a 60-second heartbeat and after each successful write. A second device that sees an unexpired foreign lease starts read-only: every write request is refused with HTTP 423 until the user takes over explicitly (ADR 0003). Stopping LifeOS (`pnpm stop`) releases the lease, so "finish and close LifeOS" in step 1 means stopping the stable app, not only closing the browser tab. A laptop that sleeps or crashes without stopping leaves its lease in place for up to 5 minutes. Google Drive sync-state diagnostics (confirming that synchronisation is complete before writes are enabled) are **not implemented**: the Drive connector is not built, so step 2 and step 3 remain manual.

Simultaneous editing is not supported in the initial version. If it becomes a requirement, add a dedicated synchronization or collaboration service rather than relying on shared-folder locking.

**v0.6 - agents and the lease.** Agents (the phone, cloud routines, Steve) never write object files, so they never compete with the lease holder. They write only new files into `_inbox/`. Drafts captured while no Mac is running wait there and are adopted at the next start. The Agent Index and the brief list them as "pending adoption", so they stay visible.

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

**As built (v0.5).** Implemented: atomic temp-file-then-rename writes with fsync; content-hash comparison against the version the caller opened; prior revisions saved to `.lifeos/versions/<id>/` before each guarded overwrite; revision increment, `updated_at` and `updated_by_device` on every application write; tolerant per-file scanning, so one malformed file is reported in System Health instead of stopping startup; soft delete through `deleted_at` and archive through `archived_at`; and idempotent journals for review acceptance and meeting creation, replayed at startup. Unknown front-matter keys survive round trips and the Markdown body is stored verbatim.

Known limits to close or accept:

- The conflict check compares the content hash only. `revision` is incremented but never compared on save.
- A write that supplies no `expected hash` (creates and some system records) replaces the target path without a conflict check.
- Front matter is re-serialised on every write, so key order and YAML comments in an externally edited file may change. [TBD - verify with a round-trip test.]
- The browser keeps unsent drafts in local storage and offers a side-by-side conflict panel and a one-shot undo of "keep disk version" (PB-002, PB-016 as delivered). This cache is disposable and never authoritative.

**v0.6 - safety prerequisites before any agent uses the vault** (from research #3):
- Path-aware diagnostics (U2).
- Duplicate-ID write blocking, with a deterministic winner (U3).
- A save conflicts when **either** the content hash **or** the revision differs.
- Prior-version capture and an `audit-event` (`actor_type: external`) when the watcher sees an external change (U4, U5).
- Review Item `operation_id`s generated only by the app (U7).
- UUIDv7 enforcement.

**v0.7 - as built.** All six prerequisites are built (#26–#30). The conflict check now compares revision as well as hash. Further changes from the build:
- **Version copies** are written atomically and only the last 10 per object are kept; the newest copy is the baseline for external-edit detection, including edits made while the app was closed (ADR 0012, #69, #72, #79, #80).
- **Creates** refuse an existing ID or an existing file (#58).
- **Crash recovery** follows one pattern: journal before the first write, role-keyed replay IDs, audits written once, one-at-a-time per key, exclusive file creation (ADR 0013).

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

**As built (v0.5).**

- The server is one Fastify process that serves both the API and the production web build on `127.0.0.1:4310`. Application use cases sit in `packages/application`; the composition root is `apps/server/src/main.ts`.
- The index is rebuilt in full after every write and, through a recursive file watcher on the data root (250 ms debounce, `.lifeos/` ignored), after any external change. It supports lookup by ID, backlinks derived from `*_id` and `*_ids` fields, and substring search over title and body. There are no secondary indexes and no incremental updates. The backlog already notes that the cost to watch is the full re-read after each save as the data grows.
- Google Calendar is the only live connector (read-only). Google Drive has stored credentials but no connector. Email and Slack are not started.
- The AI provider is the deterministic mock in `packages/ai` (see 12.2).

**v0.6 - AI processing layer.** For Phase A the AI layer is **Claude working through skills**, not an in-app provider. Claude uses the user's subscription and connectors: Calendar, Drive, Gmail, Gong, Slack. The app's AI-related jobs are:
- writing Work Orders
- adopting drafts
- keeping the Agent Index current
- recording `agent-run` and `audit-event` objects

The `AiProvider` port is kept for a later one-click in-app option (issue #5, deferred). The provider and key choice remain open and are not blocking. The skills pack is versioned with the code: Object Contract, capture, enrichment, daily focus, and ask. Its example drafts are test fixtures.

### 7.8 Editor architecture

Tiptap remains provisional. It edits the Markdown body only; application forms edit managed front-matter fields. A raw Markdown mode is mandatory. Before adoption, the editor must pass save/reopen tests covering Obsidian syntax, headings, lists, task lists, tables, code blocks, links, inline HTML, pasted assets and external edits. Tiptap JSON must never become a second source of truth.

If lossless round-tripping cannot be demonstrated, use a Markdown-native editor such as CodeMirror as the primary editor, with rich preview as a separate presentation layer.

**As built (v0.5).** The provisional Tiptap decision was not taken. The editor is **Milkdown Crepe**, a Markdown-native visual editor, with a raw Markdown mode and a rendered preview (`react-markdown` with GitHub-flavoured Markdown). It edits the body only; managed fields are edited through forms and the note header. No second JSON document is persisted. The formal lossless round-trip acceptance suite required above has **not** been completed: it is backlog item PB-003 (visual-editor quality pass). The existing tests cover unknown-Markdown preservation and draft conflicts only. Until PB-003 passes, treat visual mode as unproven for tables, task boxes, code blocks, inline HTML and Obsidian-specific syntax, and use raw mode when fidelity matters.

**v0.8 - as built (PB-003).** A fixture suite runs the real visual editor in CI (`tests/integration/editor-round-trip.test.ts`). Notes made only of proven constructs save byte-for-byte when unedited. Constructs the editor rewrites are listed as `KNOWN_FAILURES` (for example `-` bullets, `---` rules, unpadded tables); meaning is kept, the bytes change. Visual mode shows an **Unproven formatting** label naming them, and Markdown mode keeps the note exactly as written (#89). Images are never lost: if a save would drop one (Markdown or HTML `<img>`), Visual mode turns read-only for that note and says why (#91, #96). LifeOS writes its Summary section with blank lines so it round-trips; empty lines made in Visual mode no longer save as `<br />` (#96).

### 7.9 Backup and recovery

Google Drive synchronization is not the only backup. LifeOS periodically creates versioned, read-only snapshots or archives containing the Markdown root, assets and a checksum manifest. Retain multiple generations and run automated restoration tests. Secrets remain excluded because they are reconnected through each computer's Keychain.

**As built (v0.5).** `packages/backup-filesystem` writes read-only snapshots to `backups/` (ADR 0004). Each contains a `data/` tree and a `manifest.json` with path, size and SHA-256 per file. The session lease and temporary files are excluded. Ten generations are retained. A verification drill restores a snapshot into a temporary directory, checks every checksum and removes it, without touching live data. Creation and verification are triggered from the System view or the API. **There is no scheduler**: backups happen only when someone triggers them. Backups live in the same Google Drive folder tree as the data, so a Drive-wide failure or account loss affects both.

**v0.6 - decided.**
- **Schedule:** automatic backups at stable-app start, at stop and every 24 hours while running. A failure shows a persistent banner.
- **Second location:** a weekly copy of the latest verified snapshot goes to a local folder **outside Google Drive**, keeping 4 generations.
- **Why both:** Drive plus two Macs are **replicas, not backups**. A deletion or corruption syncs to all three. The Drive account is the employer's.
- **Exit plan:** copy the data folder and the latest verified backup to a personal location, re-enter credentials, and repoint the data root. This is reviewed with the data-root decision by **31 October 2026**.

**v0.8 - as built (#84, #95; ADR 0004, ADR 0005).**
- **When:** at app start, daily while running, and at a clean stop; only on the device holding the lease. Manual **Back up now** stays.
- **Off-Drive copy:** weekly, the newest backup that passes its checksums is copied, verified and made read-only; 4 kept. The folder is set **per Mac** (Settings → **Off-Drive backup folder**, "applies to this Mac only"). It must exist and must not be inside Google Drive, the data folder or the backup folder, checked after resolving links.
- **Warning:** a banner on Today and System Health, in text, when a backup or copy fails or none succeeded in 26 hours, with **Back up now**.
- **Prune rule:** the only good backup is never deleted.
- **Clean stop:** writes refused (503), HTTP closed, adoption allowed to finish, then the stop backup (35 s limit), then the lease is released; all within the stop script's 60 s.
- **One queue:** backups and adoption run one at a time, so a snapshot never holds half an adoption.

### 7.10 Future hosted architecture

If LifeOS becomes a simultaneous multi-user or always-online product, introduce PostgreSQL behind the existing ObjectStore/repository ports and move assets to object storage. Markdown remains an import/export and portability format. Authentication, tenant isolation, authorization, encryption and merge behavior must be designed before that transition. Stable IDs and explicit object contracts make this a controlled migration, but it is not automatic.

## 08   MVP & roadmap

> **v0.6 - roadmap restated as phases.** The MVP list below remains the historical baseline. The build plan is now:
> - **Phase A - work daily driver** (spec #21). Five epics in order:
>   1. Safety prerequisites + Inbox Drafts, Adoption and the skills pack
>   2. Enrichment Work Orders (Meet, Gong, Gmail)
>   3. Today with Daily Focus, Focus Override and the Slack brief
>   4. Decisions and Open Points workspace + People matching and labels
>   5. Hardening: automatic and off-Drive backups, macOS launcher, calendar offline fallback (PB-022b), editor round-trip suite (PB-003), browser tests
> - **Phase B - personal areas** (after the Phase A exit gate): migrate the personal rows of `actions.md` (#10), recurring tasks, Belongings (#9), personal calendar, Home Assistant, learning intake.
> - **Later:** the in-app LLM provider, email and Slack as task sources, PDF and media ingestion, semantic search, hosted or multi-user.
>
> **v0.8 - Phase A closes on the core.** On 4 October 2026 Rahul moved these out of epic 5 into Phase B (#90): the macOS launcher and start at login, the dyslexia-friendly font and dark theme, Playwright browser tests and the 10,000-object performance fixture. Each needs its own ticket before building.
>
> Section 8.2's "email and Slack" items and "recurring tasks" now sit in Phase B or Later as listed here.

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
| Superseded by v0.5 | Keep Tiptap provisional, require raw Markdown editing, and reject it if lossless Obsidian-compatible round-tripping cannot be demonstrated. The implementation uses Milkdown Crepe (Markdown-native) with raw and preview modes. The round-trip requirement stands and is tracked as PB-003. |
| Baseline | Opening a calendar event writes nothing. The meeting and canonical note are created on the first real edit; creation is idempotent and serialised per event (PB-020, PB-004). |
| Baseline | Object filenames use `YYYY-MM-DD-HHmm-descriptive-title--full-uuid.md`; the UUID in front matter is the identity (ADR 0002). |
| Baseline | The code repository, data root and backups are sibling folders: `code/`, `data/`, `backups/` (ADR 0001). |
| Baseline | The advisory device lease lasts 5 minutes; a foreign unexpired lease makes the app read-only until an explicit takeover; hash checks stay authoritative (ADR 0003). |
| Baseline | Backups are versioned, read-only, checksummed, restoration-tested and retained for ten generations (ADR 0004). |
| Baseline | Synced user preferences are `app-setting` Markdown objects in `settings/` with fixed filenames; device-specific preferences (display timezone, last view, pane widths, drafts) stay in browser storage (ADR 0005). |
| Baseline | The daily app is a stable background process on port 4310 serving the built UI and API with no file watcher reload; development runs on 5174/4311 with synthetic data and a mock calendar and never touches real data (ADR 0006). |
| Baseline | Archive sets `archived_at` in place through ObjectStore; files are not moved to an `archive/` folder (ADR 0006). |
| Baseline | Deleting a note sets `deleted_at` (tombstone) and keeps the file. Restore clears it, and is refused when the meeting already has a newer note (PB-021, PB-025). |
| Baseline | Google Calendar access is read-only (`calendar.readonly`) using OAuth with state and PKCE; tokens live in macOS Keychain. |
| Baseline | Area vocabulary: work, maintenance, household, learning, personal-projects, personal-growth. Goals and Habits are deliberately not modelled. Belonging is a domain term for owned things; its modelling is undecided. |
| Baseline | Product intent and prioritisation live in `docs/product-design/Product Backlog.md` using PB-IDs; implementation-ready work moves to GitHub Issues. |
| Baseline (v0.6) | Text Quick Capture creates an Inbox task directly because the user typed it; only AI-extracted or ambiguous items go through Review Items. Confirmed by Rahul on 3 October 2026. |
| Baseline (v0.6) | The deterministic Top 3 rule (priority, then due date) is the fallback when no Daily Focus brief exists for the day. |
| Baseline (v0.6) | Delivery is phased: Phase A (work daily driver) then Phase B (personal), behind a 4-week exit gate. A core-loop quality gate sits inside Phase A: 10 real meetings in 2 weeks, ≥70% of proposals accepted, ≤2 minutes of review per meeting, 0 commitments without review, Today opened on ≥8 of 10 workdays. |
| Baseline (v0.6) | Agents never write authoritative objects. They write Inbox Drafts into `_inbox/`, and the application adopts them: assigns IDs, resolves names, validates, files, routes and audits. Supersedes the 27 September charting decision on direct agent writes. |
| Baseline (v0.6) | Routing by `origin`: user-dictated items become objects directly; agent-extracted items become Review Items; meaning-changing edits are always reviewed. Dictated low-risk changes (status, due, priority, appended note) apply automatically through Patch Drafts, with audit and undo. |
| Baseline (v0.6) | Phase A AI is agent-first: Claude through skills, using the user's subscription and connectors. The in-app provider is deferred; the `AiProvider` port stays. Supersedes the 27 September decision for an in-app Claude API. |
| Baseline (v0.6) | Post-meeting enrichment is triggered manually ("Enrich last 48h") and produces a Work Order. Claude fetches Meet, Gong and Gmail material and writes back Sources and proposals. The user's note body is never rewritten. |
| Baseline (v0.6) | Daily Focus: a cloud routine at 06:00 Europe/Paris on workdays (desktop fallback) writes the brief and a read-only 5-line Slack DM. The app overlays live status. The agent owns the brief; the app owns the Focus Override. |
| Baseline (v0.6) | Claude chat reads a derived, disposable Agent Index in `_agent/`, regenerated after every write. Restricted objects are excluded. |
| Baseline (v0.6) | `origin` and `sensitivity` are added to the envelope. Restricted objects are excluded from agents, the brief, Slack and Work Orders. This is an instruction-level control, not a lock. Finance and health are linked out, not run in LifeOS. |
| Baseline (v0.6) | One vault for now, split-ready. Area is validated, and a split is reviewed by 31 October 2026. |
| Baseline (v0.6) | People: attendees are matched by email; names come from the display name or the email; the label is the first name, or the full name on a clash; internal domains are a setting (e.g. `example.com`); external people are shown as "- ext" in red. Merges are never automatic. |
| Baseline (v0.6) | Decisions and Open Points get a minimal workspace and lifecycle: supersede a decision; resolve (with a summary or decision) or close an open point. |
| Baseline (v0.6) | Backups run automatically at start, at stop and daily, with a weekly off-Drive local copy (4 generations) and a documented exit plan. The stable app gets a macOS launcher and an optional start at login. |
| Baseline (v0.6) | AI outputs follow the language of the source. The UI stays in English. The visual design is neutral (not the employer brand) and dyslexia-friendly. |
| Baseline (v0.6) | Work actions start fresh (no `actions.md` import). Personal rows move in Phase B (#10). |
| Baseline (v0.7) | A brief may list up to 5 Top 3 items; Today shows at most the Max must-dos setting (1–5, default 3). An over-long brief is adopted with a length warning (commits `0c4bdab`, `f1696af`). |
| Baseline (v0.7) | A meeting is restricted when the meeting or its note is restricted. Today panels, Decisions and Open Points show restricted items with a lock badge; brief sections hide them and show a count; a restricted task is never in the Top 3 (ADR 0010, #63, #64). |
| Baseline (v0.7) | Version history keeps the last 10 copies per object (ADR 0012). |
| Baseline (v0.7) | Every multi-file step follows one crash-recovery pattern; a recorded user intent (such as a reject) wins over the operation it undoes (ADR 0013). |
| Baseline (v0.7) | A decision gains its `supersedes` link once, while it is active (#67). |
| Baseline (v0.7) | Self addresses and internal domains are user settings, never code (#54, #76). Connection status never reads Keychain secret values (#77). |
| Baseline (v0.8) | Backups run automatically at start, daily and at a clean stop, with a weekly off-Drive copy set per Mac (keyed by device ID in the synced setting). Backups and adoption share one queue; the stop sequence is bounded below the 60 s force-stop (ADR 0004, ADR 0005, #84, #95). |
| Baseline (v0.8) | Restoring an old version never changes sensitivity or review state, and is refused if the object changed since the History panel opened (#92). |
| Baseline (v0.8) | The calendar offline fallback lists meetings already stored in LifeOS rather than keeping a separate event cache. The demo calendar is used only in explicit mock mode (#88, #94). |
| Baseline (v0.8) | The morning routine sends (not drafts) a read-only Slack DM to Rahul only; never on replan (#51). Working hours for the day shape are assumed 09:00–18:00 [TBD - confirm]. |
| Baseline (v0.8) | Client meeting content is not enriched until IT/legal sign-off [TBD]; only an edit to the skill file opens the gate. With no internal domains set, enrichment refuses every non-synthetic meeting (#50, #93). |
| Baseline (v0.8) | Agents never write into `_inbox/processed/`, except to move a Work Order they have finished there from `_inbox/requests/` (#93). |
| Baseline (v0.8) | Launcher, dyslexia-friendly font, dark theme, Playwright and the performance fixture move to Phase B (#90). |

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
| Visual editor rewrites valid Markdown | v0.8: suite built; the **Unproven formatting** label warns, and images are never lost (7.8). Earlier text: complete the round-trip suite (PB-003); keep raw mode available; the editor is already Markdown-native (Milkdown Crepe), so the fallback is a CodeMirror source editor with separate preview. |
| Core loop is not yet proven with real AI | The AI provider is a deterministic mock that returns three fixed proposals. The success test in 9.4 cannot be passed until a real provider, evidence fragments and transcript/Drive input exist. |
| Calendar day goes blank when Google is unreachable | Failures are now visible (Reconnect banner, last sync time, failed Sync Runs). v0.8: Today and the calendar list meetings already stored in LifeOS under an Offline banner with Retry (#88, #94). Events never opened in LifeOS do not show while offline. |
| Full index rebuild after each save | Fine at current size; plan incremental updates before the data grows by an order of magnitude. |
| Two local servers write the same data root | The lease does not cover this. Development mode is isolated by port and synthetic data (ADR 0006); never run dev against `../data`. |
| Keychain helper depends on a compiled Swift binary | v0.7: the helper is built into an owner-only folder (`~/Library/Application Support/LifeOS/keychain-helper`), named by a hash of its source and checked before every run (#23). A new computer still needs the Xcode command-line tools (`swiftc`). |
| Backups share the Drive fate of the data | See 7.9. |
| Duplicate-canonical-note diagnostic may fire after a note is deleted and recreated | The index counts every non-archived meeting note, including tombstoned ones. [TBD - verify; exclude `deleted_at` in the duplicate check if confirmed.] |
| PB-ID collisions in the backlog | PB-015 and PB-016 were reused in Git history for delivered work and also exist as Later items. [TBD - renumber.] |
| Agent drafts never adopted when no Mac runs for days (v0.6) | Drafts stay visible as "pending adoption" in the Agent Index and the brief. The app shows the count at start. |
| Skill text drifts from the adoption code (v0.6) | Skill examples are CI fixtures run through adoption. v0.8: built (`tests/integration/skill-fixtures.test.ts`), part of the normal CI test step. |
| Cloud routines may lack the Gong or Slack connectors (v0.6) | [TBD - verify]. Fallback: a desktop scheduled task. |
| Client contracts may not allow client meeting content to go to Claude (v0.6) | v0.8: the enrichment skill refuses client meetings until IT/legal sign-off [TBD - confirm with employer IT/legal]. |
| A restricted object is read by an agent anyway (v0.6) | `sensitivity` is an instruction, not a lock. Truly sensitive material stays out of the vault. |
| The vault lives in the employer's Drive account (v0.6) | Weekly off-Drive copy, exit plan, and a data-root review by 31 October 2026. v0.8: the off-Drive copy is built; Rahul must set a folder on each Mac. |
| Repeated Keychain prompts (v0.7) | Status no longer reads secrets (#77). Calendar sync and connect still read them; choose "Always Allow" for the LifeOS helper. |

### 9.3 Open design questions

**Resolved in v0.6** (kept for traceability):
- Subject/Topic vocabulary: free-form, normalised to existing subjects at adoption.
- Raw-source capture order: pasted text and web links in Phase A; PDF and documents after.
- Area enforcement: validated. Belonging: Phase B, decided in issue #9.
- AI provider for meetings: Claude through skills (agent-first). The in-app provider is deferred.
- Quick Capture: a direct Inbox task.
- Backups: scheduled, plus a weekly off-Drive copy.
- Stable app: a double-clickable macOS launcher with optional start at login.
- Decisions and open points: they get a minimal workspace.

**Still open:**
- What cadence and scope should future maintenance agents use for backlink suggestions, contradiction detection, stale-item review and synthesis?
- Does syncing professional information through the employer Google Drive account, and sending client meeting content to Claude, comply with employer and client policies? [TBD - confirm with employer IT/legal; data-root review due 31 October 2026.]
- When hosted, what authentication, encryption, credential storage and separation rules are required for professional versus personal information?
- Which LLM provider and key would the deferred in-app provider use? [TBD - Rahul to check; not blocking.]
- Can cloud routines use the Gong and Slack connectors, and write files into Drive? Can the phone's Drive connector write drafts? [TBD - verify in the skills dry-runs.]
- What are Rahul's working hours for the day shape? The morning skill assumes 09:00–18:00. [TBD - confirm.]
- Do macOS file-watch events fire reliably for Drive-synced files? [TBD - verify on Rahul's Mac; restart and full rescan is the fallback.]

### 9.4 Recommended next design steps

**v0.6 - superseded by the Phase A plan.** The working plan is now the five Phase A epics in section 8 and the tickets created from spec #21. Earlier v0.5 items are absorbed as follows:
- Item 1 (real AI provider) is replaced by agent-first skills.
- Items 2 and 3 (PB-022b, PB-003) are in epic 5.
- Item 4 is resolved in 9.3.
- Item 5 (Drive connector) is replaced by agent-side fetching in epic 2.
- Items 6, 7 and 9 are in epics 4 and 5.
- Item 8 (CI) stands: on or after **19 October 2026**, check the first Ubuntu 26 run.

Done in v0.5 and removed from this list: repository scaffold and first push, Markdown schemas and validators, the four ports, UUIDv7/revisions/hashes/atomic writes/tombstones/graph validation, Keychain SecretStore, advisory lease and conflict handling, the first vertical slice (with the mock AI), the second vertical slice (raw text to Knowledge Note, with the mock AI), and the snapshot/restore drill.

1. Replace the mock AI with a real provider adapter behind the existing `AiProvider` port, with prompt versions, field-level evidence fragments and agent-run records. Start with the user's note alone, then add transcripts and linked Drive documents.
1. Make the calendar resilient: persist last synced events per day and show them as stale when Google is unreachable (PB-022b).
1. Complete the Markdown round-trip suite for the visual editor (PB-003), then add note history and restoration from `.lifeos/versions/` (PB-011).
1. Decide the open items in 9.3 on Quick Capture, Area enforcement, Belonging and backup schedule, and reflect each decision here.
1. Build the Google Drive connector and handoff diagnostics (PB-009) so the two-computer procedure in 7.5 can verify sync completion instead of relying on discipline.
1. Add LifeOS link navigation (PB-007), searchable relationship pickers on every object form (PB-010) and note search filters beyond keywords (PB-005).
1. Add a decision and open-point workspace if the open question in 9.3 resolves that way.
1. Close the CI items: move the GitHub Actions to Node 24-compatible versions, and on or after **19 October 2026** check the first run on Ubuntu 26 (`ubuntu-latest` migrates that day), pinning `ubuntu-24.04` if anything breaks.
1. Add browser (Playwright) tests and a fixture-validation job to CI, as 10.5 requires.
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
| `app-setting` | setting_key (added in v0.5; for example `settings/calendar-preferences.md` holds disabled calendar IDs and the default calendar) |
| `focus-override` (v0.6) | focus_on, pinned_task_ids, replaced (old → new), dismissed_task_ids. App-owned, one per date. |

**v0.6 field additions.**
- **Envelope:**
  - `origin`: `app | user-dictated | agent-extracted | calendar | imported | external`. Set at creation and never changed; missing means `app`.
  - `sensitivity`: `normal | restricted`.
- **`meeting`:** `enrichment_state` (`none | requested | enriched | partial | gave_up`). The body holds the accepted AI summary; the meeting-note body stays the user's.
- **`person`:**
  - `review_state` (`unreviewed | reviewed`)
  - `is_external`, derived from the email domain, with a manual override
  - email `identifiers`; the self person holds all of the user's addresses
- **`decision`:** status `active | superseded`.
- **`open-point`:** status `open | resolved | closed`. Resolved requires `resolution_summary` or `resolution_decision_id`.
- **`daily-focus`:**
  - `generated_at`
  - `i_owe`
  - `top3` (task ID, why_today, if_then)
  - `waiting_and_decisions`
  - `meeting_prep` (at most 3)
  - `day_shape`
  - `defer_candidates` (tasks only)
- **`review-item`:** new `review_type` values: `update`, `link-resolution`, `person-merge`, `summary`. Proposals may carry `missed_in_notes`.
- **`source`:** new `source_type` values: `meet-transcript`, `meet-recording`, `gong-call`, `gong-summary-email`, `drive-doc`, `web-link`, `pasted-text`. Upserted by provider and external ID.
- **Inbox Draft and Patch Draft formats** are contract files, not objects. They are specified in spec #21 and the Object Contract.

Assets remain binary files with their identity and metadata carried by the referencing object's asset entry or, when independently addressable, a small `asset` Markdown object.

**As built (v0.5).** The runtime schema (Zod, in `packages/domain`) lists 19 object types: the 18 above plus `app-setting`. It enforces the envelope on every object and a smaller set of type-specific fields than this table lists. The schemas are intentionally loose, so any field in the table that is not enforced is still stored and preserved. In particular `source_ids`, `source_meeting_id`, `expected_output`, `rationale`, `importance` and most `external_refs` details are conventions rather than validated fields. The JSON schemas under `schemas/objects/` cover the envelope, the task and the domain objects; the only fixture is a synthetic self person. `daily-focus` and `recurring-item` exist as types but no code creates them. Assets are managed images only (PNG, JPEG, GIF, WebP; 10 MB limit; de-duplicated by SHA-256; relative links); PDFs and recordings are not handled.

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

**As built (v0.5) - enforcement status of these rules.**

| **Rule** | **Status** | **Where** |
| --- | --- | --- |
| Unique IDs, broken references, type mismatches | Enforced as System Health diagnostics for the known relationship fields (`meeting_id`, `owner_person_id`, `primary_*_id`, `attendee_ids`, `people_ids`, `dependency_ids` and similar) | `index-memory` |
| Affected writes are blocked while a diagnostic exists | Not implemented [TBD - verify] | - |
| At most one self person | Flagged if more than one; one is created on demand if none exists | `index-memory`, `application` |
| One canonical note per meeting | Flagged, but tombstoned notes are counted (see 9.2) | `index-memory` |
| Task status, priority, due fields, waiting-for rule, completed/cancelled timestamps, self-dependency | Enforced on every write | `domain` task schema |
| Decision cannot supersede itself | Enforced | `domain` |
| One Area per object | Not enforced; `area` is a free string and Area values are not validated | - |
| Review item evidence shape | Validated (`source_id` and `fragment_id`) | `domain` |
| Evidence fragment must belong to the same source | Not enforced [TBD - verify] | - |
| Provider/external-ID uniqueness | Enforced on `provider:external_id`; the connector account is not part of the key | `index-memory` |
| Idempotent, recoverable review acceptance and meeting creation | Implemented with operation journals and startup recovery | `object-store-markdown`, `application` |
| Generic entity self-links | Not applicable; there is no `entity_links` structure | - |

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
code/                          (Git repository root; sibling of data/ and backups/)
    apps/
        web/                   React 19 + Vite 7 UI
        server/                Fastify API and composition root
    packages/
        domain/                types, Zod schemas, UUIDv7
        application/           use cases and ports
        contracts/             shared API types (minimal)
        object-store-markdown/ Markdown store, operation journal, device lease
        index-memory/          rebuildable index and graph validator
        assets-filesystem/     managed images
        backup-filesystem/     checksummed snapshots and restore drill
        connectors/            Google Calendar and mock calendar
        ai/                    deterministic mock AI
        secrets/               macOS Keychain (Swift helper) and in-memory store
        shared/
    schemas/
        objects/               JSON schemas (envelope, task, domain objects)
        fixtures/              synthetic fixtures (one self person)
    scripts/                   stable launcher, duplicate-meeting reconcile, dev seed
    tests/
        integration/           17 files
    docs/
        agents/                issue tracker, triage labels, domain-doc pointers
        architecture/          architecture baseline and MVP gap analysis
        decisions/             ADRs 0001-0006
        product-design/        this document and the Product Backlog
    .github/workflows/ci.yml
    .env.example
    .gitignore
    AGENTS.md  CLAUDE.md  CONTEXT.md  README.md
```

**As built (v0.5).** Differences from v0.4: there is no `tests/unit/` or `tests/fixtures/` (web unit tests sit beside their source in `apps/web/src`); `packages/backup-filesystem` is new; `scripts/`, `docs/agents/`, `AGENTS.md`, `CONTEXT.md` and `CLAUDE.md` are new; and the repository is the `code/` folder rather than a standalone `lifeos/` root. The copy of this document in `docs/product-design/` must be kept identical to the copy in Drive. Issues are tracked in GitHub Issues with the default five-label triage vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).

Canonical repository:

- SSH: `git@github.com:Rahuldharod/LifeOS.git`
- Web: <https://github.com/Rahuldharod/LifeOS>

**As built (v0.5).** CI (GitHub Actions on every push and pull request) runs install with a frozen lockfile, typecheck, tests and build. It does not yet run browser tests, validate synthetic fixtures against the JSON schemas as a separate step, or run explicit restore tests (the backup test covers restore). The pnpm version is pinned in `package.json`.

Git contains code, versioned object schemas, synthetic fixtures, tests, documentation and example configuration. It excludes `.env` files, user Markdown, assets, raw sources, backups, logs, temporary files, local indexes and real personal or client content. GitHub push protection should be enabled before the first meaningful push. CI validates all synthetic objects, rebuilds an index from fixtures, checks relationship integrity, runs file-operation recovery tests and executes unit, integration and browser tests.

### 10.6 Secret-storage contract

The local macOS implementation uses Keychain for OAuth access/refresh tokens, API keys, session-signing keys and future encryption keys. Use a stable service name such as `com.lifeos.local` and distinct account keys such as `google:<account-id>:refresh-token`. Work credentials should be configured as non-synchronizing when organizational policy requires them to remain on the device. Each computer establishes its own local secret entries for the same opaque references.

**v0.7.** The helper now lives in an owner-only folder, `~/Library/Application Support/LifeOS/keychain-helper/`, named by a hash of its Swift source, compiled to a temporary name and renamed into place, and checked (owner, not group- or world-writable) before every run (#23). Connection status is answered from what the app has already seen (a probe at start, a Retry, and every later read or write), so loading the app or saving a setting never shows a Keychain prompt. A denied prompt shows "Keychain access denied" with a Retry on the Connections card (#77).

**As built (v0.5).** Keychain access goes through a small Swift helper that the code compiles on demand to `/private/tmp/lifeos-keychain-helper-v1` and calls with the secret passed on standard input, so values never appear in command arguments. The service name is `com.lifeos.local`. Account keys follow `google:default:client-id`, `google:default:client-secret`, `google-drive:default:client-id`, `google-drive:default:client-secret` and a per-account token entry. Client ID and secret are entered once on the Settings page, are write-only, and the secret field is cleared after saving. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables are an optional development bootstrap that copies into Keychain. Whether work credentials are stored as non-synchronising items is not set in the code. [TBD - verify against organisational policy.] The connector-account object records provider and scopes only; token values are never written to Markdown.

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

**As built (v0.5).** Front-matter scanning, tolerant per-file diagnostics, full graph validation at startup, backlink derivation and a file watcher are implemented. Bodies are loaded with the front matter (no lazy body loading). Incremental revalidation, secondary indexes and numbered schema migrations are not implemented; every object is at `schema_version: 1`.

### 10.8 Provisional technical stack

| **Layer** | **v0.4 baseline** | **As built (v0.5)** |
| --- | --- | --- |
| Interface | React + TypeScript + Vite | React 19, TypeScript, Vite 7 - as designed |
| Styling | Tailwind CSS + shadcn/ui + Lucide | Custom CSS (accepted deviation) |
| Navigation | React Router | Local view state remembered per device; no routable deep links (accepted deviation) |
| API state | TanStack Query | Direct server-state loading in `App` (accepted deviation) |
| Editor | Tiptap only if round-trip tests pass; raw mode required | Milkdown Crepe, raw Markdown mode and `react-markdown` preview (see 7.8) |
| Calendar | FullCalendar Standard behind an adapter | Custom timezone-aware day timeline behind the `CalendarConnector` port (accepted deviation) |
| Local service | Node.js + TypeScript + Fastify, localhost | Fastify 5, TypeScript run with `tsx`, bound to `127.0.0.1`; serves API and built UI on one origin |
| Persistence | Typed Markdown ObjectStore + filesystem assets + in-memory IndexStore | As designed |
| Validation | Shared versioned runtime schemas | Zod 4 schemas in `packages/domain`, plus JSON schemas in `schemas/` |
| Package manager | Not specified | pnpm workspaces via Corepack, version pinned in `package.json` |
| Verification | Type checking, Vitest, integration tests and Playwright | Type checking, Vitest (17 integration files and 8 web unit-test files; 88 test cases counted in source) and CI. No Playwright yet. |

The Fastify service serves the built Vite application on one local origin (as built; CORS is enabled only for the Vite development origin). The React UI communicates through versioned API contracts and never receives filesystem paths that it can write directly. The prototype should use the same contracts with a mock API rather than creating a separate browser-local persistence model.

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

## 12   Implementation status & deviations

This section compares the design with the code on `main` of `Rahuldharod/LifeOS` (39 commits, 21 September to 3 October 2026, head `e981138`). It is a point-in-time audit; the code and the Product Backlog remain authoritative for day-to-day status.

### 12.1 Bottom line

- **The persistence and safety foundation is built and is stronger than the MVP text required**: atomic writes, hash checks, prior versions, tombstones, journals with recovery, lease, backups with restore drills, Keychain secrets.
- **The calendar-to-note half of the core loop works with real Google Calendar data.** The note-to-structured-outputs half works only with a deterministic mock AI, so the core loop is **not yet proven** against the 9.4 success definition.
- **The next decision that matters is the AI provider.** Every remaining MVP gap that affects the success test (transcripts, Drive documents, field-level evidence, meeting prep) sits behind it.

### 12.2 Status against the design

Status key: **Built**, **Partial**, **Mock** (works end to end with fake logic), **Not started**.

| **Area** | **Design reference** | **Status** | **As built / gap** |
| --- | --- | --- | --- |
| Markdown object store, envelope, UUIDv7, revisions | 3.4, 7.3, 7.6 | Built | Hash-guarded atomic writes; prior versions; tolerant scan. Limits in 7.6. |
| Graph validation and System Health | 7.2, 10.3 | Partial | Duplicates, missing targets, type mismatches, self person, canonical note, external refs. Several rules not enforced (10.3). |
| In-memory index, backlinks, search | 7.7, 10.7 | Partial | Full rebuild only; substring search; no secondary indexes. |
| File watcher and reconciliation | 7.7 | Built | Debounced full rebuild on any external change. |
| Two-device handoff | 7.5 | Partial | Lease, read-only mode and takeover built. Drive sync-state diagnostics not built. |
| Backups and restore drill | 7.9 | Partial | Built and tested; manual only, no schedule, same Drive tree. |
| Secrets in Keychain | 10.6 | Built | Swift helper; write-only Settings entry. |
| Google Calendar | 4.1 step 1, 7.7 | Built | Read-only OAuth with PKCE; multi-calendar selection; timezone-aware day timeline; Sync Run records; Reconnect banner on token failure. No offline fallback (PB-022b). |
| Google Drive / Meet transcripts | 4.1 step 4 | Not started | Credentials can be stored; no connector, no transcript or document fetch (PB-009). |
| Meeting workspace | 4.1, 5.4 | Built | Non-persisting open, create on first edit, one canonical note, header editing of title, project, client, product and people, review controls. No "previous context" panel [TBD - verify]. |
| Editor | 7.8 | Partial | Milkdown visual, raw and preview modes; image paste and drop; round-trip suite pending (PB-003). |
| Notes workspace | 5.1 | Built | Day-grouped list, Open/Deleted tabs, all-words search ignoring case and accents, delete as tombstone, restore (PB-021, PB-023 to PB-025). |
| AI processing of meetings | 4.1 steps 5-6 | Mock | Returns one task, one decision and one open point per note, with fixed titles. No provider, no transcript, empty field evidence. |
| Review Items | 4.3, 10.2 | Partial | Create-type proposals for task, decision, open point and knowledge note; edit title; accept (idempotent, recoverable); reject. No review types for links or meaning-changing edits. |
| Agent runs and audit events | 10.2 | Built | Agent-run and append-only audit objects written for key operations. |
| Tasks | 4.3, 4.4, 5.5 | Partial | Create, edit, soft delete; status, owner, waiting-for, due date or time, priority, expected output. List view with Today groupings. No dependency editing, saved views or Waiting On by person [TBD - verify]. |
| Decisions and open points | 3.1, 5.6 | Partial | Created only by accepting a review; shown in project roll-ups. No create, edit or list workspace. |
| Today / Home | 5.2, 5.3 | Partial | Overdue, due today, upcoming, waiting, review count and Top 3 with a reason. Top 3 is a priority-then-due-date rule, not AI, and cannot be pinned or replaced. No next-meeting preparation and no open-question panel. |
| Quick Capture | 4.5 | Partial | Creates an Inbox task owned by the user directly, with no context inference and no review step. See 9.1. |
| Projects, clients, products, people | 5.6, 5.7 | Partial | Full create/edit/soft delete. Project cockpit shows tasks, meetings, decisions, open points and people. Client, product and person roll-ups exist. No "Brief me". |
| Knowledge and raw sources | 4.6, 5.1 | Mock | Pasted text becomes a Source with one fragment and a proposed Knowledge Note, accepted through review. Retrieval is keyword search. No files, PDFs, web clips or topic/subject views. |
| Obsidian compatibility | 6.3 | Built | Plain Markdown and front matter; relative image links. External edits are picked up by the watcher. LifeOS link navigation inside the app is not built (PB-007). |
| Assets | 7.1 | Partial | Managed images only. |
| Area, Subject, Tag | 6.4 | Partial | Stored as fields; no controlled vocabulary and no subject or tag views. |
| Recurring items, daily focus, saved views | 8.2 | Not started | Types exist in the schema list; no behaviour. |
| Email and Slack | 8.2 | Not started | As planned. |
| Hosted / multi-user | 7.10 | Not started | As planned. |

### 12.3 Accepted deviations from v0.4

| **Topic** | **v0.4 said** | **Code does** | **Why it is acceptable** |
| --- | --- | --- | --- |
| Editor | Tiptap, provisional | Milkdown Crepe plus raw mode | Markdown-native; avoids a second JSON source of truth. Round-trip proof still owed. |
| Styling, routing, API state, calendar widget | Tailwind/shadcn, React Router, TanStack Query, FullCalendar | Custom CSS, local view state, direct loading, custom day timeline | Sufficient for the current scope; revisit if deep links or cache invalidation become necessary. |
| Archive | `archive/` folder | `archived_at` set in place | Moving files would bypass hash checks and the scan reads every folder (ADR 0006). |
| Folder tree | As 7.4 in v0.4 | Adds `agent-runs/`, `connectors/`, `sync-runs/`, `settings/`, `.lifeos/versions/`; no `archive/`, no `recurring-items/` | Recorded in 7.4. |
| Runtimes | One local app | Stable app on 4310 and isolated development on 5174/4311 | Prevents code reloads mid-note and writes to real data from dev (ADR 0006). |
| Settings | Not specified | Synced `app-setting` objects, device preferences in browser storage | ADR 0005. |
| Quick Capture | Same review rules as any text input | Direct Inbox task | The text is the user's own; proposed as a decision in 9.1. |
| Top 3 | AI-suggested | Deterministic rule | No AI provider yet. |
| Tests | Unit, integration and Playwright | Integration plus web unit tests, no browser tests | Playwright is still to be added. |

### 12.4 Delivered since the first MVP build (from the Product Backlog)

Delivered items, newest first, with their backlog IDs: PB-006 note header editing; PB-024 and PB-024b window-fitting layout and resizable editor; PB-023 day-grouped notes; PB-025 Open/Deleted tabs, search and restore; PB-004 duplicate-meeting prevention and repair; PB-001 stable launcher and isolated dev mode; PB-021 note deletion; PB-022a visible Google token failure; PB-020 save-on-first-edit; PB-019 and PB-017 interface fixes; PB-002 autosave recovery and conflict panel. The calendar preferences feature (calendar selection and default) shipped without a backlog ID. The backlog is the source for what remains: Next holds PB-003, PB-005, PB-007 to PB-011, PB-018 and PB-022b; Later holds PB-012 to PB-016.

### 12.5 What to do with this

- Treat 9.4 as the working plan. Its first item, a real AI provider, unblocks the success test.
- Resolve the open items in 9.3 that change the design text (Quick Capture, Area enforcement, Belonging, backups) so the next revision can drop the `[TBD]` markers.
- When the code changes a stated contract, update this document and `docs/product-design/` together and bump the version.

### 12.6 Phase A build status (v0.7, updated v0.8)

Tables 12.1 to 12.5 describe `main` at `e981138` and are kept as they were. **v0.8:** this table describes the final Phase A build, branch `feature/phase-a-close-21` at `00d2306` (4 October 2026). The story-by-story view is in the PRD, section *Build status*.

| **Area** | **Status** | **As built / gap** | **Tickets** |
| --- | --- | --- | --- |
| Safety prerequisites | Built | Path diagnostics, duplicate-ID blocking, revision check, UUIDv7, external-edit history, create refuses existing IDs | #26–#29, #58, #69 |
| Envelope: origin, sensitivity, area | Built | Validated on write; legacy Area values warn. v0.8: **Mark restricted / Mark normal** on Decisions, Open Points and meetings | #30, #86 |
| Inbox Drafts and Adoption | Built | Auto-adopt on start, on new draft and on "Adopt now"; name resolution; routing by origin; replay-safe | #31–#35, #59 |
| Patch Drafts | Built | Auto-apply, review routing, conflict rule against the target's content, undo | #36, #37, #61, #71, #81 |
| Review Items | Built | `update`, `link-resolution` (card with picker and create-and-link), `person-merge`, `summary`; atomic accept; crash-safe reject | #57, #62, #65, #82 |
| Enrichment | Built | Work Order, enrichment state shown in text with missing and unavailable material, Give up, stale flag, meeting-material adoption, summary between markers. Skill `lifeos-enrichment` with the client-content gate | #44, #45, #50, #66, #87, #93 |
| Daily Focus and Today | Built | Brief with live overlay, Refresh, Focus Overrides, live panels, settings, lock badges (meeting or note), "Show N more". Skill `lifeos-morning` writes the brief and sends the Slack DM | #46–#48, #51, #64, #92 |
| Agent Index | Built | `_agent/` files; restricted objects counted only. Skill `lifeos-ask` | #43, #49, #63 |
| Skills pack | Built, not installed | Five skills in `skills/`; every example adopted by the real code in CI. Install and dry-run by Rahul | #49–#51 |
| Decisions and Open Points | Built | Lists, filters, create, edit, supersede, resolve, close | #41, #42, #67 |
| People | Built | Email matching, names, labels, external marker, "unreviewed" marker, merges, self addresses and internal domains in Settings | #38–#40, #54, #76, #87 |
| Version history and recovery | Built | Last 10 copies per object; one crash-recovery pattern. v0.8: History panel with **Restore this version** on every object; restore keeps sensitivity and review state | #72–#75, #78–#80, #85, #92, ADR 0012, ADR 0013 |
| Keychain | Built | Owner-only helper folder; status without secret reads; Deny shows a Retry; a denial at start shows the offline calendar, never demo meetings | #23, #77, #94 |
| Backups | Built | Automatic at start, daily and clean stop; weekly off-Drive copy per Mac; failure banner; safe stop; shared queue with adoption | #84, #95, ADR 0004 |
| Calendar offline fallback (PB-022b) | Built | Stored meetings under an Offline banner with Retry | #88, #94 |
| Editor round-trip suite (PB-003) | Built | In CI; **Unproven formatting** label; images never lost; Summary section round-trips | #89, #91, #96 |
| Code cleanup | Open | Shared settings helper, calendar mapping, banner components; no behaviour change | #97 |
| macOS launcher, start at login | Phase B | Terminal commands only (ADR 0006) | #90 |
| Playwright tests, 10,000-object fixture | Phase B | Integration tests only | #90 |
| Dyslexia-friendly font option, dark theme | Phase B | — | #90 |

## 13   Phase A design (v0.6)

This section summarises the design settled on 3 October 2026. The buildable detail — 95 user stories, implementation decisions, test seams and out-of-scope — is in spec [#21](https://github.com/Rahuldharod/LifeOS/issues/21) (local copy `LifeOS_PRD_Phase-A_v1.0.md`).

### 13.1 Bottom line

- **LifeOS is the single source of truth for work commitments.** The app is the interface and the validator. Claude is the AI layer.
- **One rule makes agents safe:** agents draft, the app writes. Every agent (phone, cloud routine, Steve) uses the same Inbox Draft path and the same validator.
- **No API credits in Phase A.** Enrichment, extraction and the daily brief run through Claude skills with the user's connectors.

### 13.2 Inbox Drafts and Adoption

| **Step** | **Behaviour** |
| --- | --- |
| Write | The agent writes a short Markdown draft into `_inbox/drafts/`: kind, `draft_key`, origin, title, references *by name*, and body. |
| Trigger | Adoption runs at app start, on a watcher event, or on "Adopt now". Files modified less than 2 seconds ago are skipped. |
| Resolve | Names are matched case- and accent-insensitively; people by email first. Ambiguous names create a `link-resolution` Review Item and are never guessed. |
| Create | The app assigns the UUIDv7 and envelope, names the file per ADR 0002, and inherits context from any referenced meeting. |
| Route | `user-dictated` → object. `agent-extracted` → Review Item. Person → `unreviewed` plus merge suggestions. |
| Record | One `agent-run` per batch and one `audit-event` per result. The draft moves to `processed/` or `failed/` with a `.result.md` sidecar. |
| Patch | Patch Drafts target an object by ID or exact title. Dictated low-risk fields auto-apply with undo. Meaning-changing edits, and conflicting patches, become `update` Review Items. |

### 13.3 Enrichment

"Enrich last 48h" covers ended meetings from the last 48 hours: non-all-day, not declined, not yet enriched, including meetings without notes. The flow:
1. The app writes a Work Order to `_inbox/requests/`.
2. Claude runs the enrichment skill: Meet via calendar and Drive, Gong via its connector, summaries via Gmail.
3. Claude writes `meeting-material` drafts.
4. Adoption upserts Sources, creates `summary` and proposal Review Items with evidence and the "Not in your notes" flag, and sets `enrichment_state`.

Work Orders left unprocessed for 7 days are flagged stale.

### 13.4 Daily Focus and Today

| **Element** | **Owner** | **Updates** |
| --- | --- | --- |
| Brief (`daily-focus`) | Morning routine (agent) | Once at 06:00 on workdays, or on Refresh (a re-plan Work Order) |
| Focus Override | App, from user actions | On pin, replace or dismiss |
| Live panels | App, computed from the index | Always current |
| Slack DM | Morning routine | Once a day. Read-only, 5 lines. v0.8: sent (not drafted) to Rahul only; never on replan. |

Brief content caps: at most 3 must-dos (a setting); meeting hours shown as information only; 1–3 deferral suggestions, tasks only; one screen.

**v0.7.** The brief may list up to 5 Top 3 items; Today shows at most the Max must-dos setting (1–5, default 3). A brief over about 300 words is adopted with a warning on Today.

### 13.5 Agent Index

The `_agent/` folder holds derived files:
- an overview
- open tasks
- waiting on
- open points
- recent decisions
- projects, clients and products
- people with labels
- recent and upcoming meetings with enrichment state

Each entry has ID, title and path. Every file shows when it was generated, and the skills must warn when it is older than 24 hours. Restricted objects appear only as a count. Pending drafts are readable and labelled.

### 13.6 People, sensitivity and Areas

- **People:** see 5.7 v0.6. Display labels are computed in the application, so every surface agrees.
- **Sensitivity:** `restricted` excludes an object from agents, the brief, Slack and Work Orders. It is an instruction, not a lock.
- **Areas:** validated vocabulary. Legacy values produce warnings.

### 13.7 Success gates

| **Gate** | **Measure** |
| --- | --- |
| Core-loop quality (inside Phase A) | 10 real meetings within 2 weeks; ≥70% of proposals accepted with no or light edits; ≤2 minutes of review per meeting; 0 commitments without review; Today opened on ≥8 of 10 workdays |
| Phase A exit | 4 consecutive weeks: every new work action is captured in LifeOS, and Steve's morning brief reads from LifeOS |

### 13.8 Non-functional targets

- **Scale:** 10,000 objects.
- **Speed:** index ready in under 3 s; save in under 300 ms; search in under 500 ms; a 20-draft adoption in under 5 s.
- **Index rebuild:** incremental indexing becomes required when a full rebuild exceeds 1 s on real data.
- **Durability:** no data loss on crash or sleep.
- **Accessibility (dyslexia-friendly):** readable font, short lines, no meaning by colour alone, full keyboard use, 5–7-row panels.

### 13.9 Dated reminders

- **19 October 2026:** check the first CI run on Ubuntu 26.
- **31 October 2026:** data-root and employer-account review, including the exit plan and the client-contract question.
- **Open actions for Rahul:** connect the Gong and Slack connectors in Claude; choose an LLM provider and key for the deferred in-app option (not blocking). v0.8: install the skills and run the dry-runs (`skills/INSTALL.md`); set the off-Drive backup folder on each Mac; confirm working hours; get IT/legal sign-off for client meeting content.

### 13.10 Decisions made during the build (v0.7)

The full table with sources is in the PRD, section *Decisions made during the build*. In short:

| **Topic** | **Decision** |
| --- | --- |
| Top 3 size | A brief may list up to 5 items; Today shows at most Max must-dos (1–5, default 3). Pinned tasks count towards it. |
| Long brief | Adopted with a length warning, not rejected. |
| Unavailable material | A meeting-material draft can mark expected material as `unavailable`; it counts as done. |
| Restricted meetings | Restricted when the meeting or its note is restricted (ADR 0010, #63). |
| Restricted items on Today | Live panels, Decisions and Open Points show them with a lock badge; brief sections hide them and show a count; never in the Top 3. |
| Version history | Last 10 copies per object; a pruned copy cannot be restored (ADR 0012). |
| Crash recovery | One pattern; a recorded intent (reject) wins over the operation it undoes (ADR 0013). |
| Supersede | A decision gains its `supersedes` link once, while active; both links set together (#67). |
| Self addresses, internal domains | Settings cards **My email addresses** and **Internal domains**; warning on Today and System Health while empty (#54, #76). |
| Keychain | Status never reads secret values; Deny shows "Keychain access denied" with Retry (#77). |
| Link resolution | Card with candidate picker and "Create … and link" (#57). |
| Meeting summary | Written into the meeting body between `lifeos:summary:start` and `lifeos:summary:end` markers (#66). |
| Lists | Up to 7 rows; longer lists show 6 and "Show N more" (#64). |

### 13.11 Known gaps (v0.7)

Superseded by 13.13 (v0.8); kept for history.


| **Gap** | **Effect today** |
| --- | --- |
| No restore button for version copies | Restore works only through the API (`POST /api/v1/history/:id/restore`) (#79). |
| Undo refused when text follows the appended note | Undo never deletes the user's text; the user edits by hand instead (#61, #81). |
| Calendar sync still reads the Keychain each time | Sync and connect can still show a Keychain prompt unless access is set to "Always Allow" (#77). |
| Two-device limits | A version copy that never arrives from the other device leaves later edits unflagged; a pruned copy cannot serve the patch conflict rule (ADR 0012, #80, #81). |

### 13.12 Decisions made during the final build (v0.8)

The full table with sources is in the PRD, section *Decisions made during the build*. In short:

| **Topic** | **Decision** |
| --- | --- |
| Restore | Restore brings back content only; sensitivity and review state stay as they are now. Refused, with a reload prompt, if the object changed since the History panel opened (#92). |
| Today's lock | Shown when a meeting **or its note** is restricted. Mark normal on such a meeting says it stays excluded because of its note (#92). |
| Calendar offline | Stored meetings under an Offline banner, not a separate cache. Demo calendar only in mock mode; Retry reports success only when the calendar is back (#88, #94). |
| Unproven formatting | A text label in Visual mode names constructs the editor would rewrite. A save that would drop an image is blocked (#89, #91, #96). |
| Slack DM | Sent (not drafted), to Rahul only, read-only, 5 lines starting with the date. Not on replan; a failed send does not fail the brief (#51). |
| Working hours | Day shape assumes 09:00–18:00 in the brief time zone [TBD - confirm] (#51). |
| Client-content gate | `blocked` until IT/legal sign-off [TBD]. Only an edit to the skill file opens it; CI refuses `approved` while the TBD line remains (#50). |
| Internal domains unset | Enrichment refuses every non-synthetic meeting and says why (#93). |
| Work Order filing rule | An agent moves a Work Order it has finished from `_inbox/requests/` to `_inbox/processed/`, and nothing else (#93). |
| Off-Drive folder | Per Mac, keyed by device ID in `settings/backups.md` (ADR 0005, #95). |
| Stop sequence | Refuse writes → close HTTP and let adoption finish → stop backup (35 s limit) → release the lease; all within 60 s (ADR 0004, #95). |
| Phase B scope | Launcher, start at login, dyslexia-friendly font, dark theme, Playwright, 10,000-object fixture (#90). |

### 13.13 Known gaps (v0.8)

| **Gap** | **Effect today** |
| --- | --- |
| Skills not installed or dry-run | Built and tested in CI, but not installed in Claude; Steve not yet pointed at LifeOS (#49–#51). |
| Connector questions | Cloud routine use of Slack, Gong and Drive writes, and phone Drive writes [TBD - verify]. |
| Client meetings not enriched | Until IT/legal sign-off, and only once internal domains are set (#50, #93). |
| Offline calendar shows only stored meetings | Events never opened in LifeOS do not appear while offline (#88). |
| Undo refused when text follows the appended note | Undo never deletes the user's text; the user edits by hand instead (#61, #81). |
| Calendar sync still reads the Keychain each time | Sync and connect can still show a Keychain prompt unless access is set to "Always Allow" (#77). |
| Visual editor rewrites other Markdown | Meaning and images kept, bytes change; the Unproven formatting label warns (#89). |
| Off-Drive paths visible in the synced file | Saving on one Mac can give "changed on another device" on the other until it reloads (ADR 0005). |
| Writes refused during a stop | Up to 60 s; the user repeats the change once LifeOS is back (#95). |
| Two-device limits | A version copy that never arrives from the other device leaves later edits unflagged; a pruned copy cannot be restored or serve the patch conflict rule (ADR 0012, #80, #81). |
| Code duplication | Cleanup ticket, no behaviour effect (#97). |
