# LifeOS

Local-first personal knowledge and work management, backed by typed Markdown files.

## Layout

- `apps/web`: React browser UI.
- `apps/server`: localhost Fastify service.
- `packages/domain`: domain types and invariants.
- `packages/application`: use-case orchestration and ports.
- `packages/object-store-markdown`: Markdown persistence adapter.
- `packages/index-memory`: rebuildable in-memory index.
- `packages/connectors`: Google Calendar and mock integration adapters.
- `packages/ai`: deterministic mock AI adapter behind an application port, for tests only (the live server has no AI provider).
- `packages/assets-filesystem`, `packages/backup-filesystem`, `packages/secrets`: managed images, checksummed backups and the macOS Keychain store.
- `packages/contracts`, `packages/shared`: API types and rules shared by the server and the browser.
- `schemas`: versioned object contracts and synthetic fixtures.
- `skills`: the Claude skills pack (Object Contract, capture, ask, enrichment, morning); its examples are tested against adoption in CI. Install and dry-run: `skills/INSTALL.md`.
- Data root (`LIFEOS_DATA_ROOT`): synchronized user Markdown and assets in Google Drive; intentionally outside this Git repository.
- Backup root (`LIFEOS_BACKUP_ROOT`): read-only, checksummed data snapshots on each Mac's own disk; also outside Git.

## Where the code and the data live

The code and the data are kept apart on purpose:

| What | Where | How it moves between Macs |
| --- | --- | --- |
| **Code** (this repository) | `~/Developer/LifeOS` on each Mac, **never inside Google Drive or iCloud** | GitHub: `git push` on one Mac, `git pull` on the other |
| **Data** | `~/Library/CloudStorage/GoogleDrive-<your-email>/My Drive/Claude Working Space/Personal/LifeOS App/data` | Google Drive for desktop |
| **Backups** | `~/LifeOS-backups` on each Mac, outside Google Drive | Not synced. Each Mac keeps its own; Time Machine copies them |

Why: the code folder holds hundreds of thousands of small files (`node_modules`, build output, agent worktrees under `.claude/`). Google Drive cannot ignore subfolders, and marking them "online only" does not stop the upload, so the code must sit outside Drive.

### Set up a Mac

Do this once on each Mac.

1. In Google Drive for desktop, sign in with the account that holds the data. In Finder, right-click the `data` folder and choose **Available offline**, so LifeOS and Claude read local files rather than waiting for downloads.
2. Clone the code outside Drive:

   ```bash
   mkdir -p ~/Developer ~/LifeOS-backups
   git clone git@github.com:Rahuldharod/LifeOS.git ~/Developer/LifeOS
   cd ~/Developer/LifeOS
   corepack pnpm install
   ```

3. Tell LifeOS where the data is. LifeOS reads these from the shell, **not** from a `.env` file, so add them to `~/.zshrc`, replacing `<your-email>`:

   ```bash
   export LIFEOS_DATA_ROOT="$HOME/Library/CloudStorage/GoogleDrive-<your-email>/My Drive/Claude Working Space/Personal/LifeOS App/data"
   export LIFEOS_BACKUP_ROOT="$HOME/LifeOS-backups"
   export LIFEOS_DEVICE_ID="desk-mac"   # a different name on each Mac, e.g. "laptop"
   ```

   Then open a new Terminal window.
4. Check the path before the first start. This must list `.lifeos` and folders such as `tasks` and `people`:

   ```bash
   ls -a "$LIFEOS_DATA_ROOT"
   ls "$LIFEOS_DATA_ROOT/.lifeos/schema.md"
   ```

   **If the first command shows nothing or says "No such file", stop.** Do not start LifeOS until the path is right.

   LifeOS refuses to start unless `.lifeos/schema.md` is there (ADR 0014). This stops it from creating an empty vault in the wrong folder. Data from before 2026-10-07 may not have this file yet. Only if the first command shows your `tasks` and `people` folders, create it once (on one Mac only; Drive copies it to the other):

   ```bash
   printf '# LifeOS data root\n\nLifeOS only starts on a folder that holds this file (ADR 0014).\n' > "$LIFEOS_DATA_ROOT/.lifeos/schema.md"
   ```
5. Protect the data from Claude. Add this hook to `~/.claude/settings.json` (merge it into any `hooks` you already have):

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
           "hooks": [
             { "type": "command", "command": "node \"$HOME/Developer/LifeOS/scripts/hooks/data-guard.mjs\"" }
           ]
         }
       ]
     }
   }
   ```

   It stops Claude from changing files in the data folder directly. Claude can still read everything, and can write drafts in `_inbox/drafts/` and `_inbox/patches/`. LifeOS then adopts them (ADR 0007).
6. Start LifeOS with `corepack pnpm start`.

**Before you switch Macs:** commit and push any code changes (`git push`). On the other Mac, run `git pull`, then `corepack pnpm update-app`.

## Run locally

### Use LifeOS

LifeOS runs in the background from the production build, so code changes never reload it while you are writing. Open `http://127.0.0.1:4310` once it has started.

