# ADR 0009: Agents read a derived, disposable Agent Index

- Status: Accepted; amended by [ADR 0016](0016-quiet-drive-writes.md) (2026-10-09): a file is written only when its content changed, and only by the lease holder.
- Date: 2026-10-04
- Source: Phase A PRD (spec #21)
- Supersedes: the map #1 assumption that Agents scan object files directly to answer questions.

After each index rebuild (debounced), the application writes a small set of Markdown summary files to `_agent/`: an overview, open tasks, waiting-on, open points, recent decisions, active projects/clients/products, people and recent/upcoming meetings. Every entry carries ID, title, relative path and key fields; every file states when it was generated. Pending Inbox Drafts are counted and labelled "pending adoption".

The Agent Index is derived and disposable, like the in-memory index: the application never reads it back and it is never authoritative. It is excluded from the object scan, the file watcher and backups.

Why: an Agent on a phone cannot scan thousands of files to answer "what do I owe Joel?". A short, current summary with IDs and paths lets it answer quickly and then open the exact file when it needs detail.

Skills must tell the user when the index is older than 24 hours. Restricted objects are counted, never listed (ADR 0010).
