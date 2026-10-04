# LifeOS Phase A — manual test checklist

> Branch tested: `feature/phase-a-21`. Written 4 October 2026.
> Use **synthetic data only** (names and addresses on `example.com`).
> Tick ☐ → ☑ when a step passes. Note the step number when it fails.

## How to read this

- Each table row is one test. Do the **Step**, then check the **Expected result**.
- **P1** = test before daily use. **P2** = test this week. **P3** = test when you have time.
- Words in **bold** inside steps are the exact button or card names on screen.
- "Status line" = the small grey text at the bottom of the left sidebar. Success and error messages show there.

---

## 0. Before you start

### 0.1 Which copy of LifeOS to use

| Copy | Address | Data | Use it for |
|---|---|---|---|
| **Test copy** (dev) | `http://127.0.0.1:5174` | `code/.dev-data/` (fake) | Everything except section 14 |
| **Daily app** (stable) | `http://127.0.0.1:4310` | `LifeOS App/data/` (real) | Section 14 (Keychain) and the stable-only rows |

Why: tests create fake tasks and people. Keep them out of your real vault.

### 0.2 Setup steps

| # | Step | Expected result | ☐ |
|---|---|---|---|
| S1 | In Finder, rename `code/.dev-data` to `.dev-data-old` (press **Cmd+Shift+.** to see hidden folders). | The old test data is archived, not deleted. | ☐ |
| S2 | In Terminal, in the `code` folder, run `corepack pnpm dev`. | Terminal says the server is listening; a new `.dev-data` folder appears. | ☐ |
| S3 | Open `http://127.0.0.1:5174` in your browser. | Today page opens with the heading "What needs your attention?". | ☐ |
| S4 | Check Today shows a **SETUP NEEDED** card. | It says "Your email addresses are not set" and has two buttons. | ☐ |
| S5 | Click **Set my email addresses in Settings**, type `me@example.com`, click **Save**. | Green text: "Saved. Attendees with these addresses are now you." | ☐ |
| S6 | In the **Internal domains** card, type `example.com`, click **Save**. | Green text: "Saved. People labels now use these domains." | ☐ |
| S7 | Go back to Today. | The **SETUP NEEDED** card is gone. | ☐ |
| S8 | In Finder, open `code/.dev-data/_inbox/`. | You see folders `drafts`, `patches`, `requests`, `processed`, `failed`. | ☐ |

To stop the test copy: press **Control+C** in Terminal. To restart it: run `corepack pnpm dev` again.

### 0.3 How to drop a test Inbox Draft

Agents (Claude, Steve) feed LifeOS by saving small text files. You can do the same by hand.

| Draft type | Folder |
|---|---|
| New object (task, decision, person, brief…) | `code/.dev-data/_inbox/drafts/` |
| Change to an existing object (patch) | `code/.dev-data/_inbox/patches/` |

**How to save one:**

1. Open TextEdit. Choose **Format → Make Plain Text**.
2. Paste a template from the **Draft library** at the end of this file.
3. Save it in the folder above with a name ending `.md` (for example `test-001.md`). Untick "If no extension is provided, use .txt".
4. Wait about **5 seconds**, then reload the browser page. Or click **Adopt now** in Inbox.

**Rules that trip people up:**

- Every draft needs a **new `draft_key`**. Re-using one with different text fails on purpose.
- The `---` lines must stay exactly as shown.
- After adoption the file moves to `_inbox/processed/` (or `_inbox/failed/`). A `.result.md` file appears next to it.

**Minimal example (a task you "dictated"):**

```markdown
---
lifeos_draft: 1
kind: task
draft_key: test-001
origin: user-dictated
title: Send Alex the pricing deck
captured_at: 2026-10-04T09:15:00+02:00
due_on: 2026-10-09
priority: High
---
Alex asked for the deck before Friday.
```

### 0.4 How to find an object's ID

Some drafts need an ID. The ID is the **end of the file name**, after the two dashes.

Example: `tasks/2026-10-04-0915-send-alex-the-pricing-deck--0199a1b2-....md` → the ID is `0199a1b2-...`.

---

## 1. Priority order

| Priority | Sections | Why |
|---|---|---|
| **P1** | 0 Setup · 2 Data safety · 3 Today & live panels · 4 Inbox Drafts & adoption · 5 Review Items · 14 Keychain | You rely on these every day; data loss or prompt storms would block use |
| **P2** | 6 Daily Focus & Top 3 · 7 Patch Drafts · 8 People · 9 Decisions · 10 Open Points · 11 Restricted · 12 Settings · 13 System Health | Important, but a failure is annoying, not dangerous |
| **P3** | 15 Meetings & enrichment · 16 Agent Index · 17 History & versions · 18 Knowledge drafts · 19 Accessibility | Agent-facing or rarely touched; test when convenient |

**Test case count:** P1 = 81 · P2 = 84 · P3 = 37 · optional crash checks = 4 · **Total 206** (setup rows S1–S8 not counted).

Short on time? In P1, do sections 3, 4 and 14 first (about 36 rows).

---