| Command | What it does |
| --- | --- |
| `corepack pnpm start` | Starts LifeOS in the background (builds first if there is no build yet) |
| `corepack pnpm stop` | Stops LifeOS safely: takes a last backup, then releases the write lease (can take up to a minute) |
| `corepack pnpm status` | Shows whether LifeOS is running |
| `corepack pnpm update-app` | Builds the latest code, then restarts LifeOS. If the build fails, the running app is left untouched |

During a restart the page shows **Reconnecting…**; keep typing, the draft saves when the server is back. The log is at `~/Library/Logs/LifeOS/server.log`.

**What `stop` does, in order:**

1. New saves are refused with "LifeOS is stopping; your change was not saved". Make the change again once LifeOS is back.
2. LifeOS finishes any draft adoption already running.
3. It takes the stop backup (it gives up after 35 seconds).
4. It releases the write lease, so the other Mac can take over.

If all this takes longer than 60 seconds, the script force-stops LifeOS. A half-made backup is cleaned up at the next start.

### Using two Macs

Only one Mac can change your data at a time. That Mac holds the **write lease**. The other Mac is **read-only**: you can read everything, but saves are refused.

You do not need to stop LifeOS when you leave a Mac. After **15 minutes** without you using it, LifeOS on that Mac gives up the lease by itself (ADR 0015).

| Situation | What happens |
| --- | --- |
| You use the laptop while the desktop sits idle | After 15 minutes the desktop lets go. Once Google Drive has synced that (usually under a minute), your next action on the laptop takes the lease |
| You come back to the desktop | A **Read-only on this Mac** banner shows. Click **Take back** |
| You click Take back while the laptop holds the lease | The banner warns you first: close LifeOS on the laptop and let Google Drive finish syncing |
| LifeOS is left open but nobody touches it | It still lets go after 15 minutes. It never takes the lease back by itself |
| A Mac crashes or sleeps with LifeOS open | The other Mac stays read-only for up to 15 minutes, until the lease expires, or click **Take over** once Drive has synced (ADR 0016) |

What counts as "using it": typing, clicking, scrolling or moving the mouse in the LifeOS tab while it is visible and in front, and saving changes. Backups, calendar syncs and drafts adopted in the background do not count.

To change the 15 minutes, add `export LIFEOS_IDLE_RELEASE_MINUTES=30` (for example) to `~/.zshrc`, then run `corepack pnpm update-app`. Backups keep running on a Mac that let go.

### Develop LifeOS

```bash
corepack pnpm dev
```

Development runs separately at `http://127.0.0.1:5174` (API on 4311) with live reload. It uses synthetic data in `.dev-data/` (created from `schemas/fixtures` on first run; delete the folder to reset) and the mock calendar, so it never touches your real data (`LIFEOS_DATA_ROOT`). Press **Control+C** to stop it. Dev and the stable app can run at the same time.

To see a code change in your daily LifeOS, run `corepack pnpm update-app` when you are not mid-note.

### Run the tests

```bash
corepack pnpm typecheck
corepack pnpm test --exclude '.claude/**'
```

The `--exclude` stops Vitest from also running the copies of the tests inside agent worktrees under `.claude/`. CI runs plain `pnpm test`, because a fresh checkout has no `.claude/` folder.

### First-time settings

Open **Settings** after the first start and fill these cards. Each saves on its own and shows **Saved**.

| Card | What to enter | If you leave it empty |
| --- | --- | --- |
| **My email addresses** | Every address you use, work and personal (e.g. `me@example.com`) | You are not recognised as an attendee. Today and System Health show a warning with a button to this card |
| **Internal domains** | Your organisations' email domains (e.g. `example.com`) | Nobody is marked External ("Name - ext"). The same warning mentions it |
| **Max must-dos** | How many items Today's Top 3 shows (1–5) | Defaults to 3 |
| **Meetings and morning brief** | Meeting-heavy threshold (hours), brief time, time zone and workdays | Defaults: 5 hours, 06:00 Europe/Paris, Monday to Friday |
| **Calendars in the Calendar view** | Which Google calendars to show | All are shown |
| **Off-Drive backup folder** | **On each Mac**, a folder outside Google Drive, such as an external disk (e.g. `/Volumes/Backup/LifeOS`). The folder must already exist. A weekly copy of the latest backup goes there; 4 are kept | Backups stay only in `LIFEOS_BACKUP_ROOT` (`~/LifeOS-backups`) on this Mac. This setting applies to this Mac only, so set it on both |
| **Google Calendar** / **Google Drive** | OAuth client ID and secret (see below) | Calendar uses the mock calendar; Drive is not used yet |

