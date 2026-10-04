# LifeOS Phase A — manual test checklist

> Branch tested: `feature/phase-a-close-21`. Rebuilt 4 October 2026 for the final Phase A build.
> Use **synthetic data only**: names and addresses on `example.com`, test data in `code/.dev-data/`.

## How to use

- One line is one test. Do the action, then check the **Expect** part.
- Pass: change `- [ ]` to `- [x]`. Or click the box, if your Markdown viewer supports it (Obsidian, VS Code preview, GitHub).
- Fail: leave the box empty. Add an indented line under the test:

  ```markdown
  - [ ] **3.2** Type `Call Jamie about Q4` in QUICK CAPTURE ...
    > Failed: the status line said "Capture failed".
  ```

- Update the **Progress** line at the top of a section when you finish it.
- **P1** = test before daily use. **P2** = test this week. **P3** = test when you have time.
- Bold words are the exact button, card or label on screen.
- "Status line" = the small grey text at the bottom of the left sidebar. Success and error messages show there.
- _(#48)_ = the GitHub ticket the test checks.

---

## 0. Before you start

Progress: 0 / 8 done

### 0.1 Which copy of LifeOS to use

| Copy | Address | Data | Use it for |
|---|---|---|---|
| **Test copy** (dev) | `http://127.0.0.1:5174` | `code/.dev-data/` (fake) | Everything not marked "daily app" |
| **Daily app** (stable) | `http://127.0.0.1:4310` | `LifeOS App/data/` (real) | Section 14, section 21 and rows marked "daily app" |

- Tests create fake tasks and people. Keep them out of your real vault.
- In the daily app, only **look**. Don't create test objects there.
- The test copy keeps its backups in `code/.dev-backups/`.

### 0.2 Setup steps

- [ ] **S1** In Finder, rename `code/.dev-data` to `.dev-data-old`. (Press **Cmd+Shift+.** to see hidden folders.) → Expect: the old test data is archived, not deleted.
- [ ] **S2** In Terminal, in the `code` folder, run `corepack pnpm dev`. → Expect: Terminal says the server is listening; a new `.dev-data` folder appears.
- [ ] **S3** Open `http://127.0.0.1:5174` in your browser. → Expect: Today opens with the heading "What needs your attention?".
- [ ] **S4** Look for the **SETUP NEEDED** card on Today. → Expect: "Your email addresses are not set", a line saying nobody is marked External either, and two buttons.
- [ ] **S5** Click **Set my email addresses in Settings**, type `me@example.com`, click **Save**. → Expect: green text "Saved. Attendees with these addresses are now you."
- [ ] **S6** In the **Internal domains** card, type `example.com` and click **Save**. → Expect: green text "Saved. People labels now use these domains."
- [ ] **S7** Go back to Today. → Expect: the **SETUP NEEDED** card is gone.
- [ ] **S8** In Finder, open `code/.dev-data/_inbox/`. → Expect: folders `drafts`, `patches`, `requests`, `processed`, `failed`.

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

### 0.4 How to find an object's ID

Some drafts need an ID. The ID is the **end of the file name**, after the two dashes.

Example: `tasks/2026-10-04-0915-send-alex-the-pricing-deck--0199a1b2-....md` → the ID is `0199a1b2-...`.

---

## 1. Priority order

| Priority | Sections | Why |
|---|---|---|
| **P1** | 0 Setup · 2 Data safety · 3 Today · 4 Inbox Drafts · 5 Review Items · 14 Keychain · 20 Backups · 21 Calendar offline · 22 Editor safety | You rely on these every day; data loss or prompt storms would block use |
| **P2** | 6 Daily Focus · 7 Patch Drafts · 8 People · 9 Decisions · 10 Open Points · 11 Restricted · 12 Settings · 13 System Health | Important, but a failure is annoying, not dangerous |
| **P3** | 15 Meetings & enrichment · 16 Agent Index · 17 History & restore · 18 Knowledge drafts · 19 Accessibility · 23 Skills | Agent-facing or rarely touched; test when convenient |

**Test count:** P1 = 120 · P2 = 105 · P3 = 66 · optional crash checks = 4 · **Total 295** (setup S1–S8 not counted).

Short on time? Do sections 3, 4, 14 and 20 first.

---

## 2. Data safety — P1

Progress: 0 / 20 done

- [ ] **2.1** In **Tasks**, type `Safety test task` and click **Create**. → Expect: the task shows "Origin: LifeOS app" and "Revision 1". _(#30)_
- [ ] **2.2** In Finder, create `.dev-data/tasks/broken.md` with three lines: `---`, `title: [oops`, `---`. → Expect: nothing crashes; other tasks still show. _(#26)_
- [ ] **2.3** Open **System**. → Expect: "Object graph" shows **Attention**; **INTEGRITY DIAGNOSTICS** lists `tasks/broken.md` with a reason. _(#26)_
- [ ] **2.4** Move `broken.md` to your Desktop, then reload **System**. → Expect: the diagnostic is gone; "Healthy" returns. _(#26)_
- [ ] **2.5** In Finder, duplicate the "Safety test task" file (Cmd+D) inside `.dev-data/tasks/`. → Expect: a second file "… copy.md" with the same ID exists. _(#27)_
- [ ] **2.6** Reload **System**. → Expect: diagnostics name **both** file paths as a duplicate ID. _(#27)_
- [ ] **2.7** In **Tasks**, change the task's priority and click **Save changes**. → Expect: save fails; the status line names the duplicate ID and both paths. _(#27, #58)_
- [ ] **2.8** Move the "copy" file to your Desktop, reload, and save the priority again. → Expect: save works; the revision goes up by 1. _(#27)_
- [ ] **2.9** Open the task file in TextEdit, change its title and save. Don't reload the browser. → Expect: the file saves; the browser still shows the old title. _(#28)_
- [ ] **2.10** In the browser, change the same task's priority and click **Save changes**. → Expect: refused as a conflict; your TextEdit change is not overwritten. _(#28)_
- [ ] **2.11** Reload the page. → Expect: the title you typed in TextEdit shows. _(#28, #29)_
- [ ] **2.12** In Finder, open `.dev-data/audit/` and sort by date. → Expect: the newest file mentions `object.changed-externally` for that task. _(#29)_
- [ ] **2.13** Open `.dev-data/.lifeos/versions/` and the folder named with the task's ID. → Expect: copies named `<revision>--<code>.md`, including the version before your edit. _(#29, #72)_
- [ ] **2.14** Stop the test copy, change the task title in TextEdit, then restart. → Expect: a new `object.changed-externally` audit file appears after restart. _(#69)_
- [ ] **2.15** In TextEdit, only swap two lines in the task's front matter (top block). Save and wait 5 seconds. → Expect: **no** new external-edit audit file. _(#69)_
- [ ] **2.16** In **System**, click **Create & verify snapshot**. → Expect: status line "Snapshot created and restoration drill passed"; a new row appears. _(ADR 0004)_
- [ ] **2.17** Click **Test restore** on that row. → Expect: "Restoration drill passed" with a file count and size. _(ADR 0004)_
- [ ] **2.18** In a task file, set `area: finance` in TextEdit and save. → Expect: **System** warns the Area is not an agreed value; the task still loads. _(#30)_
- [ ] **2.19** In **Tasks**, open the **Area** dropdown on any task. → Expect: only the six agreed areas, plus "None". _(#30)_
- [ ] **2.20** Stop the server while typing in a note in **Notes**, then restart it. → Expect: a "Reconnecting…" card shows; your text is kept and saves when the server is back. _(existing)_

---

## 3. Today page & live panels — P1

Progress: 0 / 12 done

- [ ] **3.1** Open **Today**. → Expect: three cards: **Active tasks**, **Review inbox**, **Today's events**. _(#48)_
- [ ] **3.2** In **QUICK CAPTURE**, type `Call Jamie about Q4` and press Enter. → Expect: status line "Captured as an Inbox task"; Active tasks goes up by 1. _(#31)_
- [ ] **3.3** In **Tasks**, give one task yesterday's due date and click **Save changes**. → Expect: Today's **OVERDUE · 1** shows it with "Overdue by 1 day". _(#48)_
- [ ] **3.4** Give another task today's date. → Expect: **DUE TODAY** lists it. _(#48)_
- [ ] **3.5** Give a third task priority **High** and a date next week. → Expect: **UPCOMING HIGH PRIORITY** lists it with "High priority · due …". _(#48)_
- [ ] **3.6** Set a task to status **Waiting**, with **Waiting for** = a person. → Expect: **WAITING BY PERSON** shows the person's name, then the task. _(#48, #64)_
- [ ] **3.7** Look at **NEXT MEETINGS**. → Expect: the mock "Weekly Product Review" with its time, and "h of meetings today". _(#48)_
- [ ] **3.8** Look at **INBOX AND AGENTS**. → Expect: "… review items awaiting confirmation" and "Nothing awaiting adoption". _(#48)_
- [ ] **3.9** Click **Open Inbox** in that panel. → Expect: the Inbox page opens. _(#48)_
- [ ] **3.10** Create 9 overdue tasks, then open Today. → Expect: **OVERDUE** shows 6 rows and a **Show 3 more** button. _(#48, #64)_
- [ ] **3.11** Press Tab until **Show 3 more** is focused, then press Enter. → Expect: all 9 rows show; the button now says **Show fewer**. _(#64)_
- [ ] **3.12** Mark 2 of those tasks **Done**, then reload Today. → Expect: **OVERDUE** shows all 7 rows and no button (hiding one row would save nothing). _(#64)_

---

## 4. Inbox Drafts & adoption — P1

Progress: 0 / 15 done

Templates are in the **Draft library** at the end of this file.

- [ ] **4.1** Open **Inbox**. → Expect: **AGENT DRAFTS** says "Nothing awaiting adoption" and shows **Adopt now**. _(#31)_
- [ ] **4.2** Stop the test copy, drop draft **A** (dictated task), then start it again. → Expect: the task is adopted at start, without any click. _(#31, #32)_
- [ ] **4.3** Open **Tasks**. → Expect: "Send Alex the pricing deck" exists, status Inbox, "Origin: Dictated by you". _(#31, #30)_
- [ ] **4.4** Open `_inbox/processed/`. → Expect: the draft is there, with a `.result.md` naming the new task ID. _(#31)_
- [ ] **4.5** With the app running, drop draft **A2** and wait 5–10 seconds. → Expect: it is adopted on its own; a reload shows the new task. _(#32)_
- [ ] **4.6** Drop draft **A2** again, same text and same `draft_key`. → Expect: no second task; `.result.md` points to the first result. _(#32)_
- [ ] **4.7** Drop draft **A2** with the same `draft_key` but a different title. → Expect: it moves to `_inbox/failed/`; the reason mentions an idempotency conflict. _(#32)_
- [ ] **4.8** Drop draft **J1** (no `draft_key`). → Expect: it fails with a reason naming `draft_key`. _(#31)_
- [ ] **4.9** Drop draft **J2** (unknown `kind`). → Expect: it fails with a reason naming `kind`. _(#31)_
- [ ] **4.10** Open **Inbox**. → Expect: failed drafts are listed with their reason, under "Failed drafts are kept in `_inbox/failed/`". _(#31)_
- [ ] **4.11** Open **Today**. → Expect: **INBOX AND AGENTS** shows "Failed draft: …" rows with the file path. _(#48)_
- [ ] **4.12** Open **System**. → Expect: each failed draft is listed as "…: draft not adopted (reason)". _(#31, #26)_
- [ ] **4.13** Restart the test copy, then open `_inbox/failed/`. → Expect: the failed drafts are still there; nothing was deleted. _(#31)_
- [ ] **4.14** Stop the test copy, drop two drafts, start it, and open **Inbox** within 5 seconds. → Expect: either they are already adopted, or **Adopt now** adopts them; the status line counts each outcome. _(#31, #32)_
- [ ] **4.15** Drop draft **C2** (dictated task, unknown project "Moonshot"). → Expect: the task is still created; a link-resolution Review Item also appears in Inbox. _(#33)_

---

## 5. Review Items — P1

Progress: 0 / 25 done

### 5a. Create-type proposals (task, decision, open point)

- [ ] **5.1** Drop draft **B** (agent-extracted task with evidence). → Expect: **no** task is created; a Review card appears in Inbox; the Inbox nav item shows a count. _(#34)_
- [ ] **5.2** Look at the card. → Expect: "task · High confidence · pending · agent-extracted" and an evidence line with locator "00:12:30". _(#34)_
- [ ] **5.3** Change the title box, then try **Accept task**. → Expect: **Accept task** is disabled ("Save your edits first"). _(#34)_
- [ ] **5.4** Click **Save edit**. → Expect: status line "Proposal updated"; **Accept task** is enabled again. _(#34)_
- [ ] **5.5** Change **Owner**, **Due**, **Priority** and **Project**, click **Save edit**, then **Accept task**. → Expect: "Task accepted and published"; the task has your values and "Origin: Extracted by an agent". _(#34, #57)_
- [ ] **5.6** Drop draft **B2** (agent-extracted decision), then click **Reject**. → Expect: status line "Proposal rejected"; no decision is created. _(#34)_
- [ ] **5.7** Drop draft **B3** (evidence points to a missing source). → Expect: the card shows "Unresolved source: …" and does not crash. _(#34)_
- [ ] **5.8** Drop draft **B4** (open point in French). → Expect: the proposal keeps the French title; nothing is translated. _(#34)_
- [ ] **5.9** Double-click **Accept** very fast on a new proposal. → Expect: exactly **one** object is created. _(#62)_
- [ ] **5.10** Open Inbox in two browser tabs and accept the same item in both. → Expect: one object only; the second tab shows it as handled or refreshes cleanly. _(#62)_

### 5b. Link-resolution card

Set up first: in **People**, create "Joel Martin" and "Joel Durand". Set **Given name** to `Joel` on both and click **Save changes**.

- [ ] **5.11** Drop draft **C** (dictated task, `waiting_for: Joel`). → Expect: the task is created without a "waiting for" person; a link card appears in Inbox. _(#33)_
- [ ] **5.12** Look at the link card. → Expect: "several matches", with both Joels listed under "Link "Joel" to". _(#57)_
- [ ] **5.13** Press Tab into the list, pick a Joel with the arrow keys, then press Space. → Expect: the radio button moves with the keyboard. _(#57)_
- [ ] **5.14** Click **Link**. → Expect: status line "Link saved"; the task now waits for that Joel. _(#33, #57)_
- [ ] **5.15** Open the link card from 4.15 ("Moonshot"). → Expect: "no match", with **Create project "Moonshot" and link** and **Reject**. _(#57)_
- [ ] **5.16** Click **Create project "Moonshot" and link**. → Expect: project "Moonshot" exists and the task is linked to it. _(#57)_
- [ ] **5.17** On a new link card, pick a Joel. In another tab, delete that Joel in **People**. Then click **Link**. → Expect: the server's error shows as text in the card; nothing is linked. _(#57)_

### 5c. Person merge card

- [ ] **5.18** Drop person draft **E1**, then **E2** (same name, other address). → Expect: a merge card with a confidence label; **no** automatic merge. _(#40)_
- [ ] **5.19** Click **Keep separate**. → Expect: status line "Proposal rejected"; both people remain. _(#40)_
- [ ] **5.20** Drop **E3**, make this newest Sam the owner of a task, then click **Merge** on the new card. → Expect: status line "People merged"; the merged Sam leaves People. _(#40)_
- [ ] **5.21** Open the task from 5.20. → Expect: its owner is now the surviving Sam. _(#40)_
- [ ] **5.22** Leave a proposal naming Sam B pending. Merge B into A, then accept the proposal. → Expect: the new object points to Sam A. _(#65)_

### 5d. Update card (from a patch)

- [ ] **5.23** Drop patch **G1** (change a task's title). → Expect: an update card with a **Field / Current / Proposed** table. _(#37)_
- [ ] **5.24** Click **Apply change**. → Expect: status line "Change applied"; the task title changes. _(#37)_
- [ ] **5.25** Drop **G1** again with a new key, edit the task by hand, then click **Apply change**. → Expect: refused as a conflict; your hand edit stays. _(#37)_

### 5e. Summary card

Tested in section 15 (needs a meeting): **Accept summary** writes an **AI SUMMARY** card on the meeting, never into your note. _(#45, #66)_

---

## 6. Daily Focus & Top 3 overrides — P2

Progress: 0 / 19 done

- [ ] **6.1** With no brief dropped, open **Today**. → Expect: **DAILY FOCUS** says "No brief for today yet. Top 3 suggested by priority, then due date." _(#47)_
- [ ] **6.2** Look at **Top 3**. → Expect: up to 3 open tasks, high priority and earliest due first, each with a reason. _(#47)_
- [ ] **6.3** Drop brief draft **H** with today's date and three real task IDs. → Expect: Today shows "Generated at HH:MM". _(#46)_
- [ ] **6.4** Check the section order. → Expect: **I owe → Top 3 → Waiting and decisions → Meeting prep → Day shape**, then **Consider deferring**. _(#46)_
- [ ] **6.5** Look at the Top 3 rows. → Expect: each shows its "why today" text and its if-then text. _(#46)_
- [ ] **6.6** Mark one Top 3 task **Done** in Tasks, then reload Today. → Expect: it shows "Done", struck through, at the bottom. _(#46)_
- [ ] **6.7** Delete a task the brief names, then reload Today. → Expect: that row reads "Missing: deleted or not found"; nothing crashes. _(#46)_
- [ ] **6.8** Click **Refresh** in Daily Focus. → Expect: status line "Re-plan requested for <date>: ask Claude to "run LifeOS replan""; a new file in `_inbox/requests/`. _(#46)_
- [ ] **6.9** Click **Pin** on a Top 3 item. → Expect: "Pinned to today's Top 3"; the row says "Pinned"; the button now says **Unpin**. _(#47)_
- [ ] **6.10** Click **Replace**, pick a task in "Choose a task…", click **Replace**. → Expect: the new task shows "Replaces "…"". _(#47)_
- [ ] **6.11** Click **Replace**, then press Escape. → Expect: the replace box closes; nothing changes. _(#47)_
- [ ] **6.12** Click **Dismiss** on a Top 3 item. → Expect: it moves under "Dismissed for today" with a **Restore** button. _(#47)_
- [ ] **6.13** Click **Restore**. → Expect: it returns to the Top 3. _(#47)_
- [ ] **6.14** Drop a **newer** brief for the same date (new `draft_key`). → Expect: your pins, replaces and dismissals still apply. _(#47, #60)_
- [ ] **6.15** Click **Clear my Top 3 changes for today**. → Expect: "Your Top 3 changes for today were cleared". _(#47)_
- [ ] **6.16** In **Settings → Max must-dos**, choose 2 and click **Save**. → Expect: Today's Top 3 shows at most 2 items. _(#47)_
- [ ] **6.17** With fewer than the max shown, pick a task in "Add a task to today's Top 3…" and click **Pin**. → Expect: the task joins the Top 3. _(#47)_
- [ ] **6.18** Mark one brief task **restricted**, then reload Today. → Expect: it is hidden; Daily Focus says "1 restricted item not shown". _(#46, #63)_
- [ ] **6.19** Drop a brief with a body far over 300 words. → Expect: still adopted; a "Note: …" line warns about length. _(#46)_

---

## 7. Patch Drafts (changes from chat) — P2

Progress: 0 / 10 done

Save patch files in `_inbox/patches/`. Set `captured_at` to **now**.

- [ ] **7.1** Drop patch **F1** (mark "Send Alex the pricing deck" Done). → Expect: the task is Done, with no Review Item. _(#36)_
- [ ] **7.2** Open **Inbox → APPLIED CHANGES**. → Expect: a row "status Inbox → Done" with an **Undo** button. _(#36)_
- [ ] **7.3** Click **Undo**. → Expect: "Undid the change to …"; the task is back to Inbox; the row says "Undone". _(#36, #61)_
- [ ] **7.4** Drop patch **F2** (append a note). → Expect: the note text is added once, at the end of the task's body. _(#36, #61)_
- [ ] **7.5** Change the task's status by hand, then click **Undo** on an older patch. → Expect: refused with "Cannot undo: … changed since the patch was applied". _(#36)_
- [ ] **7.6** Drop patch **F3** (`waiting_for` without status Waiting). → Expect: it fails with a clear reason; nothing changes. _(#36)_
- [ ] **7.7** Drop patch **F4** (title that matches two tasks). → Expect: it fails, saying the title matches several objects. _(#36)_
- [ ] **7.8** Drop patch **G2** (owner change, dictated). → Expect: it becomes an update Review Item, not applied. _(#37)_
- [ ] **7.9** Drop patch **G3** (`origin: agent-extracted`, status Done). → Expect: it becomes an update Review Item. _(#37)_
- [ ] **7.10** Edit a task's status by hand. Then drop **F1** for it with `captured_at` one hour ago. → Expect: it becomes an update Review Item instead of overwriting. _(#37, #81)_

---

## 8. People, external marker & unreviewed people — P2

Progress: 0 / 17 done

- [ ] **8.1** In **Settings → My email addresses**, add `jamie.chen@example.com` and click **Save**. → Expect: the saved message shows. _(#54, #38)_
- [ ] **8.2** In **Calendar**, open "Weekly Product Review" and type one word in the note. → Expect: the note is created; **Attendees** lists Alex and Example (you). _(#38)_
- [ ] **8.3** Open **People**. → Expect: "Alex Morgan" with "Origin: Calendar"; no new "Jamie Chen". _(#38)_
- [ ] **8.4** Re-open the same event and type again. → Expect: no duplicate Alex. _(#38)_
- [ ] **8.5** Check Alex's **Shown as** label. → Expect: just "Alex" (only one Alex exists), followed by " · unreviewed". _(#39, #87)_
- [ ] **8.6** Create a person "Alex Smith" with **Given name** `Alex`. → Expect: both show full names ("Alex Morgan", "Alex Smith"). _(#39)_
- [ ] **8.7** In **Settings → Internal domains**, change to `example.org` and click **Save**. → Expect: Alex shows "Alex Morgan - ext", with " - ext" in red. _(#39)_
- [ ] **8.8** On Alex's card, set **External** to "Internal". → Expect: status line "Marked internal"; " - ext" disappears. _(#39)_
- [ ] **8.9** Set **External** back to "Auto (by email domain…)". → Expect: "External flag follows the email domain again". _(#39)_
- [ ] **8.10** (Daily app, look only) After **Sync now**, find a person created from an address like `first.last@…`. → Expect: the name is "First Last" in title case, hyphens and accents kept. _(#38)_
- [ ] **8.11** Check your own person card ("Example User"). → Expect: **Delete** is disabled; there is no External picker. _(#38)_
- [ ] **8.12** Set Internal domains back to `example.com`. → Expect: " - ext" disappears for example.com people. _(#39)_
- [ ] **8.13** In **People**, look at Alex Morgan's card. → Expect: **Unreviewed**, "created from a calendar invite" and a **Confirm** button. _(#87)_
- [ ] **8.14** Open the "Weekly Product Review" meeting and look at **Attendees**. → Expect: Alex's name ends with " · unreviewed" in words. _(#87)_
- [ ] **8.15** Back in People, click **Confirm** on Alex. → Expect: status line "Alex Morgan confirmed"; the Unreviewed marker is gone on the card and in Attendees. _(#87)_
- [ ] **8.16** Look at Sam Rivera (from draft **E1**). → Expect: **Unreviewed** and "created automatically from an inbox draft". _(#87)_
- [ ] **8.17** On Sam's card, change any field and click **Save changes**. → Expect: the Unreviewed marker is gone (saving counts as a review). _(#87)_

---

## 9. Decisions — P2

Progress: 0 / 10 done

- [ ] **9.1** In **Decisions**, type a title under **RECORD A DECISION** and click **Record**. → Expect: "Decision recorded"; it shows as **Active**. _(#41)_
- [ ] **9.2** Select it. → Expect: "Origin: LifeOS app" and "Recorded by hand: no evidence attached". _(#41)_
- [ ] **9.3** Change its text and click **Save changes**. → Expect: status line "Decision saved". _(#41)_
- [ ] **9.4** Click **Supersede…**, fill the new title and "Why it changed", click **Supersede**. → Expect: "Decision superseded"; old shows "Superseded by …", new shows "Supersedes …". _(#41)_
- [ ] **9.5** Select the old (superseded) decision. → Expect: no **Supersede…** ("Only active decisions can be superseded"). _(#41)_
- [ ] **9.6** Use each **FILTERS** field: project, client, product, person, status, "Decided from/to". → Expect: the list narrows correctly. _(#41)_
- [ ] **9.7** Click **Clear filters**. → Expect: the full list returns. _(#41)_
- [ ] **9.8** Link a decision to a project, then open **Projects**. → Expect: the project card's "decisions" count includes it. _(#41)_
- [ ] **9.9** Accept a decision proposal from Inbox (draft **B2**), then open it in Decisions. → Expect: **EVIDENCE** shows the source and locator. _(#41, #34)_
- [ ] **9.10** Record decisions A and B. Drop patch **G4** (A superseded by B) and click **Apply change**. → Expect: A shows "Superseded by B"; B shows "Supersedes A". _(#67)_

---

## 10. Open Points — P2

Progress: 0 / 8 done

- [ ] **10.1** In **Open Points**, type a question under **RAISE AN OPEN POINT** and click **Record**. → Expect: "Open point recorded"; status **Open**. _(#42)_
- [ ] **10.2** Click **Resolve…**, leave both boxes empty, click **Resolve**. → Expect: refused; a summary or a decision is required. _(#42)_
- [ ] **10.3** Type a **Resolution summary** and click **Resolve**. → Expect: "Open point resolved"; status **Resolved**. _(#42)_
- [ ] **10.4** Raise another. Click **Resolve with decision…**, fill title and text, confirm. → Expect: "Decision recorded and open point resolved"; the decision says "Resolves open point …". _(#42)_
- [ ] **10.5** Raise another. Click **Close…**, leave **Reason for closing** empty, confirm. → Expect: "Open point closed"; status **Closed**. _(#42)_
- [ ] **10.6** Use **FILTERS** and **Clear filters**, as in Decisions. → Expect: both work. _(#42)_
- [ ] **10.7** Link an open point to the project of today's mock meeting. → Expect: Today's **OPEN POINTS FOR TODAY'S MEETINGS** lists it with "Same project as …". _(#48)_
- [ ] **10.8** Open **Projects**. → Expect: the "open points" count includes only status Open items. _(#42)_

---

## 11. Restricted sensitivity & lock badges — P2

Progress: 0 / 23 done

### 11a. Tasks and notes

- [ ] **11.1** In **Tasks**, set **Sensitivity** to "restricted" and click **Save changes**. → Expect: the card shows "🔒 Restricted" in words. _(#30)_
- [ ] **11.2** Make that task overdue, then open **Today**. → Expect: it shows in **OVERDUE** with the "Restricted" badge. _(#64)_
- [ ] **11.3** Make it a **Waiting** task. → Expect: **WAITING BY PERSON** shows the badge on its row. _(#64)_
- [ ] **11.4** Open the Top 3 **Replace** list. → Expect: the restricted task is **not** offered. _(#47)_
- [ ] **11.5** Open `.dev-data/_agent/tasks.md` in TextEdit. → Expect: the restricted task's title is **not** listed, only counted. _(#43)_
- [ ] **11.6** In **Notes**, open a note and tick **Mark restricted**. → Expect: the badge shows in the note header and the Notes list. _(#30)_
- [ ] **11.7** Hover any lock badge. → Expect: tooltip "Restricted: kept away from Agents, Daily Focus, Work Orders and Slack". _(#30)_
- [ ] **11.8** Set the task's Sensitivity back to "normal" and save. → Expect: the badge is gone everywhere after reload. _(#30)_

### 11b. Decisions and Open Points

- [ ] **11.9** In **Decisions**, select a decision. → Expect: "Sensitivity: **Normal**" and a **Mark restricted** button. _(#86)_
- [ ] **11.10** Click **Mark restricted**. → Expect: "Marked restricted: this decision is kept away from Agents"; "Sensitivity: Restricted" and the lock badge, also on its list row. _(#86, #64)_
- [ ] **11.11** Open `.dev-data/_agent/decisions.md`. → Expect: that decision's title is not listed. _(#86, #43)_
- [ ] **11.12** Click **Mark normal**. → Expect: "Marked normal: this decision can be shared with Agents again"; the badge is gone. _(#86)_
- [ ] **11.13** Change the decision's text in TextEdit and save. Don't reload. Click **Mark restricted**. → Expect: refused: "This decision was changed elsewhere, so its sensitivity was not changed. The latest version is loaded; try again." _(#86)_
- [ ] **11.14** In **Open Points**, select one and click **Mark restricted**. → Expect: "Marked restricted: this open point is kept away from Agents"; the badge shows on its list row. _(#86, #64)_
- [ ] **11.15** Click **Mark normal** on it. → Expect: the badge is gone. _(#86)_

### 11c. Meetings

- [ ] **11.16** In **Calendar**, open "Weekly Product Review". Click **Mark restricted** in the meeting header. → Expect: "Marked restricted: this meeting is kept away from Agents". _(#86)_
- [ ] **11.17** Open **Today**. → Expect: **NEXT MEETINGS** shows the Restricted badge on that meeting. _(#86, #64)_
- [ ] **11.18** Open `.dev-data/_agent/meetings.md`. → Expect: that meeting is not named. _(#86, #63)_
- [ ] **11.19** Click **Mark normal** on the meeting. → Expect: "Marked normal: this meeting can be shared with Agents again". _(#86)_
- [ ] **11.20** In the same meeting's note, tick **Mark restricted**. → Expect: the header still says "Sensitivity: Normal" and adds "Its note is restricted, so this meeting is kept away from Agents and Work Orders too." _(#92)_
- [ ] **11.21** Open **Today**. → Expect: **NEXT MEETINGS** shows the Restricted badge, even though only the note is restricted. _(#92, #63)_
- [ ] **11.22** On the meeting, click **Mark restricted**, then **Mark normal**. → Expect: "Marked normal, but this meeting stays kept away from Agents and Work Orders because its note is restricted". _(#92)_
- [ ] **11.23** Untick **Mark restricted** on the note. → Expect: the badge is gone from Today. _(#63)_

---

## 12. Settings cards & setup warnings — P2

Progress: 0 / 13 done

- [ ] **12.1** Open **Settings**. → Expect: cards in order: Display timezone, Calendars, My email addresses, Internal domains, Max must-dos, Meetings and morning brief, Off-Drive backup folder, Google Calendar, Google Drive, Security. _(#68, #84)_
- [ ] **12.2** Change **DISPLAY TIMEZONE** to `America/New_York`. → Expect: times on Today shift. Change it back afterwards. _(existing)_
- [ ] **12.3** In **Meetings and morning brief**, set "Meeting-heavy day from" to `0.5` and click **Save**. → Expect: "Saved."; Today's Next meetings says "Meeting-heavy day (0.5 h or more)". _(#48)_
- [ ] **12.4** Untick all **Brief days**. → Expect: red text "Choose at least one day."; **Save** is disabled. _(#48)_
- [ ] **12.5** Set brief time 06:00, Europe/Paris, Mon–Fri, and click **Save**. → Expect: "Saved." _(#48)_
- [ ] **12.6** Clear **My email addresses** and click **Save**. → Expect: "Saved. No address is matched to you."; Today and System show **SETUP NEEDED**. _(#54, #76)_
- [ ] **12.7** Clear the **Internal domains** box. → Expect: **Save** is disabled, with "Enter at least one domain." _(#39)_
- [ ] **12.8** Open Settings in two tabs. Save a change in tab 1, then a different change in tab 2. → Expect: tab 2 says it "was changed on another device" and loads the latest. _(#39, #48)_
- [ ] **12.9** Restore `me@example.com` in My email addresses. → Expect: the SETUP NEEDED card is gone. _(#76)_
- [ ] **12.10** In Finder, move `.dev-data/settings/internal-domains.md` to your Desktop. Wait 5 seconds and reload Today. → Expect: **SETUP NEEDED** says "Internal domains are not set" and "Until they are, nobody is marked External automatically." _(#76)_
- [ ] **12.11** Click **Set internal domains in Settings**. → Expect: Settings opens on the Internal domains card, which says "Not set yet: nobody is marked External automatically." _(#76)_
- [ ] **12.12** Open **System**. → Expect: the same SETUP NEEDED card shows. _(#76)_
- [ ] **12.13** Type `example.com` in Internal domains and click **Save**. → Expect: the warning is gone on Today and System. _(#76)_

---

## 13. System Health — P2

Progress: 0 / 5 done

- [ ] **13.1** Open **System** with clean data. → Expect: "Healthy" and "No duplicate IDs, broken links, type mismatches, or duplicate canonical notes." _(#26)_
- [ ] **13.2** With My email addresses empty, open **System** and click the SETUP NEEDED button. → Expect: focus moves to the matching Settings card. _(#76)_
- [ ] **13.3** Put `owner_person_id:` with a made-up ID in a task file. → Expect: diagnostics name the task's file and the missing ID. _(#26)_
- [ ] **13.4** Create an empty file `.dev-data/tasks/empty.md`. → Expect: diagnostics list it; nothing crashes. _(#26)_
- [ ] **13.5** Move the bad and empty files to your Desktop, then reload. → Expect: "Healthy" returns. _(#26)_

---

## 14. Keychain & Connections — P1 (daily app, port 4310)

Progress: 0 / 14 done

> Close any unsaved notes first. Restart the daily app with `corepack pnpm update-app`.

- [ ] **14.1** Run `corepack pnpm update-app` and wait for it to finish. → Expect: Terminal says LifeOS restarted; `corepack pnpm status` says it is running. _(#23)_
- [ ] **14.2** If macOS shows a Keychain prompt, click **Always Allow** (not "Allow"). → Expect: the prompt closes; LifeOS opens normally. _(#23, #77)_
- [ ] **14.3** Reload `http://127.0.0.1:4310` three times. → Expect: **no** Keychain prompt. _(#77)_
- [ ] **14.4** In Settings, save **My email addresses** and **Internal domains** (your real values, unchanged). → Expect: each shows its "Saved." message; no Keychain prompt. _(#77, #54)_
- [ ] **14.5** Look at the Google Calendar card. → Expect: "Credentials configured", and "Connected" if you connected before. _(#23, #77)_
- [ ] **14.6** In **Calendar**, click **Sync now**. → Expect: events load ("Google Calendar synchronized"). A Keychain prompt here is a known gap. _(#77)_
- [ ] **14.7** In Finder, check `/private/tmp` for a LifeOS helper file. → Expect: none; the helper lives under your Library/Application Support. _(#23)_

Only if macOS shows a Keychain prompt when LifeOS starts (it won't after **Always Allow**):

- [ ] **14.8** Restart the daily app and click **Deny** on the Keychain prompt. → Expect: Today still opens; saves still work. _(#77)_
- [ ] **14.9** Look at Today's **NEXT MEETINGS**. → Expect: a banner "Offline: showing meetings already in LifeOS (last synced …)" and "Keychain access was denied, so LifeOS cannot read the Google Calendar sign-in". _(#88, #94)_
- [ ] **14.10** Check the meetings listed. → Expect: only your real stored meetings; **no** demo "Weekly Product Review". _(#94)_
- [ ] **14.11** Open **Settings**. → Expect: "Keychain access denied. LifeOS cannot tell whether Google credentials are saved until you allow access." with **Retry**. _(#77)_
- [ ] **14.12** On Today's banner, click **Retry**, then **Deny** again. → Expect: the banner stays; the status line says "Calendar is still offline: …", not "Calendar reloaded". _(#94)_
- [ ] **14.13** Click **Retry** again, then **Always Allow**. → Expect: status line "Calendar reloaded"; the banner is gone, with no page reload. _(#94, #88)_
- [ ] **14.14** Open **Settings**. → Expect: the Keychain warning is gone. _(#77)_

---

## 15. Meetings & enrichment — P3

Progress: 0 / 19 done

- [ ] **15.1** In the test copy, click **Enrich last 48h** on Today. → Expect: "No ended meetings from the last 48 hours need enrichment; no Work Order was written". _(#44)_
- [ ] **15.2** In the **daily app**, after a day with meetings, click **Enrich last 48h**. → Expect: "Work Order written for N meetings: ask Claude to "run LifeOS enrichment"". _(#44)_
- [ ] **15.3** Open `data/_inbox/requests/` and read the newest file. → Expect: each meeting's title, times, event ID, attendee emails and missing material. _(#44)_
- [ ] **15.4** Check the same file. → Expect: meetings whose note or meeting is restricted are **not** in it. _(#44, #63, #86)_
- [ ] **15.5** Open `data/_agent/meetings.md`. → Expect: the meetings from the Work Order show enrichment state `requested`. _(#44, #43)_
- [ ] **15.6** (Daily app) Open one of those meetings in **Calendar**. → Expect: "Enrichment **Requested**", the missing material in words, and a **Give up** button. _(#87)_
- [ ] **15.7** In the test copy, open the mock meeting, type a word, and copy its meeting ID from `.dev-data/meetings/`. → Expect: you have a meeting ID. _(—)_
- [ ] **15.8** Look at the meeting header. → Expect: "Enrichment **Not requested**" and no Give up button. _(#87)_
- [ ] **15.9** In TextEdit, add three lines to that meeting file's front matter: `enrichment_state: partial`, `enrichment_missing_material: [gong-call]`, `enrichment_unavailable_material: [meet-recording]`. Save, then reload. → Expect: Enrichment **Partial**, Missing material "Gong call", Not available "Meet recording", and a **Give up** button. _(#87)_
- [ ] **15.10** Click **Give up**. → Expect: "Stopped waiting for material for this meeting"; Enrichment says **Gave up**; the button is gone. _(#87)_
- [ ] **15.11** Drop draft **K** (meeting material) with that meeting ID. → Expect: Inbox shows a **summary** card and proposal cards. _(#45)_
- [ ] **15.12** Look at the proposal marked `missed_in_notes: true`. → Expect: its card shows **Not in your notes**. _(#45)_
- [ ] **15.13** Accept a proposal. → Expect: the task keeps the meeting's project, client, product and people. _(#45)_
- [ ] **15.14** Click **Accept summary**. → Expect: "Summary added to the meeting"; the meeting shows an **AI SUMMARY** card. _(#45)_
- [ ] **15.15** Look at the note editor. → Expect: your own note text is unchanged. _(#45, #66)_
- [ ] **15.16** Drop **K** again with a new `draft_key`. → Expect: no duplicate sources or proposals. _(#45, #59)_
- [ ] **15.17** Drop **K** with a different summary and a new key, then accept it. → Expect: the AI SUMMARY card shows only the new summary. _(#66)_
- [ ] **15.18** Mark the meeting's note restricted, then accept a pending summary for it. → Expect: refused with a clear message. _(#63)_
- [ ] **15.19** (Daily app, 48 h after a request with no material) Look at Today's **AFTER MEETINGS** card. → Expect: each meeting has its own **Give up**; clicking says "Stopped waiting for material for this meeting". _(#44, #64)_

---

## 16. Agent Index — P3

Progress: 0 / 8 done

- [ ] **16.1** Open `.dev-data/_agent/`. → Expect: overview, tasks, waiting-on, open-points, decisions, projects-clients-products, people, meetings, pending-adoption. _(#43)_
- [ ] **16.2** Open `overview.md`. → Expect: "Generated at …", counts per type, a freshness line, and an **Internal domains** list. _(#43, #93)_
- [ ] **16.3** Open `tasks.md`. → Expect: open tasks grouped overdue / today / upcoming / no date, each with ID and path. _(#43)_
- [ ] **16.4** Create a task, wait 5 seconds, and re-open `tasks.md`. → Expect: the new task is listed; the time is newer. _(#43)_
- [ ] **16.5** Open `pending-adoption.md` after all drafts are adopted. → Expect: nothing pending. A pending draft would say "(pending adoption)". _(#43)_
- [ ] **16.6** Open `people.md`. → Expect: people with labels, emails and an external flag. _(#43)_
- [ ] **16.7** Move the whole `_agent` folder to your Desktop and restart. → Expect: LifeOS starts fine and recreates the folder. _(#43)_
- [ ] **16.8** Search all `_agent` files for "secret" or "token". → Expect: nothing found. _(#43)_

---

## 17. History & restore — P3

Progress: 0 / 18 done

### 17a. Kept versions on disk

- [ ] **17.1** Save one task 12 times (change priority back and forth). → Expect: its folder in `.lifeos/versions/` holds **10** copies, not 12. _(#72)_
- [ ] **17.2** Make an external edit, then open the newest file in `audit/`. → Expect: it names a `version_path` pointing at a kept copy. _(#29, #72)_
- [ ] **17.3** Edit a task in **Tasks** and save. → Expect: **no** external-edit audit for your own save. _(#29)_

### 17b. History panel

- [ ] **17.4** In **Tasks**, click **History** on a task you edited. → Expect: "HISTORY · KEPT VERSIONS", newest first; rows like "Revision 3 · title" with time and device; the newest says **Current**. _(#85)_
- [ ] **17.5** Find the TextEdit change from 2.9. → Expect: a row "Edited outside LifeOS" tagged **External edit**. _(#85)_
- [ ] **17.6** Check **History** is offered on a note, a meeting, a meeting note, a decision, an open point and a person. → Expect: each opens its own list. _(#85)_
- [ ] **17.7** Open History on the 12-save task from 17.1. → Expect: 6 rows and a **Show N more** button. _(#85)_
- [ ] **17.8** Press Escape. → Expect: the History panel closes. _(#85)_

### 17c. Restore this version

- [ ] **17.9** On an older revision, click **Restore this version**. → Expect: "Replace the current version with this one?" with **Confirm restore** and **Cancel**. _(#85)_
- [ ] **17.10** Click **Cancel**. → Expect: nothing changes. _(#85)_
- [ ] **17.11** Click **Restore this version** again, then **Confirm restore**. → Expect: "Restored revision N from <date>"; the task shows the old values. _(#85)_
- [ ] **17.12** Open History again. → Expect: a new row "Restored a kept version". _(#85)_
- [ ] **17.13** Edit a decision and save (so an older normal version exists). Then click **Mark restricted**. → Expect: the decision is restricted. _(#86)_
- [ ] **17.14** In its History, restore the older version. → Expect: the message ends "It stays restricted: a restore never changes sensitivity."; the lock badge stays. _(#92)_
- [ ] **17.15** In **People**, open History on Alex Morgan (confirmed in 8.15) and restore an older version. → Expect: no **Unreviewed** marker comes back. _(#92)_
- [ ] **17.16** Open History on a task. Leave it open, change the task in TextEdit and save. Then click **Restore this version** and **Confirm restore**. → Expect: refused: "This was changed since you opened its history, so nothing was restored. Reload to see the latest version, then try again." _(#92)_
- [ ] **17.17** Make a TextEdit change to a task, then save it 11 more times in the app. Open its History. → Expect: the "Edited outside LifeOS" row says "This version is no longer kept (only the last 10 are)" and has no restore button. _(#85, #72)_

### 17d. Note conflicts

- [ ] **17.18** Open a meeting note in Calendar and edit its file in TextEdit at the same time. → Expect: a conflict panel with **Keep browser version** and **Keep disk version**. _(existing)_

---

## 18. Knowledge drafts — P3

Progress: 0 / 4 done

- [ ] **18.1** Drop draft **I1** (source with a URL). → Expect: a Source is created. _(#35)_
- [ ] **18.2** Drop **I2** (same URL, different case). → Expect: the existing Source is reused; no duplicate. _(#35)_
- [ ] **18.3** Drop **I3** (dictated knowledge note). → Expect: it shows under **Knowledge → Published Knowledge Notes**. _(#35)_
- [ ] **18.4** Drop **I4** (agent-extracted knowledge note). → Expect: it becomes a Review card in Inbox instead. _(#35)_

---

## 19. Accessibility — P3

Progress: 0 / 6 done

- [ ] **19.1** On Today, use only Tab, Shift+Tab, Enter and Space. → Expect: you can reach Capture, Refresh, Pin, Replace, Dismiss, Show more, Open Inbox and Back up now. _(#47, #64, #84)_
- [ ] **19.2** Check every red or coloured marker. → Expect: each has words too ("Restricted", " - ext", "unreviewed", "Overdue", "Done", "Pinned", "Offline", "BACKUP PROBLEM"). _(#64, #39, #87, #88, #84)_
- [ ] **19.3** Turn on VoiceOver (Cmd+F5) and focus a **Give up** or **Pin** button. → Expect: it reads the item name, e.g. "Pin Send Alex the pricing deck". _(#64, #87)_
- [ ] **19.4** Focus **Confirm** on an unreviewed person with VoiceOver on. → Expect: it reads "Confirm <name> as reviewed". _(#87)_
- [ ] **19.5** Make a Settings save fail (two-tab test 12.8). → Expect: the error is announced as an alert. _(#68)_
- [ ] **19.6** Check any list on Today or in History with 8 or more items. → Expect: 6 rows, then **Show N more**. _(#64, #85)_

---

## 20. Automatic backups & off-Drive copy — P1

Progress: 0 / 17 done

Use the test copy unless a line says "daily app". Its backups are in `code/.dev-backups/`.

- [ ] **20.1** Start the test copy, then open **System**. → Expect: **VERSIONED BACKUPS** lists a snapshot taken at start. _(#84)_
- [ ] **20.2** Stop the test copy with Control+C. → Expect: Terminal returns to the prompt within a minute; it does not hang. _(#95)_
- [ ] **20.3** Start it again and open **System**. → Expect: one snapshot from when you stopped, and one from this start. _(#84, #95)_
- [ ] **20.4** In Finder, open the newest folder in `code/.dev-backups/` and search it for `session.md`. → Expect: not found. _(#84)_
- [ ] **20.5** Open **Settings** and find **Off-Drive backup folder**. → Expect: "Applies to this Mac only: each device keeps its own folder." and "Not set yet: backups stay only inside the Google Drive folder." _(#84, #95)_
- [ ] **20.6** Type `backups` (no slash) and click **Save**. → Expect: error "Enter the folder's full path, starting with /". _(#84)_
- [ ] **20.7** Type the full path of your `code` folder (inside Google Drive) and click **Save**. → Expect: error "Choose a folder outside Google Drive, so a Drive problem cannot take both data and backups". _(#84, #95)_
- [ ] **20.8** In Finder, create a folder `LifeOS-offdrive-test` in your home folder. → Expect: the folder exists outside Google Drive. _(—)_
- [ ] **20.9** Type its full path (for example `/Users/<you>/LifeOS-offdrive-test`) and click **Save**. → Expect: "Saved. The next backup copies here if the last copy is a week old." _(#84)_
- [ ] **20.10** In **System**, click **Create & verify snapshot**. → Expect: "Snapshot created and restoration drill passed"; `LifeOS-offdrive-test` now holds a copy. _(#84)_
- [ ] **20.11** Click **Create & verify snapshot** again. → Expect: no second copy in `LifeOS-offdrive-test` (the copy is weekly). _(#84)_
- [ ] **20.12** In Settings, change the folder to `/Users/<you>/LifeOS-offdrive-missing` (a folder that does not exist) and click **Save**. → Expect: "Saved. …". _(#84)_
- [ ] **20.13** In **System**, click **Create & verify snapshot**. → Expect: a **BACKUP PROBLEM** card: "Off-Drive backup copy failed", a "Reason: …" line in words, and **Back up now**. _(#84)_
- [ ] **20.14** Open **Today**. → Expect: the same **BACKUP PROBLEM** card shows. _(#84)_
- [ ] **20.15** In Finder, create the `LifeOS-offdrive-missing` folder. On Today, click **Back up now**. → Expect: "Snapshot created and restoration drill passed"; the card is gone (reload if it stays). _(#84)_
- [ ] **20.16** Clear the Off-Drive backup folder box and click **Save**. → Expect: "Saved. No off-Drive copy will be made." _(#84)_
- [ ] **20.17** (Daily app, both Macs) Set your real off-Drive folder on Mac 1. Then open Settings on Mac 2 after Drive syncs. → Expect: Mac 2 does not show Mac 1's folder. _(#95)_

---

## 21. Calendar offline — P1 (daily app, port 4310)

Progress: 0 / 7 done

The test copy uses a mock calendar that never goes offline, so use the daily app. Keychain denial is tested in 14.8–14.14.

- [ ] **21.1** Note how many meetings Today shows. Turn Wi-Fi off. → Expect: nothing changes yet. _(—)_
- [ ] **21.2** Reload Today. → Expect: "Offline: showing meetings already in LifeOS (last synced …)" and "Google Calendar could not be reached". _(#88)_
- [ ] **21.3** Check the meetings listed. → Expect: the same stored meetings as before; nothing is missing or changed. _(#88)_
- [ ] **21.4** Open **Calendar**. → Expect: the same offline banner and the stored meetings for that day. _(#88)_
- [ ] **21.5** Click **Retry** with Wi-Fi still off. → Expect: the banner stays; the status line says "Calendar is still offline: …". _(#94)_
- [ ] **21.6** Turn Wi-Fi on and click **Retry**. → Expect: "Calendar reloaded"; the banner is gone, with no page reload. _(#88, #94)_
- [ ] **21.7** Open a meeting note you had before going offline. → Expect: the note and its text are unchanged. _(#88)_

---

## 22. Editor safety — P1

Progress: 0 / 10 done

Use a test note in **Notes** in the test copy. The editor has three modes: **Visual**, **Markdown** and **Preview**.

- [ ] **22.1** In **Markdown** mode, type a plain paragraph. Switch to **Visual**. → Expect: no "Unproven formatting" label. _(#89)_
- [ ] **22.2** In **Markdown** mode, add a list with `- one` and `- two`. Switch to **Visual**. → Expect: a label "**Unproven formatting** Editing here may rewrite parts of this note you did not touch: bullets written with - or +…". _(#89)_
- [ ] **22.3** In **Markdown** mode, paste an image (Cmd+V of a screenshot). → Expect: an image line like `![…](assets/…)` appears. _(#91)_
- [ ] **22.4** Switch to **Visual**. → Expect: the image shows. _(#91)_
- [ ] **22.5** In **Visual**, type a word somewhere else and wait for the save. → Expect: the note saves. _(#91)_
- [ ] **22.6** Switch to **Markdown**. → Expect: the image line is still there. _(#91)_
- [ ] **22.7** In **Visual**, paste a second image, then reload the page and open the note in **Visual**. → Expect: both images still show. _(#91)_
- [ ] **22.8** In **Visual**, press Enter twice to leave an empty line, then type a word. Wait for the save. → Expect: the note saves. _(#96)_
- [ ] **22.9** Switch to **Markdown**. → Expect: **no** `<br />` anywhere in the text. _(#96)_
- [ ] **22.10** Open the meeting from 15.14 (it has an AI summary) in **Visual** mode. → Expect: no "Unproven formatting" label. _(#96)_

---

## 23. Skills pack dry-runs — P3

Progress: 0 / 11 done

The steps live in `skills/INSTALL.md`. Run them there; tick here when each part passes. Test copy (`.dev-data`) only.

- [ ] **23.1** Do `skills/INSTALL.md` Parts 1–3 (zip, install, give access to `.dev-data`). → Expect: all skills show as on in Claude. _(#49)_
- [ ] **23.2** Do Part 4, checks 1–12 (desktop: Ask and Capture). → Expect: all 12 pass. _(#49)_
- [ ] **23.3** Do Part 5, checks 13–15 (phone). → Expect: all 3 pass, or the `[TBD]` lines are noted. _(#49)_
- [ ] **23.4** Do Part 7, checks 16–26 (morning routine and Slack DM). → Expect: all 11 pass. _(#51)_
- [ ] **23.5** Do Part 8, checks E1–E10 (enrichment). → Expect: all 10 pass. _(#50)_
- [ ] **23.6** In check E2, look at the client-content gate. → Expect: Claude skips "Quarterly business review" as a client meeting and fetches nothing for it. _(#50, #93)_
- [ ] **23.7** Move `.dev-data/settings/internal-domains.md` to your Desktop. Wait 5 seconds and open `.dev-data/_agent/overview.md`. → Expect: **Internal domains** says "none set". _(#93)_
- [ ] **23.8** Copy the dry-run Work Order back into `_inbox/requests/` and say "Run LifeOS enrichment." → Expect: Claude refuses "Quarterly business review" because no internal domains are set, and tells you to add them in Settings → Internal domains. _(#93)_
- [ ] **23.9** Check what happened to "Weekly Product Review" in that run. → Expect: it is still processed (all `example.com` addresses in `.dev-data` count as synthetic). _(#93)_
- [ ] **23.10** Set Internal domains back to `example.com` in Settings. → Expect: `overview.md` lists `example.com` again. _(#93)_
- [ ] **23.11** Fill in the Part 6 results table in `skills/INSTALL.md`. → Expect: one row per device. _(#49)_

---

## 24. Crash-safety checks (optional, technical)

Progress: 0 / 4 done

Most crash-safety rules (journals, replays, "reject never becomes accept") **can't be tested safely by hand**. The automated suite covers them. These four are safe in the **test copy** only:

- [ ] **24.1** Drop 5 drafts, press Control+C within 1 second, then restart. → Expect: each draft is adopted exactly once; no duplicates in Tasks. _(#32, #59)_
- [ ] **24.2** Click **Accept** on a proposal, press Control+C straight away, then restart. → Expect: exactly one object exists; the item is not pending. _(#62, #74)_
- [ ] **24.3** Click **Reject** on a merge card, press Control+C straight away, then restart. → Expect: the people are **not** merged; the item shows rejected. _(#82)_
- [ ] **24.4** Accept and reject the same item in two tabs at the same moment. → Expect: one outcome only; no orphan object. _(#62)_

---

## 25. Known gaps — don't report these

Known and expected in Phase A as built.

| Gap | What you'll see | Source |
|---|---|---|
| **Undo refused** after later edits | "Cannot undo: … changed since the patch was applied" if a field changed, or if text was added **below** the appended note | #36, #61, #81 |
| **Calendar sync still reads Keychain** | **Sync now** and **Connect** may show a Keychain prompt; loads and saves don't | #77 |
| **Visual mode rewrites other Markdown** | `-` bullets become `*`, `---` becomes `***`, tables are re-padded, and more. Meaning is kept; the bytes change. The "Unproven formatting" label warns first | #89 |
| **Two-device limits** | If another device's version copy never syncs, an edit made on top of it is not flagged as external | ADR 0012, #80, #81 |
| **Brief time** is stored, but the app runs nothing | The morning routine is a Claude routine you schedule yourself (`skills/INSTALL.md` Part 7) | ADR 0011, #51 |
| **UI does not refresh by itself** after auto-adoption | Reload the page to see adopted drafts | #32 |
| **Client meetings are not enriched** | The enrichment skill refuses them until IT/legal sign-off on client meeting content | #50, #93 |
| **Skills on the phone** unconfirmed | Whether skills sync to Android, and whether the Drive connector can write drafts, are still `[TBD]` | #49 |
| **Hard to test by hand** | The 26-hour "No backup in the last 26 hours" banner, the daily backup, keeping 4 off-Drive copies, and stale Work Orders (7 days). Automated tests cover them | #84, #95, #44 |
| **Phase B, not built** | No dyslexia-friendly font, no dark theme, no macOS launcher or start at login, no browser (Playwright) tests, no 10,000-object performance test | #90 |
| **Code cleanup** | Shared helpers and banner components are being tidied. No visible change, so nothing to test | #97 |

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
