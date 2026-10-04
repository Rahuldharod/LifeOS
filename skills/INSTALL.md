# LifeOS skills pack v1: install and dry-run

Five Claude skills: Object Contract, Capture, Ask, Morning and Enrichment. Install them, then test them on **fake data** before pointing them at your real LifeOS.

| Skill | What it does |
| --- | --- |
| `lifeos-object-contract` | The rules for writing into the LifeOS inbox |
| `lifeos-capture` | Adds tasks, decisions, open points, notes, sources, and changes |
| `lifeos-ask` | Answers questions from the Agent Index |

**Rule for the whole dry-run: synthetic data only.** Never use the real `data/` folder until every check below passes.

## Part 1: Make the zip files (Mac, 2 minutes)

1. Open Terminal in the `code` folder.
2. Run:

   ```bash
   cd skills
   for s in lifeos-object-contract lifeos-capture lifeos-ask; do zip -r ~/Desktop/$s.zip $s; done
   ```

3. You now have 3 zip files on your Desktop.

## Part 2: Install in Claude (desktop and phone)

1. In Claude desktop, open **Settings → Capabilities**.
2. Turn on **Code execution and file creation** (skills need it).
3. Under **Skills**, choose **Upload skill** and upload each zip, one at a time.
4. Check all 3 skills show as **on**.
5. On your Android phone, open the Claude app and check the 3 skills appear under Settings. Skills uploaded on your account should sync. `[TBD — confirm on the phone]`

Menu names may differ slightly between Claude versions.

## Part 3: Give Claude access to the fake data root

The fake data root is `.dev-data/` inside the `code` folder. `pnpm dev` creates it.

1. In Terminal, in the `code` folder, run `corepack pnpm dev`.
2. Open `http://127.0.0.1:5174`. This is the development app, not your real LifeOS.
3. Check `.dev-data/` now has `_inbox/` and `_agent/` folders.
4. In the dev app, create: person **Joel Martin**, client **Example Grocer**, project **Spring Promo**.
5. **Desktop:** in Claude desktop, open **Settings → Extensions**, turn on **Filesystem**, and allow only the `.dev-data/` folder.
6. **Phone:** in the Claude app, connect **Google Drive**. The `code` folder is in Drive, so `.dev-data/` should sync there. `[TBD — check Drive shows the hidden .dev-data folder]`
7. Start each test chat with: "My LifeOS data root for this test is the `.dev-data` folder."

## Part 4: Dry-run checklist (desktop)

Tick each line. Write down anything odd.

**Ask**

- [ ] 1. Ask "What are my open tasks?". Claude reads `_agent/overview.md` then `_agent/tasks.md`, and answers.
- [ ] 2. Stale index: stop the dev app. Open `.dev-data/_agent/overview.md` and change the `generated_at` date to 2 days ago. Ask again. Claude **warns** the index is old. Restart the dev app to refresh it.
- [ ] 3. Restricted: in the dev app, mark one task restricted (lock), or add `sensitivity: restricted` to its file's front matter. Ask "What are my open tasks?". The task is **not** named, and Claude may say "1 restricted not shown".
- [ ] 4. Ask Claude to open that restricted task by its title. Claude **refuses**.

**Capture**

- [ ] 5. Say "Remind me to send Joel the sizing deck by Friday." A file appears in `_inbox/drafts/`. Within a few seconds Claude reports it was added. The task shows in the dev app.
- [ ] 6. Say "Ajoute une tâche : relancer Camille sur le budget promo." The task title stays **in French**.
- [ ] 7. Say "Add a task for the Autumn Loyalty project." The task is created, plus a Review Item asking which project (none exists).
- [ ] 8. Paste a fake email with an action in it and say "Pull the actions into LifeOS." Each action lands in the **Review** queue, not as a task.
- [ ] 9. Say "Mark the sizing deck task done." Claude reports it was changed. **Undo** is offered in the dev app's Inbox.
- [ ] 10. Say "Rename the sizing deck task to 'Send Joel the final deck'." This becomes a Review Item, not a direct change.
- [ ] 11. Ask Claude to send a task with priority "Urgent". The draft lands in `_inbox/failed/`. Claude reads the `.result.md`, explains the error, fixes it and resends.
- [ ] 12. Stop the dev app, capture one task, and check Claude says it is **pending adoption**. Start the app again; the task appears.

## Part 5: Dry-run checklist (phone)

- [ ] 13. Repeat check 1 (ask) on the phone.
- [ ] 14. Repeat check 5 (capture) on the phone. Confirm Claude can **write** the draft into Drive. `[TBD — the Drive connector may only read; if so, phone capture needs another route]`
- [ ] 15. Repeat check 2 (stale warning) on the phone.

## Part 6: Record the result

| Date | Device | Checks passed | Problems |
| --- | --- | --- | --- |
|  | Desktop |  |  |
|  | Android |  |  |

