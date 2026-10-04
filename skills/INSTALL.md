# LifeOS skills pack v1: install and dry-run

Three Claude skills. Install them, then test them on **fake data** before pointing them at your real LifeOS.

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
