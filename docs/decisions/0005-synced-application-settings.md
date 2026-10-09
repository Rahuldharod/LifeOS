# ADR 0005: Synced application settings live in `data/settings/`

- Status: Accepted
- Date: 2026-10-02
- Amended: 2026-10-04 by #95 (device-specific settings the server needs)

User preferences that should follow the user across devices are stored as `app-setting` Markdown objects in `data/settings/`, one fixed-name file per setting group (for example `settings/calendar-preferences.md`). They use the normal object envelope, revision and expected-hash checks, so a stale write returns HTTP 409.

The folder is named `settings/` to match the Settings page and the other short folder names (`connectors/`, `sync-runs/`).

Fixed filenames are an exception to ADR 0002: a setting group is a singleton, so a stable path avoids duplicates when two devices create it before syncing.

Device-specific preferences stay in browser storage. Today that is the display timezone and the last-open view.

**Device-specific settings the server needs (#95).** Browser storage works only for preferences the browser alone uses. A device-specific setting the server reads in the background, such as the off-Drive backup folder (a local path like `/Volumes/Backup`, meaningless on the other Mac), is stored in its synced setting group keyed by device ID: `off_drive_folders: { <device ID>: <path> }` in `settings/backups.md`. Each device reads and changes only its own entry and the Settings card says it applies to this Mac only.

Why keyed by device ID rather than a device-local file: there is no server-side device-local store today, and adding one means a new location outside Drive with its own write rules. The keyed entry reuses the guarded object write (revision, expected hash, 409), is backed up with the data, and survives reinstalling the app. The cost is that each device's path is visible in the synced file, and an edit on one device can return 409 on the other until it reloads. A folder saved before #95 (`off_drive_folder`) belongs to the device that last saved the setting, and moves into the map on the next save.