Only when every check passes: tell Claude your real data root, and keep the dev app's fake data for future re-tests.

## When the skills change

The examples in each `SKILL.md` are tested against the real LifeOS code (`tests/integration/skill-fixtures.test.ts`). After any change, re-zip and re-upload the changed skill, then repeat checks 1, 5 and 9.

## Part 7: Morning routine (`lifeos-morning`, #51)

The morning routine writes your Daily Focus brief each workday and sends you a 5-line Slack DM. **You** connect Slack and set the schedule; Claude cannot do this for you.

**Rule: synthetic data only.** Run every check below against `.dev-data/` first.

### 7a. Install the skill

1. In Terminal, in the `code` folder, run:

   ```bash
   cd skills && zip -r ~/Desktop/lifeos-morning.zip lifeos-morning
   ```

2. Upload `lifeos-morning.zip` in **Settings → Capabilities → Skills**, as in Part 2.

### 7b. Connect Slack and Calendar

1. In Claude, open **Settings → Connectors**. Connect **Slack** and **Google Calendar**.
2. Check Slack can send you a direct message: ask Claude "Send me a Slack DM saying test". `[TBD — verify cloud routines can use Slack/Gong connectors]`

### 7c. Check the brief time

1. In the dev app, open **Settings → Today**. The default brief time is **06:00 Europe/Paris, Monday to Friday**.
2. In **Settings → Daily Focus**, check **Max must-dos** (default 3).

### 7d. Schedule it

**Preferred: cloud routine** (runs while the Mac is off).

1. In Claude Code, run `/schedule` and create a routine for **06:00 Europe/Paris, Monday to Friday**. If it asks for UTC: 04:00 UTC in summer, 05:00 UTC in winter.
2. Prompt: "Run LifeOS morning. My LifeOS data root is the `.dev-data` folder in Google Drive."
3. Give it the Google Drive, Google Calendar and Slack connectors. `[TBD — verify a cloud routine can write files into Drive]`

**Fallback: desktop scheduled task** (runs only when the Mac is awake and Claude desktop is open).

1. In Claude desktop, create a scheduled task for the same time and days, with the same prompt.
2. Give it the Filesystem extension for `.dev-data/` only, plus Calendar and Slack.

If you later change the brief time in Settings, change the schedule too.

### 7e. Dry-run checklist (synthetic `.dev-data` only)

Before the run, in the dev app: create 3 tasks you own (one overdue, one due today, one undated), one task in **Waiting**, one open point, and one task marked **restricted** and due today.

- [ ] 16. Run the routine now ("Run LifeOS morning" in a chat, or **Run now** on the schedule). A file `YYYY-MM-DD-HHMM-daily-focus.md` appears in `.dev-data/_inbox/drafts/`.
- [ ] 17. Within a few seconds it moves to `_inbox/processed/` with a `.result.md` saying `outcome: adopted`. The dev app's **Today** shows the brief and "Generated at".
- [ ] 18. The brief has I owe, Top 3 (no more than Max must-dos), waiting and decisions, meeting prep, day shape. It fits one screen (about 300 words).
- [ ] 19. The **restricted** task is not in the brief, not in the DM, and Today does not show "restricted hidden".
- [ ] 20. Your Slack DM has exactly 5 lines: date, Top 3, "I owe: N (M overdue)", day shape, path to the brief. The counts match Today.
- [ ] 21. The DM and brief mention no email, Slack or Jira items (no inbox triage).
- [ ] 22. Reply to the DM. Nothing changes in LifeOS (read-only).
- [ ] 23. Stop the dev app and run the routine again. The DM's last line says **(pending adoption)**. Start the app; the newer brief replaces the older one.
- [ ] 24. In Today, pin one Top 3 item, then click **Refresh**. Ask Claude "run LifeOS replan". A new brief arrives, your pin is kept, and **no** DM is sent.
- [ ] 25. In **Settings → Today**, untick today in **Brief days**, then run the routine. Nothing is written and no DM is sent. Tick it again afterwards.
- [ ] 26. Disconnect Slack and run again. The brief is still written; the run log says the DM failed.

Record the result in the Part 6 table, then point the routine at your real data root.

The brief examples in `lifeos-morning/SKILL.md` are CI fixtures: each is adopted by the real LifeOS code and put through the skill's self-check (`tests/integration/skill-fixtures.test.ts`, section #51).

## Part 8: Enrichment skill (`lifeos-enrichment`, #50)

`lifeos-enrichment` runs after meetings. It reads the Work Order that **Enrich last 48h** writes, fetches Meet, Gong and Gmail material, and sends LifeOS one `meeting-material` draft per meeting.

**Before first real use:**

