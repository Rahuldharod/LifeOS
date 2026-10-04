# ADR 0004: Versioned checksummed backups and restoration drills

- Status: Accepted
- Date: 2026-09-21
- Amended: 2026-10-04 by #84 (automatic backups, weekly off-Drive copy) and #95 (stop sequence, shared queue, retention rules written down)

LifeOS stores backups in the sibling `LifeOS App/backups` directory, outside the code repository and outside the authoritative Markdown root. Each immutable snapshot contains a `data` tree plus `manifest.json`, which records every portable relative path, byte size and SHA-256 checksum.

The transient `.lifeos/session.md` lease and temporary files are excluded. Markdown objects, system schema files and assets are included. A restoration drill copies the snapshot into an isolated temporary directory, verifies its complete manifest, and removes the temporary restoration afterward; it never replaces live data. The local implementation retains ten generations and makes completed snapshots read-only. Replacing the live data root remains a separate destructive operation requiring explicit user authorization.

## Automatic backups and the weekly off-Drive copy (#84, #95)

- **When.** A backup is taken at app start, daily while running (once the newest is 24 hours old) and at a clean stop, only on the device holding the lease (ADR 0003). A warning shows when a backup fails or none succeeded in 26 hours.
- **Off-Drive copy.** Once a week the newest backup that passes its checksums is copied to a folder outside Google Drive, so a Drive problem cannot take both data and backups. The copy is staged, checksum-verified, renamed and made read-only. The folder must already exist; a missing disk is a failure, not a new folder on the system disk. It is refused when it is inside Google Drive, the data folder or the backup folder, judged after symbolic links are resolved. Each device sets its own folder (ADR 0005).
- **Retention.** The backup folder keeps ten generations; the off-Drive folder keeps four.
- **Prune rule.** Pruning deletes generations beyond the count, except that when none of the kept generations verifies, the newest older backup that does verify is spared. The only good backup is never deleted.
- **One at a time with adoption.** Backups and adoption batches share one queue (ADR 0013 `OneAtATime`), so a snapshot never holds an adopted object whose draft is still unfiled, which would duplicate it after a restore.
- **Clean stop.** The server stops HTTP writes (503), closes HTTP and waits for adoption to go idle (each wait bounded), then takes the stop backup, then releases the lease. The stop backup gives up after 35 seconds; all bounded waits together stay below the stop script's 60-second kill timeout, so the lease is released even after a slow backup.
- **Unfinished snapshots.** A killed backup leaves a `.creating-*` staging folder. It is never listed as a backup, and the first backup of the next run sweeps it; an off-Drive copy sweeps its folder's staging folders before copying.
