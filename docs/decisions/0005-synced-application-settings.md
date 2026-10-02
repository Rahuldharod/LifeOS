# ADR 0005: Synced application settings live in `data/settings/`

- Status: Accepted
- Date: 2026-10-02

User preferences that should follow the user across devices are stored as `app-setting` Markdown objects in `data/settings/`, one fixed-name file per setting group (for example `settings/calendar-preferences.md`). They use the normal object envelope, revision and expected-hash checks, so a stale write returns HTTP 409.

The folder is named `settings/` to match the Settings page and the other short folder names (`connectors/`, `sync-runs/`).

Fixed filenames are an exception to ADR 0002: a setting group is a singleton, so a stable path avoids duplicates when two devices create it before syncing.

Device-specific preferences stay in browser storage. Today that is the display timezone and the last-open view.