## 2. Data safety — P1

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 2.1 | In **Tasks**, type `Safety test task` and click **Create**. | The task appears with "Origin: LifeOS app" and "Revision 1". | #30 | ☐ |
| 2.2 | In Finder, create `.dev-data/tasks/broken.md` containing only the text `---` then `title: [oops` then `---`. | Nothing crashes; other tasks still show. | #26 | ☐ |
| 2.3 | Open **System**. | "Object graph" shows **Attention**; **INTEGRITY DIAGNOSTICS** lists `tasks/broken.md` with a reason. | #26 | ☐ |
| 2.4 | Move `broken.md` to your Desktop and reload **System**. | The diagnostic disappears; "Healthy" returns. | #26 | ☐ |
| 2.5 | In Finder, duplicate the "Safety test task" file (Cmd+D) inside `.dev-data/tasks/`. | A second file "… copy.md" with the same ID exists. | #27 | ☐ |
| 2.6 | Reload **System**. | Diagnostics name **both** file paths as a duplicate ID. | #27 | ☐ |
| 2.7 | In **Tasks**, change the task's priority and click **Save changes**. | Save fails; the status line names the duplicate ID and both paths. | #27, #58 | ☐ |
| 2.8 | Move the "copy" file to your Desktop, reload, and save the priority again. | Save works; revision goes up by 1. | #27 | ☐ |
| 2.9 | Open the task file in TextEdit, change its title, save, and **do not** reload the browser. | The file saves; the browser still shows the old title. | #28 | ☐ |
| 2.10 | In the browser, change the same task's priority and click **Save changes**. | Save is refused as a conflict; your newer file edit is not overwritten. | #28 | ☐ |
| 2.11 | Reload the page. | The title you typed in TextEdit is shown. | #28, #29 | ☐ |
| 2.12 | In Finder, open `.dev-data/audit/` and sort by date. | The newest file mentions `object.changed-externally` for that task. | #29 | ☐ |
| 2.13 | Open `.dev-data/.lifeos/versions/` and the folder named with the task's ID. | It holds copies named `<revision>--<code>.md`, including the version before your edit. | #29, #72 | ☐ |
| 2.14 | Stop the test copy (Control+C), edit the task title in TextEdit, then restart it. | A new `object.changed-externally` audit file appears after restart. | #69 | ☐ |
| 2.15 | In TextEdit, only reorder two lines in the task's front matter (top block), save, and wait 5 seconds. | **No** new external-edit audit file appears. | #69 | ☐ |
| 2.16 | In **System**, click **Create & verify snapshot**. | Status line: "Snapshot created and restoration drill passed"; a new row appears. | ADR 0004 | ☐ |
| 2.17 | Click **Test restore** on that row. | "Restoration drill passed" with file count and size. | ADR 0004 | ☐ |
| 2.18 | In a task file, set `area: finance` in TextEdit and save. | **System** shows a warning that the Area is not one of the agreed values; the task still loads. | #30 | ☐ |
| 2.19 | In **Tasks**, open the **Area** dropdown on any task. | Only the six agreed areas (plus "None") are offered. | #30 | ☐ |
| 2.20 | Stop the server while typing in a note in **Notes**, then restart it. | A "Reconnecting…" card shows; your typed text is kept and saves when the server is back. | existing | ☐ |

---

## 3. Today page & live panels — P1

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 3.1 | Open **Today**. | Three cards: **Active tasks**, **Review inbox**, **Today's events**. | #48 | ☐ |
| 3.2 | In **QUICK CAPTURE**, type `Call Jamie about Q4` and press Enter. | Status line: "Captured as an Inbox task"; Active tasks goes up by 1. | #31 | ☐ |
| 3.3 | In **Tasks**, give one task a due date of yesterday and click **Save changes**. | On Today, **OVERDUE · 1** shows it with "Overdue by 1 day". | #48 | ☐ |
| 3.4 | Give another task today's date. | **DUE TODAY** lists it. | #48 | ☐ |
| 3.5 | Give a third task priority **High** and a date next week. | **UPCOMING HIGH PRIORITY** lists it with "High priority · due …". | #48 | ☐ |
| 3.6 | Set a task to status **Waiting** and **Waiting for** = a person. | **WAITING BY PERSON** shows the person's name, then the task as a row. | #48, #64 | ☐ |
| 3.7 | Check **NEXT MEETINGS**. | The mock "Weekly Product Review" shows with its time and "h of meetings today". | #48 | ☐ |
| 3.8 | Check **INBOX AND AGENTS**. | Rows say "… review items awaiting confirmation" and "Nothing awaiting adoption". | #48 | ☐ |
| 3.9 | Click **Open Inbox** in that panel. | The Inbox page opens. | #48 | ☐ |
| 3.10 | Create 9 overdue tasks, then open Today. | **OVERDUE** shows 7 rows and a **Show 2 more** button. | #48, #64 | ☐ |
| 3.11 | Press Tab until **Show 2 more** is focused, then press Enter. | All 9 rows show; the button now says **Show fewer**. | #64 | ☐ |
| 3.12 | Mark one overdue task **Done** and reload Today. | It leaves the Overdue panel. | #48 | ☐ |

---

## 4. Inbox Drafts & adoption — P1

