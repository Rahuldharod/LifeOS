# ADR 0004: Versioned checksummed backups and restoration drills

- Status: Accepted
- Date: 2026-09-21

LifeOS stores backups in the sibling `LifeOS App/backups` directory, outside the code repository and outside the authoritative Markdown root. Each immutable snapshot contains a `data` tree plus `manifest.json`, which records every portable relative path, byte size and SHA-256 checksum.

The transient `.lifeos/session.md` lease and temporary files are excluded. Markdown objects, system schema files and assets are included. A restoration drill copies the snapshot into an isolated temporary directory, verifies its complete manifest, and removes the temporary restoration afterward; it never replaces live data. The local implementation retains ten generations and makes completed snapshots read-only. Replacing the live data root remains a separate destructive operation requiring explicit user authorization.
