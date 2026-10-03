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
- `packages/ai`: deterministic mock AI adapter behind an application port.
- `schemas`: versioned object contracts and synthetic fixtures.
- `../data`: synchronized user Markdown and assets; intentionally outside this Git repository.
- `../backups`: read-only, checksummed data snapshots; also outside Git.

## Run locally

Complete the first-time setup from the `code` directory:

```bash
corepack pnpm install
cp .env.example .env
```

### Use LifeOS

LifeOS runs in the background from the production build, so code changes never reload it while you are writing. Open `http://127.0.0.1:4310` once it has started.

| Command | What it does |
| --- | --- |
| `corepack pnpm start` | Starts LifeOS in the background (builds first if there is no build yet) |
| `corepack pnpm stop` | Stops LifeOS and releases the device lease |
| `corepack pnpm status` | Shows whether LifeOS is running |
| `corepack pnpm update-app` | Builds the latest code, then restarts LifeOS. If the build fails, the running app is left untouched |

During a restart the page shows **Reconnecting…**; keep typing, the draft saves when the server is back. The log is at `~/Library/Logs/LifeOS/server.log`.

### Develop LifeOS

```bash
corepack pnpm dev
```

Development runs separately at `http://127.0.0.1:5174` (API on 4311) with live reload. It uses synthetic data in `.dev-data/` (created from `schemas/fixtures` on first run; delete the folder to reset) and the mock calendar, so it never touches the real `../data`. Press **Control+C** to stop it. Dev and the stable app can run at the same time.

To see a code change in your daily LifeOS, run `corepack pnpm update-app` when you are not mid-note.

### Maintenance

| Command | What it does |
| --- | --- |
| `corepack pnpm reconcile-meetings` | Reports meetings duplicated for the same calendar event; changes nothing |
| `corepack pnpm reconcile-meetings --apply` | Run after `corepack pnpm stop`. Backs up, then archives the empty extra copies (files are kept and marked `archived_at`) and audits them. Copies that both hold notes are left for a manual merge |

## Safety baseline

The Markdown root is authoritative. Browser state and indexes are disposable. Real personal data, assets, secrets, logs and backups are excluded from Git.

## Documentation

Documentation is intentionally lean during the MVP:

- [`docs/architecture/README.md`](docs/architecture/README.md) explains system boundaries and responsibilities.
- [`docs/decisions/`](docs/decisions/) records durable architectural decisions.
- [`docs/architecture/mvp-gap-analysis.md`](docs/architecture/mvp-gap-analysis.md) preserves the solution-design audit and deferred scope.
- [`docs/product-design/LifeOS_Solution_Design_v0.6.md`](docs/product-design/LifeOS_Solution_Design_v0.6.md) is the current versioned solution baseline. v0.4 is kept for history.
- [`docs/product-design/LifeOS_PRD_Phase-A_v1.0.md`](docs/product-design/LifeOS_PRD_Phase-A_v1.0.md) is the Phase A spec (also GitHub issue #21).
- [`docs/product-design/Product Backlog.md`](docs/product-design/Product%20Backlog.md) captures product intent and prioritization before work becomes a GitHub Issue.
- [`AGENTS.md`](AGENTS.md) tells coding agents how to navigate and safely change the repository.
- [`CLAUDE.md`](CLAUDE.md) points Claude Code to the shared agent instructions without duplicating them.

There is no standalone user guide yet. During the MVP, changing workflows should be discoverable in the interface; a maintained user guide becomes worthwhile once the primary workflows stabilize.

## Connect Google Calendar

1. In Google Cloud, enable the Calendar API and create an OAuth client of type **Desktop app**.
2. Open **Settings** in LifeOS and paste the Desktop client ID and secret into the Google Calendar card. They are saved directly to macOS Keychain under service `com.lifeos.local` and the secret field is cleared. Google Drive credentials can be stored independently on the same page.
3. Open **Calendar** and choose **Connect Google Calendar**. LifeOS requests only `calendar.readonly`, validates OAuth state and PKCE, and stores tokens in Keychain.
4. Future restarts reuse the Keychain credentials and refresh token. Environment variables remain available only as an optional development bootstrap.

The loopback callback defaults to `http://127.0.0.1:4310/api/v1/connections/google/callback`. No token or client secret is written to Markdown, logs, backups, or Git.