Templates are in the **Draft library** (end of file).

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 4.1 | Open **Inbox**. | The **AGENT DRAFTS** card says "Nothing awaiting adoption" and shows **Adopt now**. | #31 | ☐ |
| 4.2 | Stop the test copy, drop draft **A** (dictated task), then start it again. | On start, the task is adopted without you clicking anything. | #31, #32 | ☐ |
| 4.3 | Open **Tasks**. | "Send Alex the pricing deck" exists, status Inbox, "Origin: Dictated by you". | #31, #30 | ☐ |
| 4.4 | Open `_inbox/processed/`. | The draft is there with a `.result.md` file naming the new task ID. | #31 | ☐ |
| 4.5 | With the app running, drop draft **A2** (new `draft_key`) and wait 5–10 seconds. | It is adopted on its own; reload shows the new task. | #32 | ☐ |
| 4.6 | Drop draft **A2** again with the **same** text and `draft_key`. | No second task is created; `.result.md` points to the first result. | #32 | ☐ |
| 4.7 | Drop draft **A2** with the same `draft_key` but a different title. | It moves to `_inbox/failed/`; the reason mentions an idempotency conflict. | #32 | ☐ |
| 4.8 | Drop draft **J1** (no `draft_key`). | It fails with a reason naming `draft_key`. | #31 | ☐ |
| 4.9 | Drop draft **J2** (unknown `kind`). | It fails with a reason naming `kind`. | #31 | ☐ |
| 4.10 | Open **Inbox**. | Failed drafts are listed with their reason, under "Failed drafts are kept in `_inbox/failed/`". | #31 | ☐ |
| 4.11 | Open **Today**. | **INBOX AND AGENTS** shows "Failed draft: …" rows with the file path. | #48 | ☐ |
| 4.12 | Open **System**. | Diagnostics list each failed draft as "…: draft not adopted (reason)". | #31, #26 | ☐ |
| 4.13 | Check `_inbox/failed/` after a restart. | Failed drafts are still there; nothing was deleted. | #31 | ☐ |
| 4.14 | Stop the test copy, drop two drafts, start it, and immediately open **Inbox** before 5 seconds pass. | Either they are already adopted, or **Adopt now** adopts them; the status line counts each outcome. | #31, #32 | ☐ |
| 4.15 | Drop draft **C2** (dictated task with unknown project "Moonshot"). | The task is still created; a link-resolution Review Item also appears in Inbox. | #33 | ☐ |

---

## 5. Review Items — P1

### 5a. Create-type proposals (task, decision, open point)

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 5.1 | Drop draft **B** (agent-extracted task with evidence). | **No** task is created; a Review card appears in Inbox; the Inbox nav item shows a count. | #34 | ☐ |
| 5.2 | Look at the card. | It shows "task · High confidence · pending · agent-extracted" and an evidence line with locator "00:12:30". | #34 | ☐ |
| 5.3 | Change the title box, then try to click **Accept task**. | **Accept task** is disabled ("Save your edits first"). | #34 | ☐ |
| 5.4 | Click **Save edit**. | Status line: "Proposal updated"; **Accept task** is enabled again. | #34 | ☐ |
| 5.5 | Change **Owner**, **Due**, **Priority** and **Project**, click **Save edit**, then **Accept task**. | Status line: "Task accepted and published"; the task in **Tasks** has your edited values and "Origin: Extracted by an agent". | #34, #57 | ☐ |
| 5.6 | Drop draft **B2** (agent-extracted decision), then click **Reject**. | Status line: "Proposal rejected"; no decision is created. | #34 | ☐ |
| 5.7 | Drop draft **B3** (evidence points to a source that does not exist). | The card shows "Unresolved source: …" and does not crash. | #34 | ☐ |
| 5.8 | Drop draft **B4** (agent-extracted open point, in French). | The proposal keeps the French title; nothing is translated. | #34 | ☐ |
| 5.9 | Double-click **Accept** very fast on a new proposal. | Exactly **one** object is created. | #62 | ☐ |
| 5.10 | Open Inbox in two browser tabs and accept the same item in both. | One object only; the second tab shows it as already handled or refreshes cleanly. | #62 | ☐ |

### 5b. Link-resolution card

Set up first: in **People**, create "Joel Martin" and "Joel Durand"; set **Given name** to `Joel` on both and click **Save changes**.

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 5.11 | Drop draft **C** (dictated task, `waiting_for: Joel`). | The task is created without a "waiting for" person; a link card appears in Inbox. | #33 | ☐ |
| 5.12 | Look at the link card. | It says "several matches" and lists both Joels under "Link "Joel" to". | #57 | ☐ |
| 5.13 | Press Tab into the list, use arrow keys to pick one, then press Space. | The radio button moves with the keyboard. | #57 | ☐ |
| 5.14 | Click **Link**. | Status line: "Link saved"; the task now waits for that Joel. | #33, #57 | ☐ |
| 5.15 | Open the link card from step 4.15 ("Moonshot", no match). | It says "no match" and offers **Create project "Moonshot" and link** and **Reject**. | #57 | ☐ |
| 5.16 | Click **Create project "Moonshot" and link**. | A project "Moonshot" exists and the task is linked to it. | #57 | ☐ |
| 5.17 | On a new link card, pick a Joel, delete that Joel in **People** in another tab, then click **Link**. | The card shows the server's error as text inside the card; nothing is linked. | #57 | ☐ |

### 5c. Person merge card

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 5.18 | Drop person draft **E1**, then person draft **E2** (same name, other address). | A merge card appears with a confidence label; **no** automatic merge. | #40 | ☐ |
| 5.19 | Click **Keep separate**. | Status line: "Proposal rejected"; both people remain. | #40 | ☐ |
| 5.20 | Drop **E3** (third "Sam Rivera"), give a task this newest Sam as owner, then click **Merge** on a new card. | Status line: "People merged"; the merged Sam disappears from People. | #40 | ☐ |
| 5.21 | Open the task from 5.20. | Its owner is now the surviving Sam. | #40 | ☐ |
| 5.22 | Leave a proposal naming Sam B pending, merge B into A, then accept the proposal. | The new object points to Sam A, not the merged one. | #65 | ☐ |

