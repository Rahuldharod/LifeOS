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

Start LifeOS with:

```bash
corepack pnpm dev
```

Keep that Terminal window open while using the application. The web interface runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:4310`.

### Stop LifeOS

In the Terminal window running LifeOS, press **Control+C**. This stops both the web interface and API.

If that Terminal window is no longer available, identify the processes using the LifeOS ports:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:4310 -sTCP:LISTEN
```

Stop each listed process using its numeric PID:

```bash
kill <PID>
```

Run the two `lsof` commands again. No output means both LifeOS servers are stopped.

## Safety baseline

The Markdown root is authoritative. Browser state and indexes are disposable. Real personal data, assets, secrets, logs and backups are excluded from Git.

## Documentation

Documentation is intentionally lean during the MVP:

- [`docs/architecture/README.md`](docs/architecture/README.md) explains system boundaries and responsibilities.
- [`docs/decisions/`](docs/decisions/) records durable architectural decisions.
- [`docs/architecture/mvp-gap-analysis.md`](docs/architecture/mvp-gap-analysis.md) preserves the solution-design audit and deferred scope.
- [`docs/product-design/LifeOS_Solution_Design_v0.4.md`](docs/product-design/LifeOS_Solution_Design_v0.4.md) is the current versioned solution baseline.
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