These settings are synced files in the data folder's `settings/` (ADR 0005), so both computers share them. The off-Drive folder is the exception: each Mac keeps its own (stored per device in `settings/backups.md`).

### Backups

LifeOS backs up by itself into `LIFEOS_BACKUP_ROOT` (`~/LifeOS-backups` on each Mac): at start, once a day while running, and at `stop`. If a backup or the off-Drive copy fails, or none has worked for 26 hours, Today and System Health show a **Backup problem** banner with a **Back up now** button.

### Claude skills

The skills that let Claude capture, answer questions, enrich meetings and write the morning brief are in `skills/`. Install them and run the dry-run on fake data first: see [`skills/INSTALL.md`](skills/INSTALL.md).

### Maintenance

| Command | What it does |
| --- | --- |
| `corepack pnpm reconcile-meetings` | Reports meetings duplicated for the same calendar event; changes nothing |
| `corepack pnpm reconcile-meetings --apply` | Run after `corepack pnpm stop`. Backs up, then archives the empty extra copies (files are kept and marked `archived_at`) and audits them. Copies that both hold notes are left for a manual merge |
| `corepack pnpm worktrees:prune` | Lists Claude agent worktrees in `.claude/worktrees` and which can go; changes nothing. Add `--apply` to remove them. Claude also runs this by itself at the end of each session |
| `corepack pnpm worktrees:check` | Warns if there are more than 10 agent worktrees |

A worktree is only removed when it has no unsaved work, its commit is on GitHub, and nothing in it changed for 2 hours. Branches are never deleted.

## Safety baseline

The Markdown root is authoritative. Browser state and indexes are disposable. Real personal data, assets, secrets, logs and backups are excluded from Git.

## Documentation

Documentation is intentionally lean during the MVP:

- [`docs/architecture/README.md`](docs/architecture/README.md) explains system boundaries and responsibilities.
- [`docs/decisions/`](docs/decisions/) records durable architectural decisions (ADRs 0001–0015).
- [`CONTEXT.md`](CONTEXT.md) is the domain glossary.
- [`docs/architecture/mvp-gap-analysis.md`](docs/architecture/mvp-gap-analysis.md) preserves the solution-design audit and deferred scope.
- [`docs/product-design/LifeOS_Solution_Design_v0.8.md`](docs/product-design/LifeOS_Solution_Design_v0.8.md) is the current versioned solution baseline. v0.4, v0.6 and v0.7 are kept for history.
- [`docs/product-design/LifeOS_PRD_Phase-A_v1.0.md`](docs/product-design/LifeOS_PRD_Phase-A_v1.0.md) is the Phase A spec (also GitHub issue #21), with its build status, build decisions and known gaps.
- [`docs/product-design/Product Backlog.md`](docs/product-design/Product%20Backlog.md) captures product intent and prioritization before work becomes a GitHub Issue.
- [`skills/INSTALL.md`](skills/INSTALL.md) explains how to install the Claude skills and run their dry-runs.
- [`AGENTS.md`](AGENTS.md) tells coding agents how to navigate and safely change the repository.
- [`CLAUDE.md`](CLAUDE.md) points Claude Code to the shared agent instructions without duplicating them.

There is no standalone user guide yet. During the MVP, changing workflows should be discoverable in the interface; a maintained user guide becomes worthwhile once the primary workflows stabilize.

## Connect Google Calendar

1. In Google Cloud, enable the Calendar API and create an OAuth client of type **Desktop app**.
2. Open **Settings** in LifeOS and paste the Desktop client ID and secret into the Google Calendar card. They are saved directly to macOS Keychain under service `com.lifeos.local` and the secret field is cleared. Google Drive credentials can be stored independently on the same page.
3. Open **Calendar** and choose **Connect Google Calendar**. LifeOS requests only `calendar.readonly`, validates OAuth state and PKCE, and stores tokens in Keychain.
4. Future restarts reuse the Keychain credentials and refresh token. Environment variables remain available only as an optional development bootstrap.

### macOS Keychain prompts

LifeOS stores Google credentials in the Keychain through a small helper it builds in `~/Library/Application Support/LifeOS/keychain-helper/` (the Xcode command-line tools must be installed). macOS may ask whether this helper can read the LifeOS items:

- **When it asks:** once at start, and when you connect or sync Google Calendar. Loading pages and saving settings never ask.
- **What to click:** **Always Allow**, so later syncs do not ask again.
- **If you click Deny:** the Connections card says **Keychain access denied** with a **Retry** button. Nothing else fails; click Retry when you are ready.

The loopback callback defaults to `http://127.0.0.1:4310/api/v1/connections/google/callback`. No token or client secret is written to Markdown, logs, backups, or Git.
