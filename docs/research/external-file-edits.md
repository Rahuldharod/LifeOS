# How LifeOS handles external file edits today

- **Ticket:** #3 (map: #1)
- **Date:** 2026-09-27
- **Question:** When a file in the data root is created, changed or deleted outside the app (Obsidian, Google Drive, a Claude agent), what does the current code actually do?
- **Sources:** the code in this repo at commit `1cdbbc5`, read directly. Validation behaviour was checked with a throwaway script against temporary folders. The real `../data` folder was not touched. `corepack pnpm test` passes (9 files, 14 tests).

---

## 1. Bottom line

- **Detection works, but it is blunt.** The server watches the whole data root. Any change triggers a **full re-scan** 250 ms later. It does not check just the file that changed.
- **Bad files disappear quietly.** A file that fails validation is left out of the app completely. The only sign is a line in System Health, and that line usually **does not say which file** is broken.
- **Duplicate IDs: the first file found wins.** The other file is hidden. Nothing blocks writes to either file.
- **Conflict detection uses the content hash only.** The `revision` number is never compared, even though ADR 0003 and design §7.6 say it is. When the hash check fires, it does protect the file on disk.
- **One likely data-loss path in the UI (found by reading the code, not reproduced).** In the Notes view, an external edit can be **silently overwritten** by an old browser draft. See §5.3.
- **Could an agent write valid files without the app? Yes, but it is fragile.** The rules are simple, but nothing checks the three things agents most often get wrong: **timestamp format**, **UUID quality/uniqueness**, and **YAML quoting**.