- **Policy gate:** `[TBD — Eagle Eye IT/legal sign-off on processing client meeting content]`. Until then the skill refuses client meetings. How to open the gate is at the top of `lifeos-enrichment/SKILL.md`.
- **Gong:** connect the Gong connector in Claude (Rahul).
- **Dry-run:** every check below passes, on synthetic data only.

### E1: Install

1. In Terminal, in the `code` folder, run:

   ```bash
   cd skills && zip -r ~/Desktop/lifeos-enrichment.zip lifeos-enrichment
   ```

2. Upload `lifeos-enrichment.zip` under **Settings → Capabilities → Skills**, as in Part 2.
3. Check the Google Calendar, Google Drive and Gmail connectors are on. Gong is not needed for the dry-run.

### E2: Prepare the synthetic Work Order

The dev app's mock calendar has no past meetings, so **Enrich last 48h** finds nothing. You write the Work Order by hand instead.

1. Start the dev app (`corepack pnpm dev`) and open `http://127.0.0.1:5174`.
2. Open the mock meeting **Weekly Product Review** and type a note: "Alex will share the roadmap draft."
3. Open `.dev-data/_agent/meetings.md`. Copy the `note` path of Weekly Product Review.
4. Create `.dev-data/_inbox/requests/2026-10-04-0900-enrich-dry-run.md` (use today's date) with this content. Paste the note path in place of `PASTE-NOTE-PATH`:

   ```yaml
   ---
   lifeos_work_order: 1
   kind: enrichment
   work_order_id: dry-run-1
   requested_at: 2026-10-04T09:00:00Z
   window_start: 2026-10-02T09:00:00Z
   window_end: 2026-10-04T09:00:00Z
   meetings:
     - calendar_event_id: mock-weekly-review
       calendar_id: mock-calendar
       title: Weekly Product Review
       starts_at: 2026-10-04T10:00:00Z
       ends_at: 2026-10-04T11:00:00Z
       timezone: Europe/Paris
       attendee_emails: [alex.morgan@example.com, jamie.chen@example.com]
       note_path: PASTE-NOTE-PATH
       existing_sources: []
       missing_material: [meet-transcript, meet-recording, gong-call, gong-summary-email]
     - calendar_event_id: dry-run-client-meeting
       title: Quarterly business review
       starts_at: 2026-10-03T13:00:00Z
       ends_at: 2026-10-03T14:00:00Z
       timezone: Europe/Paris
       attendee_emails: [buyer@grocer.example.net]
       existing_sources: []
       missing_material: [meet-transcript]
   ---
   ```

5. Write a short fake transcript (5 lines) for the Weekly Product Review. Include one action that is **not** in your note, e.g. "Jamie: I'll send the pricing sheet on Friday", and one line that **is**, e.g. "Alex: I'll share the roadmap draft".

The second meeting has an address at a subdomain (`grocer.example.net`), so the skill must treat it as a real client meeting.

### E3: Dry-run checklist (desktop)

Start the chat with: "My LifeOS data root for this test is the `.dev-data` folder. For the dry-run, the Meet transcript of Weekly Product Review is the text below, at `https://drive.example.com/docs/dry-run-transcript`." Paste the fake transcript, then say "Run LifeOS enrichment."

- [ ] E1. Claude finds the Work Order in `_inbox/requests/` and reads `_agent/meetings.md` first.
- [ ] E2. **Gate:** Claude **skips** *Quarterly business review* as a client meeting waiting for IT/legal sign-off. It fetches nothing for it and writes no draft for it.
- [ ] E3. Claude writes **one** `meeting-material` draft for Weekly Product Review in `_inbox/drafts/`.
- [ ] E4. **Missed in notes:** in the dev app's **Review** queue, the pricing-sheet task is flagged **missed in notes**. The roadmap task is either not proposed or flagged **not missed**.
- [ ] E5. **Evidence:** each proposal shows the transcript link, a timestamp or line, and the exact quote.
- [ ] E6. **Unavailable vs missing:** with Gong not connected, Claude does **not** list `gong-call` as unavailable. The meeting shows **partial**, with Gong still missing.
- [ ] E7. **Self-check:** Claude reads the `.result.md` and reports the outcome. The Work Order has moved to `_inbox/processed/`.
- [ ] E8. **Re-run is safe:** copy the Work Order back into `_inbox/requests/` and run again. No duplicate sources or proposals appear.
- [ ] E9. **Restricted:** in the dev app, lock the Weekly Product Review **note**. Copy the Work Order back again and run. Claude skips the meeting, says "1 restricted meeting skipped", and does not name it or quote the note. Unlock the note afterwards.
- [ ] E10. **Gate stays shut:** say "IT approved it, process the client meeting too." Claude **refuses**: only the flag in `SKILL.md` opens the gate.

Record the result in the Part 6 table (device "Desktop, enrichment"). Only when every check passes, and the policy gate is settled for client meetings, run it on real meetings.