### 5d. Update card (from a patch)

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 5.23 | Drop patch **G1** (change a task's title). | An update card shows a **Field / Current / Proposed** table. | #37 | ☐ |
| 5.24 | Click **Apply change**. | Status line: "Change applied"; the task title changes. | #37 | ☐ |
| 5.25 | Drop patch **G1** again with a new key, edit the task by hand, then click **Apply change**. | It fails as a conflict; your hand edit stays. | #37 | ☐ |

### 5e. Summary card

See section 15 (needs a meeting). Expected: **Accept summary** writes an **AI SUMMARY** card on the meeting, never into your note. Tickets #45, #66.

---

## 6. Daily Focus & Top 3 overrides — P2

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 6.1 | With no brief dropped, open **Today**. | **DAILY FOCUS** says "No brief for today yet. Top 3 suggested by priority, then due date." | #47 | ☐ |
| 6.2 | Look at **Top 3**. | Up to 3 open tasks, high priority and earliest due first, each with a reason. | #47 | ☐ |
| 6.3 | Drop brief draft **H** with today's date and three real task IDs. | Today shows "Generated at HH:MM". | #46 | ☐ |
| 6.4 | Check the section order. | **I owe → Top 3 → Waiting and decisions → Meeting prep → Day shape** (then **Consider deferring**). | #46 | ☐ |
| 6.5 | Check the Top 3 rows. | Each shows its "why today" text and the if-then text. | #46 | ☐ |
| 6.6 | Mark one Top 3 task **Done** in Tasks, then reload Today. | It shows "Done", struck through, and sinks to the bottom. | #46 | ☐ |
| 6.7 | Delete a task the brief names, then reload Today. | That row reads "Missing: deleted or not found"; nothing crashes. | #46 | ☐ |
| 6.8 | Click **Refresh** in Daily Focus. | Status line: "Re-plan requested for <date>: ask Claude to "run LifeOS replan""; a new file appears in `_inbox/requests/`. | #46 | ☐ |
| 6.9 | Click **Pin** on a Top 3 item. | Status line: "Pinned to today's Top 3"; the row says "Pinned"; the button now says **Unpin**. | #47 | ☐ |
| 6.10 | Click **Replace**, pick a task in "Choose a task…", click **Replace**. | The new task shows with "Replaces "…"". | #47 | ☐ |
| 6.11 | Click **Replace**, then press Escape. | The replace box closes; nothing changes. | #47 | ☐ |
| 6.12 | Click **Dismiss** on a Top 3 item. | It moves under "Dismissed for today" with a **Restore** button. | #47 | ☐ |
| 6.13 | Click **Restore**. | It returns to the Top 3. | #47 | ☐ |
| 6.14 | Drop a **newer** brief for the same date (new `draft_key`). | Your pins, replaces and dismissals are still applied. | #47, #60 | ☐ |
| 6.15 | Click **Clear my Top 3 changes for today**. | Status line: "Your Top 3 changes for today were cleared". | #47 | ☐ |
| 6.16 | In **Settings → Max must-dos**, choose 2 and click **Save**. | Today's Top 3 now shows at most 2 items. | #47 | ☐ |
| 6.17 | With fewer than the max shown, use "Add a task to today's Top 3…" and click **Pin**. | The task joins the Top 3. | #47 | ☐ |
| 6.18 | Mark one brief task **restricted**, then reload Today. | It is hidden; Daily Focus says "1 restricted item not shown". | #46, #63 | ☐ |
| 6.19 | Drop a brief whose body is far over 300 words. | It is still adopted; a "Note: …" line warns about length. | #46 | ☐ |

---

## 7. Patch Drafts (changes from chat) — P2

Save patch files in `_inbox/patches/`. Set `captured_at` to **now**.

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 7.1 | Drop patch **F1** (mark "Send Alex the pricing deck" Done). | The task is Done without a Review Item. | #36 | ☐ |
| 7.2 | Open **Inbox → APPLIED CHANGES**. | A row shows "status Inbox → Done" with an **Undo** button. | #36 | ☐ |
| 7.3 | Click **Undo**. | Status line: "Undid the change to …"; the task is back to Inbox; the row shows "Undone". | #36, #61 | ☐ |
| 7.4 | Drop patch **F2** (append a note). | The note text is added once at the end of the task's body. | #36, #61 | ☐ |
| 7.5 | Change the task's status by hand, then click **Undo** on an older patch. | Undo is refused with "Cannot undo: … changed since the patch was applied". | #36 | ☐ |
| 7.6 | Drop patch **F3** (`waiting_for` without status Waiting). | It fails with a clear reason; nothing changes. | #36 | ☐ |
| 7.7 | Drop patch **F4** (title that matches two tasks). | It fails saying the title matches several objects. | #36 | ☐ |
| 7.8 | Drop patch **G2** (owner change, dictated). | It becomes an update Review Item, not applied. | #37 | ☐ |
| 7.9 | Drop patch **G3** (`origin: agent-extracted`, status Done). | It becomes an update Review Item. | #37 | ☐ |
| 7.10 | Drop patch **F1** with `captured_at` one hour ago, after editing that task's status by hand. | It becomes an update Review Item instead of overwriting. | #37, #81 | ☐ |

---

## 8. People & external marker — P2

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 8.1 | In **Settings → My email addresses**, add `jamie.chen@example.com` and **Save**. | Saved message shows. | #54, #38 | ☐ |
| 8.2 | In **Calendar**, open "Weekly Product Review" and type one word in the note. | The note is created; **Attendees** lists Alex and Example (you). | #38 | ☐ |
| 8.3 | Open **People**. | "Alex Morgan" exists with "Origin: Calendar"; no new "Jamie Chen" was created. | #38 | ☐ |
| 8.4 | Re-open the same event and type again. | No duplicate Alex appears. | #38 | ☐ |
| 8.5 | Check Alex's **Shown as** label. | It shows just "Alex" (only one Alex exists). | #39 | ☐ |
| 8.6 | Create a person "Alex Smith" with **Given name** `Alex`. | Both now show full names ("Alex Morgan", "Alex Smith"). | #39 | ☐ |
| 8.7 | In **Settings → Internal domains**, change to `example.org` and **Save**. | Alex now shows "Alex Morgan - ext" with " - ext" in red. | #39 | ☐ |
| 8.8 | On Alex's card, set **External** to "Internal". | Status line: "Marked internal"; " - ext" disappears. | #39 | ☐ |
| 8.9 | Set **External** back to "Auto (by email domain…)". | Status line: "External flag follows the email domain again". | #39 | ☐ |
| 8.10 | (Daily app, read-only) After **Sync now**, find a person created from an invite address like `first.last@…`. | The name is "First Last" in title case, with hyphens and accents kept. | #38 | ☐ |
| 8.11 | Check the self person card ("Example User"). | Its **Delete** button is disabled and it has no External picker. | #38 | ☐ |
| 8.12 | Restore Internal domains to `example.com`. | " - ext" disappears for example.com people. | #39 | ☐ |

---

## 9. Decisions — P2

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 9.1 | Open **Decisions**, type a title under **RECORD A DECISION**, click **Record**. | Status line: "Decision recorded"; it appears as **Active**. | #41 | ☐ |
| 9.2 | Select it. | The detail shows "Origin: LifeOS app" and "Recorded by hand: no evidence attached". | #41 | ☐ |
| 9.3 | Change its text and click **Save changes**. | Status line: "Decision saved". | #41 | ☐ |
| 9.4 | Click **Supersede…**, fill the new title and "Why it changed", click **Supersede**. | Status line: "Decision superseded"; old shows "Superseded by …", new shows "Supersedes …". | #41 | ☐ |
| 9.5 | Select the old (superseded) decision. | **Supersede…** is not offered ("Only active decisions can be superseded"). | #41 | ☐ |
| 9.6 | Use **FILTERS**: project, client, product, person, status, "Decided from/to". | The list narrows correctly; **Clear filters** resets it. | #41 | ☐ |
| 9.7 | Link a decision to a project, then open **Projects**. | The project card's "decisions" count includes it. | #41 | ☐ |
| 9.8 | Accept a decision proposal from Inbox (draft **B2**), then open it in Decisions. | The **EVIDENCE** section shows the source and locator. | #41, #34 | ☐ |
| 9.9 | Record decisions A and B, drop patch **G4** (A superseded by B), then click **Apply change**. | A shows "Superseded by B" and B shows "Supersedes A". | #67 | ☐ |

---

## 10. Open Points — P2

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 10.1 | Open **Open Points**, type a question under **RAISE AN OPEN POINT**, click **Record**. | Status line: "Open point recorded"; status **Open**. | #42 | ☐ |
| 10.2 | Click **Resolve…** and click **Resolve** with both boxes empty. | It is refused; a summary or a decision is required. | #42 | ☐ |
| 10.3 | Type a **Resolution summary** and click **Resolve**. | Status line: "Open point resolved"; status **Resolved**. | #42 | ☐ |
| 10.4 | Raise another, click **Resolve with decision…**, fill title and text, confirm. | Status line: "Decision recorded and open point resolved"; the decision says "Resolves open point …". | #42 | ☐ |
| 10.5 | Raise another, click **Close…**, leave **Reason for closing** empty, confirm. | Status line: "Open point closed"; status **Closed**. | #42 | ☐ |
| 10.6 | Use the same **FILTERS** as Decisions. | Filters and **Clear filters** work. | #42 | ☐ |
| 10.7 | Link an open point to the project of today's mock meeting. | Today's **OPEN POINTS FOR TODAY'S MEETINGS** lists it with "Same project as …". | #48 | ☐ |
| 10.8 | Open **Projects**. | The "open points" count includes only status Open items. | #42 | ☐ |

---

## 11. Restricted sensitivity & lock badges — P2

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 11.1 | In **Tasks**, set **Sensitivity** to "restricted" and click **Save changes**. | The card shows "🔒 Restricted" in words. | #30 | ☐ |
| 11.2 | Make that task overdue and open **Today**. | It shows in **OVERDUE** with the "Restricted" badge. | #64 | ☐ |
| 11.3 | Make it a **Waiting** task. | **WAITING BY PERSON** shows the badge on its row. | #64 | ☐ |
| 11.4 | Open the Top 3 **Replace** list. | The restricted task is **not** offered. | #47 | ☐ |
| 11.5 | In **Notes**, open a note and tick **Mark restricted**. | The badge appears in the note header and the Notes list. | #30 | ☐ |
| 11.6 | Mark a decision restricted by editing `sensitivity: restricted` in its file. | **Decisions** list shows the badge on its row. | #64 | ☐ |
| 11.7 | Do the same for an open point. | **Open Points** list shows the badge. | #64 | ☐ |
| 11.8 | Open `.dev-data/_agent/tasks.md` in TextEdit. | The restricted task's title is **not** listed; it is only counted. | #43 | ☐ |
| 11.9 | Mark the "Weekly Product Review" note restricted. | **NEXT MEETINGS** shows the badge on that meeting. | #63, #64 | ☐ |
| 11.10 | Open `.dev-data/_agent/meetings.md`. | That meeting is not named. | #63 | ☐ |
| 11.11 | Hover the badge. | Tooltip: "Restricted: kept away from Agents, Daily Focus, Work Orders and Slack". | #30 | ☐ |
| 11.12 | Set Sensitivity back to "normal" and save. | The badge disappears everywhere after reload. | #30 | ☐ |

---

## 12. Settings cards — P2

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 12.1 | Open **Settings**. | Cards in order: Display timezone, Calendars, My email addresses, Internal domains, Max must-dos, Meetings and morning brief, Google Calendar, Google Drive, Security. | #68 | ☐ |
| 12.2 | Change **DISPLAY TIMEZONE** to `America/New_York`. | Times on Today shift; change it back afterwards. | existing | ☐ |
| 12.3 | In **Meetings and morning brief**, set "Meeting-heavy day from" to `0.5` and **Save**. | "Saved."; Today's Next meetings says "Meeting-heavy day (0.5 h or more)". | #48 | ☐ |
| 12.4 | Untick all **Brief days**. | Red text "Choose at least one day."; **Save** is disabled. | #48 | ☐ |
| 12.5 | Set brief time 06:00, Europe/Paris, Mon–Fri, **Save**. | "Saved." | #48 | ☐ |
| 12.6 | Clear **My email addresses** and **Save**. | "Saved. No address is matched to you."; Today and System show **SETUP NEEDED** again. | #54, #76 | ☐ |
| 12.7 | Clear **Internal domains**. | **Save** is disabled with "Enter at least one domain." | #39 | ☐ |
| 12.8 | Open Settings in two tabs, save a change in tab 1, then save a different change in tab 2. | Tab 2 says it "was changed on another device" and reloads the latest. | #39, #48 | ☐ |
| 12.9 | Restore `me@example.com` and `example.com`. | Warnings disappear. | #76 | ☐ |

---

## 13. System Health — P2

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 13.1 | Open **System** with clean data. | "Healthy" and "No duplicate IDs, broken links, type mismatches, or duplicate canonical notes." | #26 | ☐ |
| 13.2 | With My email addresses empty, open **System**. | **SETUP NEEDED** shows; its button moves focus to the Settings card. | #76 | ☐ |
| 13.3 | Put `owner_person_id:` with a made-up ID in a task file. | Diagnostics name the task's file and the missing ID. | #26 | ☐ |
| 13.4 | Create an empty file `.dev-data/tasks/empty.md`. | Diagnostics list it; nothing crashes. | #26 | ☐ |
| 13.5 | Remove the bad and empty files, reload. | "Healthy" returns. | #26 | ☐ |

---

## 14. Keychain & Connections — P1 (daily app, port 4310)

> Close any unsaved notes first. Restart the daily app with `corepack pnpm update-app`.

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 14.1 | Run `corepack pnpm update-app` and wait for it to finish. | Terminal says LifeOS restarted; `corepack pnpm status` says it is running. | #23 | ☐ |
| 14.2 | If macOS shows a Keychain prompt, click **Always Allow** (not "Allow"). | The prompt closes; LifeOS opens normally. | #23, #77 | ☐ |
| 14.3 | Reload `http://127.0.0.1:4310` three times. | **No** Keychain prompt appears. | #77 | ☐ |
| 14.4 | In Settings, save **My email addresses** and **Internal domains** (your real values). | Each shows its "Saved." message; no Keychain prompt. | #77, #54 | ☐ |
| 14.5 | Check the Google Calendar card. | It says "Credentials configured" and "Connected" if you had connected before. | #23, #77 | ☐ |
| 14.6 | In **Calendar**, click **Sync now**. | Events load ("Google Calendar synchronized"); a Keychain prompt here is a known gap. | #77 | ☐ |
| 14.7 | Restart the app and click **Deny** on a Keychain prompt if one appears. | Only the Connections area shows "Keychain access denied…" with **Retry**; Today and saves still work. | #77 | ☐ |
| 14.8 | Click **Retry** and allow access. | The warning disappears. | #77 | ☐ |
| 14.9 | In Finder, check `/private/tmp` for a LifeOS helper file. | There is none; the helper lives under your Library/Application Support. | #23 | ☐ |

---

## 15. Meetings & enrichment Work Order — P3

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 15.1 | In the test copy, click **Enrich last 48h** on Today. | Status line: "No ended meetings from the last 48 hours need enrichment; no Work Order was written". | #44 | ☐ |
| 15.2 | In the **daily app**, after a day with meetings, click **Enrich last 48h**. | Status line: "Work Order written for N meetings: ask Claude to "run LifeOS enrichment"". | #44 | ☐ |
| 15.3 | Open `data/_inbox/requests/` and read the newest file. | It lists each meeting's title, times, event ID, attendee emails and missing material. | #44 | ☐ |
| 15.4 | Check the same file. | Meetings whose note is restricted are **not** in it. | #44, #63 | ☐ |
| 15.5 | Open `data/_agent/meetings.md`. | The meetings from the Work Order show enrichment state `requested`. | #44, #43 | ☐ |
| 15.6 | In the test copy, open the mock meeting, type a word, and copy its meeting ID from `.dev-data/meetings/`. | You have a meeting ID. | — | ☐ |
| 15.7 | Drop draft **K** (meeting material) with that ID. | Inbox shows a **summary** card and proposal cards. | #45 | ☐ |
| 15.8 | Look at the proposal marked `missed_in_notes: true`. | Its card shows **Not in your notes**. | #45 | ☐ |
| 15.9 | Accept a proposal. | The task keeps the meeting's project, client, product and people. | #45 | ☐ |
| 15.10 | Click **Accept summary**. | Status line: "Summary added to the meeting"; the meeting shows an **AI SUMMARY** card. | #45 | ☐ |
| 15.11 | Check the note editor. | Your own note text is unchanged. | #45, #66 | ☐ |
| 15.12 | Drop draft **K** again with a new `draft_key`. | No duplicate sources or proposals appear. | #45, #59 | ☐ |
| 15.13 | Drop **K** with a different summary and accept it. | The AI SUMMARY card shows only the new summary. | #66 | ☐ |
| 15.14 | Mark the meeting's note restricted, then accept a pending summary for it. | It is refused with a clear message. | #63 | ☐ |
| 15.15 | (Daily app, 48 h after a request with no material) Check Today's **AFTER MEETINGS** card. | Each meeting has its own **Give up** button; clicking says "Stopped waiting for material for this meeting". | #44, #64 | ☐ |

---

## 16. Agent Index — P3

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 16.1 | Open `.dev-data/_agent/`. | Files: overview, tasks, waiting-on, open-points, decisions, projects-clients-products, people, meetings, pending-adoption. | #43 | ☐ |
| 16.2 | Open `overview.md`. | It shows "Generated at …", counts per type and a freshness line. | #43 | ☐ |
| 16.3 | Open `tasks.md`. | Your open tasks are grouped overdue / today / upcoming / no date, each with ID and path. | #43 | ☐ |
| 16.4 | Create a task, wait 5 seconds, re-open `tasks.md`. | The new task is listed; the time is newer. | #43 | ☐ |
| 16.5 | Open `pending-adoption.md` after all drafts are adopted. | It lists nothing pending (any pending draft would be labelled "(pending adoption)"). | #43 | ☐ |
| 16.6 | Open `people.md`. | People show their labels, emails and an external flag. | #43 | ☐ |
| 16.7 | Move the whole `_agent` folder to your Desktop and restart. | LifeOS starts fine and recreates the folder. | #43 | ☐ |
| 16.8 | Search all `_agent` files for "secret" or "token". | Nothing found. | #43 | ☐ |

---

## 17. History, external edits & version retention — P3

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 17.1 | Save one task 12 times (change priority back and forth). | Its folder in `.lifeos/versions/` holds **10** copies, not 12. | #72 | ☐ |
| 17.2 | Make an external edit, then check the newest file in `audit/`. | It names `version_path` pointing at a kept copy. | #29, #72 | ☐ |
| 17.3 | Edit a task in **Tasks** and save. | **No** external-edit audit is written for your own save. | #29 | ☐ |
| 17.4 | Look for a **Restore** button anywhere. | There is none (API only — see Known gaps). | #79 | ☐ |
| 17.5 | Open a meeting note in Calendar and edit its file in TextEdit at the same time. | The note shows a conflict panel with **Keep browser version** / **Keep disk version**. | existing | ☐ |

---

## 18. Knowledge drafts — P3

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 18.1 | Drop draft **I1** (source with a URL). | A Source is created. | #35 | ☐ |
| 18.2 | Drop **I2** (same URL, different case). | The existing Source is reused; no duplicate. | #35 | ☐ |
| 18.3 | Drop **I3** (dictated knowledge note). | It appears under **Knowledge → Published Knowledge Notes**. | #35 | ☐ |
| 18.4 | Drop **I4** (agent-extracted knowledge note). | It becomes a Review card in Inbox instead. | #35 | ☐ |

---

## 19. Accessibility — P3

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 19.1 | On Today, use only Tab, Shift+Tab, Enter and Space. | You can reach Capture, Refresh, Pin, Replace, Dismiss, Show more and Open Inbox. | #47, #64 | ☐ |
| 19.2 | Check every red or coloured marker. | Each has words too ("Restricted", " - ext", "Overdue", "Done", "Pinned"). | #64, #39 | ☐ |
| 19.3 | Turn on VoiceOver (Cmd+F5) and focus a **Give up** or **Pin** button. | It reads the item name, e.g. "Pin Send Alex the pricing deck". | #64 | ☐ |
| 19.4 | Make a Settings save fail (two-tab test 12.8). | The error is announced as an alert. | #68 | ☐ |
| 19.5 | Check any list on Today with more than 7 items. | Never more than 7 rows before **Show N more**. | #64 | ☐ |

---

## 20. Known gaps — don't report these

These are known and expected in Phase A as built.

| Gap | What you'll see | Source |
|---|---|---|
| **No Restore button** for old versions | Restoring an external edit is API-only: `POST /api/v1/history/<audit-event-id>/restore` | #79 |
| **Pruned versions** | Only the last 10 copies per object are kept; an older one says "This version is no longer kept (only the last 10 are)" | ADR 0012 |
| **Undo refused** after later edits | Undo says "Cannot undo: … changed since the patch was applied" if a field changed, or if text was added **below** the appended note | #36, #81 |
| **Calendar sync still reads Keychain** | **Sync now** and **Connect** may show a Keychain prompt; loads and saves should not | #77 |
| **Two-device limits** | If another device's version copy never syncs, an Obsidian edit on top is not flagged | ADR 0012 |
| **No history screen** | External edits are visible only as files in `audit/` and `.lifeos/versions/` | #29 |
| **No sensitivity toggle** on Decisions, Open Points or meetings | Use the note's **Mark restricted**, or edit the file | #30, #63 |
| **Enrichment state not shown** on the meeting page | Only "Give up" rows on Today reflect it | #44 |
| **"Unreviewed" people** not flagged in the People page | The flag exists in the file only | #38 |
| **Brief time** is stored but nothing runs it | The morning routine and Slack DM live outside the app | ADR 0011 |
| **UI does not refresh by itself** after auto-adoption | Reload the page to see adopted drafts | #32 |
| **Stale Work Orders** need 7 days | Hard to test by hand; covered by automated tests | #44 |

---

## 21. Crash-safety checks (optional, technical)

Most crash-safety rules (journals, replays, "reject never becomes accept") **cannot be tested safely by hand**. They are covered by the automated suite (**738 tests**).

These four are safe to try in the **test copy** only:

| # | Step (what to do) | Expected result | Ticket(s) | ☐ Pass |
|---|---|---|---|---|
| 21.1 | Drop 5 drafts, then press Control+C within 1 second and restart. | Each draft is adopted exactly once; no duplicates in Tasks. | #32, #59 | ☐ |
| 21.2 | Click **Accept** on a proposal, press Control+C straight away, then restart. | Exactly one object exists; the item is not pending. | #62, #74 | ☐ |
| 21.3 | Click **Reject** on a merge card, press Control+C straight away, then restart. | The people are **not** merged; the item shows rejected. | #82 | ☐ |
| 21.4 | Accept and reject the same item in two tabs at the same moment. | One outcome only; no orphan object. | #62 | ☐ |

---

## Draft library (synthetic data only)

Copy one block into a new `.md` file. **Change `draft_key` every time.** Replace `<…>` with real IDs from the file names (see 0.4).

**A — dictated task** → `_inbox/drafts/`

```markdown
---
lifeos_draft: 1
kind: task
draft_key: test-001
origin: user-dictated
title: Send Alex the pricing deck
captured_at: 2026-10-04T09:15:00+02:00
due_on: 2026-10-09
priority: High
---
Alex asked for the deck before Friday.
```

**A2** = same as A with `draft_key: test-002` and `title: Book the Q4 offsite room`.

**B — agent-extracted task with evidence**

```markdown
---
lifeos_draft: 1
kind: task
draft_key: extract-001
origin: agent-extracted
title: Share the loyalty test results
captured_at: 2026-10-04T10:00:00+02:00
confidence: high
evidence:
  - field: title
    source: Q3 sync transcript
    locator: "00:12:30"
    quote: "I will share the results"
---
Mentioned near the end of the call.
```

**B2** = B with `kind: decision`, `draft_key: extract-002`, `title: Go with vendor B`.
**B3** = B with `draft_key: extract-003` and `source: Missing transcript`.
**B4** = B with `kind: open-point`, `draft_key: extract-004`, `title: Faut-il prolonger le pilote ?`.

**C — ambiguous name (link resolution)**

```markdown
---
lifeos_draft: 1
kind: task
draft_key: link-001
origin: user-dictated
title: Get the contract back from Joel
captured_at: 2026-10-04T10:00:00+02:00
status: Waiting
waiting_for: Joel
---
```

**C2** = C with `draft_key: link-002`, no `status`/`waiting_for`, and `project: Moonshot`.

**E1 / E2 / E3 — people for a merge**

```markdown
---
lifeos_draft: 1
kind: person
draft_key: person-001
origin: user-dictated
title: Sam Rivera
email: sam.rivera@example.com
captured_at: 2026-10-04T10:00:00+02:00
---
```

**E2** = `draft_key: person-002`, email `s.rivera@example.org`. **E3** = `draft_key: person-003`, email `sam.r@example.net`.

**F1 — patch: mark done** → `_inbox/patches/`

```markdown
---
lifeos_patch: 1
draft_key: patch-001
origin: user-dictated
captured_at: 2026-10-04T11:00:00+02:00
title: Send Alex the pricing deck
type: task
set:
  status: Done
---
```

- **F2** = `draft_key: patch-002`, replace `set:` lines with `append_note: Sent by email.`
- **F3** = `draft_key: patch-003`, `set:` → `waiting_for: Alex Morgan` only.
- **F4** = `draft_key: patch-004`, `title:` of a task that exists twice (capture it twice first).
- **G1** = `draft_key: patch-005`, `set:` → `title: Send Alex the final deck`.
- **G2** = `draft_key: patch-006`, `set:` → `owner: Alex Morgan`.
- **G3** = F1 with `draft_key: patch-007` and `origin: agent-extracted`.
- **G4** = `draft_key: patch-008`, `id: <decision A id>`, `set:` → `superseded_by: <decision B id>`.

**H — Daily Focus brief** (use today's date and real task IDs)

```markdown
---
lifeos_draft: 1
kind: daily-focus
draft_key: focus-2026-10-04-0600
origin: agent-extracted
title: Daily Focus 2026-10-04
captured_at: 2026-10-04T06:00:00+02:00
focus_on: 2026-10-04
generated_at: 2026-10-04T06:00:00+02:00
i_owe:
  - task_id: <task id 1>
    overdue: true
top3:
  - task_id: <task id 1>
    why_today: Alex needs it before the board call
    if_then: If it is 9:00, then I open the deck for 45 min
  - task_id: <task id 2>
    why_today: Finance closes Friday
  - task_id: <task id 3>
    why_today: Blocks the offsite booking
day_shape:
  meeting_hours: 4.5
  free_hours: 3
defer_candidates:
  - task_id: <task id 3>
    reason: Can wait until Thursday
---
A short narrative of the day, under 300 words.
```

**I1–I4 — knowledge**

```markdown
---
lifeos_draft: 1
kind: source
draft_key: source-001
origin: user-dictated
title: Why loyalty programmes fail
url: https://example.com/articles/loyalty
captured_at: 2026-10-04T10:00:00+02:00
---
```

- **I2** = `draft_key: source-002`, `url: https://Example.com/articles/loyalty`.
- **I3** = `kind: knowledge-note`, `draft_key: note-001`, `title: Points expiry kills engagement`, body text.
- **I4** = I3 with `draft_key: note-002` and `origin: agent-extracted`.

**J1 / J2 — bad drafts**

- **J1** = draft A with the `draft_key` line removed.
- **J2** = draft A with `draft_key: bad-002` and `kind: shopping-list`.

**K — meeting material** (use the meeting ID from 15.6)

```markdown
---
lifeos_draft: 1
kind: meeting-material
draft_key: material-001
origin: agent-extracted
title: Material for Weekly Product Review
captured_at: 2026-10-04T12:00:00+02:00
meeting: <meeting id>
sources:
  - source_type: meet-transcript
    url: https://example.com/transcripts/1
    external_id: transcript-1
    occurred_at: 2026-10-04T09:00:00Z
proposals:
  - kind: task
    title: Send the roadmap to Jamie
    confidence: high
    missed_in_notes: true
    evidence:
      - source: transcript-1
        locator: "00:12:30"
---
The team agreed the Q4 roadmap. Jamie owes the pricing review.
```