**So what:** direct agent writes (the #1 charting decision) are **not safe yet**. The Object Contract (#4) must spell out the format rules. The code also needs 3–4 small safeguards first (see §8).

---

## 2. Plain-language glossary

| Term | Meaning here |
|---|---|
| **Data root** | The folder of Markdown files (`../data`). It is the source of truth. |
| **Envelope** | The fixed block of YAML fields at the top of every object file (`id`, `type`, `revision`, …). |
| **Index** | The app's in-memory list of all objects. It is rebuilt from the files and can be thrown away. |
| **Content hash** | A fingerprint (SHA-256) of the whole file. If one character changes, the hash changes. |
| **Conflict check** | Before saving, the app checks that the file's hash on disk still matches the hash it had when you opened it. |
| **Diagnostic** | A warning line shown in the System view ("Attention"). |
| **UUIDv7** | A random ID that starts with a timestamp, e.g. `01995d3e-912b-7357-8aa6-9816c1ad90a5`. |

---

## 3. Detection: the watcher and reconciler

### How it works

| Step | What happens | Source |
|---|---|---|
| 1 | At startup: claim the device lease, full index rebuild, recover unfinished operations, rebuild again | `apps/server/src/main.ts:171-174` |
| 2 | `fs.watch(dataRoot, { recursive: true })` watches everything | `main.ts:177` |
| 3 | Events for paths starting with `.lifeos/` are ignored | `main.ts:178` |
| 4 | Any other event resets a **250 ms debounce timer**, then runs `rebuildIndex()`. This is the whole index, not just the changed file | `main.ts:179-180` |
| 5 | Rebuild = scan every `.md` file under the root (only `.lifeos` is skipped), parse, validate, then rebuild the index and graph checks | `object-store-markdown/src/index.ts:40-50, 72-88`; `index-memory/src/index.ts:8-17` |
| 6 | Rebuild errors are only logged on the server | `main.ts:180` |

### What each kind of external change does

| External change | Result | Source |
|---|---|---|
| **File created** | Appears in the index on the next rebuild, if it validates | as above |
| **File changed** | Index shows the new content and new hash after the rebuild | as above |
| **File deleted** | Disappears from the index. Anything that pointed to it now shows `references missing object` in Health. No tombstone and no audit record | `index-memory/src/index.ts:85-90` |
| **File renamed/moved** | Fine. Identity comes from `id` in the YAML, not the filename. The new path is picked up | `object-store-markdown/src/index.ts:47` |

### Limits worth knowing

- **Full rescan on every change.** The design asks for incremental re-checks (§10.7: "incrementally revalidate changed files"). The code does not do that yet.
- **The app's own writes also trigger the watcher.** Each app write already calls `rebuildIndex()` itself (e.g. `application/src/index.ts:159`), so rebuilds overlap. Two rebuilds can finish in either order, so a slower, older scan can overwrite a newer one. The risk is low, but it is not prevented.
- **Dot-folders other than `.lifeos` are scanned.** For example, an Obsidian `.trash/` folder is scanned. The probe confirmed that `.trash/old.md` got indexed. Deleted-in-Obsidian copies can come back as live objects or duplicate IDs.
- **Any `.md` file counts.** A `README.md` in the data root shows up as `README.md: missing YAML front matter`. It is harmless, but it adds noise.
- **Google Drive sync events:** [TBD — needs a real test on Rahul's Mac]. We have not verified that macOS `fs.watch` fires reliably for files that Google Drive for Desktop downloads into `~/Library/CloudStorage/...`. Restarting the app always forces a full scan, so it is a safe fallback.

---

## 4. New files: valid, invalid, duplicate

### 4.1 Valid envelope
The file is indexed and fully usable. The filename and folder are **not checked at all**. Any `.md` file anywhere with a valid envelope is accepted (`object-store-markdown/src/index.ts:33-38`).

### 4.2 Missing or invalid fields
- The whole file is **left out of the index**. It becomes invisible in every view (`object-store-markdown/src/index.ts:80-85`).
- A diagnostic is added and Health turns "attention" (`application/src/index.ts:98-100`).
- **Problem: the diagnostic usually has no file name.**
  - "Missing front matter" errors do include the path (`index.ts:35`).
  - Validation (Zod) errors and YAML syntax errors do not. They come out as a raw JSON error list, for example `[ { "expected": "number", "path": ["revision"], … } ]`. The probe confirmed this.
  - This breaks design §10.7 ("precise diagnostic").
- Other objects are unaffected (test: `tests/integration/object-store.test.ts:61-74`).

### 4.3 Duplicate ID
- The **first file found wins**. The second is silently dropped from the index (`index-memory/src/index.ts:11-15`).
- "First" means directory listing order, which is not guaranteed to be stable across machines.
- The diagnostic says `Duplicate object ID: <id>`. It gives **no paths**, so you cannot tell which two files clash.
- **Writes are not blocked.** Design §10.3 says "Duplicate IDs … block affected writes". The code does not do this.
- Likely real-world causes:
  - Google Drive conflict copies (`file (1).md`)
  - Obsidian "duplicate file"
  - Obsidian `.trash/`
  - An agent copying an example file and forgetting to change the `id`

### 4.4 Other graph checks run on every rebuild
All in `index-memory/src/index.ts:32-94`:
- Broken references
- Wrong reference type (e.g. `owner_person_id` pointing at a task)
- More than one `is_self` person
- More than one note for the same meeting
- The same external calendar ID used on two objects

These are **warnings only**. They block nothing.

---

## 5. External edit to a file the app has open

### 5.1 The conflict check (server)
- Every app edit sends the `contentHash` the browser saw (`expectedHash`). Examples: `updateBody` at `application/src/index.ts:306-317`, and `updateTask` / `updateEntity` / `deleteEntity` / `archiveObject`.
- `MarkdownObjectStore.write` re-reads the file. If the file is missing, or its hash differs, it throws `ObjectConflictError` (`object-store-markdown/src/index.ts:115-117`). The server maps that to **HTTP 409** (`main.ts:166`). The probe confirmed an external edit followed by a stale save gives `ObjectConflictError`.
- On success, the old version is saved to `.lifeos/versions/<id>/<revision-1>--<hash12>.md`, then the file is replaced in one atomic step: temp file, fsync, rename (`index.ts:118-137`).
- **`revision` is never compared.** The app just writes `revision + 1` (e.g. `application/src/index.ts:312`).
  - This contradicts ADR 0003 ("compares the original content hash and revision") and design §7.6.
  - Today that is harmless, because the hash already catches every change.
  - But it means an agent's `revision` value has **no effect** on safety.
- **Small race window.** An external write that lands between the hash re-read and the rename is lost (`index.ts:116` → `132`). There is no lock. The window is milliseconds long.
- **Creates never check.** New-object writes pass no `expectedHash`, so they overwrite whatever is at that path (`index.ts:115`). The UUID in the filename makes a clash very unlikely.

### 5.2 What the user sees
| Situation | What the UI shows | Source |
|---|---|---|
| Note (Notes view or meeting workspace) save/autosave hits 409 | Amber banner: **"This note changed on disk. Your draft was not overwritten."** + one button: *Reload disk version* / *Discard draft & reload disk*. There is no diff, no merge and no "keep mine" option. | `apps/web/src/main.tsx:362, 388, 780, 818` |
| Draft restored from the browser but the file changed meanwhile | Same banner + message "Recovered a browser draft, but the Markdown file also changed. Review before saving." | `main.tsx:339-342` |
| Task / project / person edit hits 409 | Status message only: "Object changed since it was opened: `<path>`" | `main.tsx:396-403, 477-511` |
| External edit while you are just looking | **Nothing.** The browser never polls or gets pushed updates. You only see the change after another action reloads the lists, or after a page refresh. | `main.tsx:278-284` |
| Autosave while a conflict is showing | Paused. The draft stays in browser storage. | `main.tsx:349, 375` |

### 5.3 Likely data-loss path (Notes view): external edit overwritten by an old draft
Found by reading the code and **not reproduced**. Confidence: high.

1. You open note A in the **Notes** view. The draft holds A's body.
2. An agent or Obsidian edits A on disk. The server index updates.
3. You do anything that reloads the lists, e.g. Quick Capture on Today (`main.tsx:472-475`, `loadCollections` at `278-284`). `notes` now holds A's **new** body and **new** hash.
4. The draft is **not** reset. Re-syncing is skipped because the note was "already restored" (`main.tsx:335`).
5. The app now thinks the draft is an unsaved edit (`notesDirty`, `main.tsx:275`). About 1.8 s later, autosave sends the **old draft** with the **new** hash as `expectedHash` (`main.tsx:345-366`).
6. The hash matches, so the server accepts the save. **The external edit is reverted, with no banner.** The only copy left is in `.lifeos/versions/`.

Why it happens: autosave uses the hash of the latest note list. It should use the hash the draft was based on. The draft's saved `baseHash` exists (`main.tsx:61`) but autosave ignores it.

The meeting workspace is safer. `refreshWorkspace` resets the draft and flags a conflict (`main.tsx:286-291`).

---

## 6. Envelope fields and validation rules

Runtime rules live in `packages/domain/src/index.ts`. The JSON Schemas in `schemas/objects/` are a **looser** copy that has drifted; see "drift" below.

### 6.1 Common envelope (`domain/src/index.ts:10-24`)
| Field | Rule | Example |
|---|---|---|
| `id` | Any RFC UUID (versions 1–8, any case). **Version 7 is not enforced** | `01995d3e-912b-7357-8aa6-9816c1ad90a5` |
| `type` | One of 18 values (`index.ts:4-8`) | `task` |
| `schema_version` | integer ≥ 1 | `1` |
| `revision` | integer ≥ 1 (the string `"1"` fails) | `1` |
| `title` | non-empty **string** | `Call Ann` |
| `created_at`, `updated_at` | ISO datetime, **UTC `Z` only**. Offsets like `+02:00` fail, a missing seconds part fails, a space instead of `T` fails. Milliseconds are OK | `2026-09-27T08:00:00Z` |
| `updated_by_device` | non-empty string | `claude-steve` |
| `archived_at`, `deleted_at` | optional UTC datetime | |
| `area` | optional string | `work` |
| `subjects`, `tags` | optional string lists | |
| anything else | **kept** (`.loose()`) and written back unchanged | |

### 6.2 Type-specific rules (selected; full list at `domain/src/index.ts:26-68`)
- **task:**
  - `status` must be exactly one of `Inbox|Next|Waiting|Done|Cancelled`. Case matters: `inbox` fails.
  - `owner_person_id` is **required** and must be a UUID.
  - `due_on` and `due_at` cannot both be set.
  - `due_at` needs `due_timezone`.
  - `waiting_for_person_id` only when status is `Waiting`.
  - `Done` needs `completed_at`; `Cancelled` needs `cancelled_at`, and neither is allowed otherwise.
  - A task cannot list itself in `dependency_ids`.
- **person:** `given_name` is required. `is_self` must be a real boolean: `"true"` fails.
- **knowledge-note:** `source_ids` needs **at least one** UUID.
- **meeting:** `status`, `starts_at`, `ends_at`, `timezone` and `attendee_ids` are all required.
- **review-item:**
  - Required: `review_type`, `target_object_type`, `proposed_fields`, `confidence_label` (`High|Medium|Low`), `status` (`pending|accepted|rejected`), and `operation_id` (a UUID).
- **daily-focus, recurring-item:** **no runtime schema**. Only the envelope is checked. The probe showed an empty `daily-focus` passes.
- Reference fields (`*_id`, `*_ids`) are only checked for **existence and type** after indexing, as warnings (`index-memory/src/index.ts:64-94`).

### 6.3 YAML gotchas (`yaml` v2 library, confirmed by probe)
| Input | Result |
|---|---|
| `title: Meeting: Q3 review` (unquoted colon) | **YAML parse error.** The file is dropped and the diagnostic has no path |
| `title: 2026` | Read as a number, so it fails "title must be string" |
| `due_on: 2026-09-27` | Stays a string: OK |
| `created_at: 2026-09-27T08:00:00Z` | Stays a string: OK |
| File starting with a byte-order mark (BOM) | "missing YAML front matter" |
| Windows line endings (`\r\n`) | OK (`object-store-markdown/src/index.ts:34`) |

### 6.4 Drift between docs, JSON Schema and code
- JSON Schema `format: date-time` allows offsets; the code does not.
- JSON Schema requires `focus_on` for `daily-focus`; the code does not check it.
- The design §7.4 folder list has no `agent-runs/`, `connectors/` or `sync-runs/`, but the code writes to all three (`application/src/index.ts:329, 488, 598`).
- ADR 0003 and design §7.6 say `revision` is compared; the code does not compare it.

---

## 7. Filenames and IDs: can an agent reproduce them?

### 7.1 Filename convention (ADR 0002; `application/src/index.ts:3-29`)
```text
YYYY-MM-DD-HHmm-<slug>--<full-uuid>.md
e.g. tasks/2026-09-27-0815-call-ann-about-q3--01995d3e-912b-7357-8aa6-9816c1ad90a5.md
```
- **Timestamp:** creation time in **UTC**, to the minute. Meetings and meeting notes use the event's local timezone and start time instead (`index.ts:243, 260`).
- **Slug:** the title with accents stripped, lowercased, and every run of non-`a–z0–9` characters turned into `-`. Leading and trailing `-` are trimmed. It is cut to 80 characters, or becomes `untitled` if empty.
  - Quirk: the cut happens *after* trimming, so a slug can end in `-`.
- **Folder by type:**
  - `tasks/`, `projects/`, `clients/`, `products/`, `people/`
  - `meetings/` (meetings **and** meeting notes)
  - `decisions/`, `open-points/`, `knowledge/`, `sources/`, `review-items/`
  - `agent-runs/`, `audit/`, `connectors/`, `sync-runs/`
- **Enforcement: none.** The scanner ignores filenames and folders, and renaming a title never renames the file. A "wrong" filename is cosmetic and **does not break anything**.

### 7.2 UUIDv7 (`domain/src/index.ts:74-85`)
- 48-bit millisecond timestamp, then version nibble `7`, then variant bits `10`, then random bytes. It uses Node's `crypto.randomBytes`.
- There is no counter inside a single millisecond. Order within the same millisecond is random.
- An agent can make a correct one easily **if it runs code**:
  - `node -e "…"`
  - Python 3.14+: `uuid.uuid7()`
- It **cannot** make one reliably by "typing" one. A language model inventing an ID gives a UUID-shaped string that may repeat an example, or may not be random.

### 7.3 What an agent would most easily get wrong (ranked)
1. **Timestamps with an offset** (`2026-09-27T10:00:00+02:00`, natural for someone in France), or with a space instead of `T`. → The file is rejected and disappears.
2. **Made-up or copied IDs.** Reusing the fixture ID `01995d3e-…` or another file's ID → a duplicate ID, one file hidden, and it may be the real one.
   - Nothing enforces version 7, so a v4 or invented UUID passes silently.
3. **Unquoted YAML.** Titles containing `: ` or `#`, or titles that look like numbers or booleans. → Parse error or type error, and the file disappears.
4. **Task lifecycle pairs.** Setting `status: Done` without `completed_at`, or leaving `completed_at` when reopening → rejected.
5. **Missing `owner_person_id` on tasks.** The agent must first look up the `is_self` person's ID.
6. **Review Item `operation_id` reuse.** If an agent copies an `operation_id` from an existing review item:
   - Acceptance finds the old operation record (`object-store-markdown/src/index.ts:161-163`).
   - It re-uses that record's `objectId` and returns the **existing** object instead of creating a new one (`application/src/index.ts:370-386`).
   - The review is then marked accepted and linked to the wrong object, with no error.
7. **Editing without bumping `revision` / `updated_at` / `updated_by_device`.** This has no functional effect today. It does make history and audit misleading.
8. **Hard-deleting files** instead of setting `deleted_at`. The object vanishes with no tombstone, which design §7.6 forbids.

---

## 8. Behaviour that makes direct agent writes unsafe today

| # | Risk | Severity | Why |
|---|---|---|---|
| U1 | **UI can silently revert an agent's edit** (Notes view, §5.3) | **High** | Autosave uses the hash from the refreshed list, not the draft's base hash |
| U2 | **Invalid agent file disappears with an unlocatable warning** | **High** | Validation diagnostics have no file path (§4.2); nothing tells the agent it failed |
| U3 | **Duplicate IDs hide one file, writes still allowed** | **High** | First-found wins, the order is not stable, and there are no paths in the warning (§4.3) |
| U4 | **No history of agent overwrites** | Medium | `.lifeos/versions/` snapshots are only made by *app* saves (`object-store-markdown/src/index.ts:115-123`). An agent overwrite of a file that is never saved again in the app leaves only the daily backups |
| U5 | **No audit trail for external changes** | Medium | Audit events are only written by app use cases (`application/src/index.ts:588-591`) |
| U6 | **Lease ignored by agents** | Medium | The device lease is only enforced on the HTTP API (`main.ts:43-49`). File writers never see it |
| U7 | **Review Item `operation_id` reuse links to the wrong object** | Medium | §7.3 item 6 |
| U8 | **Partial writes can be scanned** | Low | If an agent writes non-atomically and the 250 ms debounce fires mid-write, the object briefly vanishes. The next event fixes it |
| U9 | **Hash-check race** (external write during app save) | Low | Millisecond window at `object-store-markdown/src/index.ts:116-132` |

---

## 9. Gaps an Object Contract must cover

These feed into #4. Items marked **(code)** need a code change, not just a written rule.

1. **Timestamp rule:** UTC with `Z` only, with an example. Say that local offsets are rejected.
2. **ID rule:** generate the ID with a command (UUIDv7), never type one by hand, never copy one. Check it is unique before writing. **(code)** Consider enforcing version 7 in `z.uuid()`.
3. **YAML quoting rule:** always quote `title` and every free-text string. Booleans must be bare `true`/`false`. Use UTF-8 without a BOM.
4. **Required fields per type:** one small table per type the agent may write, including lifecycle pairs (`Done` ↔ `completed_at`, etc.) and how to find `owner_person_id` (the `is_self` person).
5. **Edit protocol:**
   - Re-read the file right before writing.
   - Keep all unknown fields.
   - Bump `revision`.
   - Set `updated_at`, and set `updated_by_device` to an agent ID (e.g. `claude-steve`).
   - Write to a temp file and then rename it into place.
6. **Delete protocol:** set `deleted_at` (and bump `revision`); never remove the file.
7. **Filename rule:** follow ADR 0002 for readability, and say clearly that a wrong filename is cosmetic. List the folder for each type.
8. **Review Item rule:** a fresh `operation_id` every time. Which `target_object_type`s acceptance supports today: `task`, `decision`, `open-point`, `knowledge-note` (`application/src/index.ts:376`). Which `proposed_fields` are actually used: `title`, `status`, `body` (`:373`).
9. **Which types agents may write** (and which are app-only, e.g. `connector-account`, `sync-run`, `agent-run`, `audit-event`).
10. **Self-check after writing:** how the agent confirms the app accepted the file.
    - **(code)** Ideally a CLI or endpoint that validates a file and prints errors *with the path*.
11. **Timing rule:** write only when the app is closed, or accept the risk U1 until it is fixed. Say whether agents respect `.lifeos/session.md`.
12. **Audit expectation:** should an agent write an `audit-event` / `agent-run` for its changes? It may not today (`actor_type: agent` exists in the schema).

### Code safeguards to consider before enabling direct agent writes
- **(code, U1)** Autosave should send the draft's `baseHash`, and the draft should re-sync when the note's hash changes → PB-002.
- **(code, U2)** Put `relativePath` in every scan diagnostic (wrap the Zod/YAML error in `decode`).
- **(code, U3)** Put both paths in the duplicate-ID diagnostic. Block writes to duplicated IDs, as §10.3 already requires.
- **(code)** Skip dot-folders such as `.trash/` and `.obsidian/` when scanning, or make the list configurable.
- **(docs)** Fix ADR 0003 / §7.6 wording, or start comparing `revision` for real. Bring the JSON Schemas in line with the Zod rules.
