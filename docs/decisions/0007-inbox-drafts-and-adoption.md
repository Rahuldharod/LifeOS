# ADR 0007: Agents write Inbox Drafts; only the application writes objects

- Status: Accepted
- Date: 2026-10-04
- Source: Phase A PRD (spec #21)
- Supersedes: the map #1 charting decision that Agents write authoritative object files directly under the Object Contract.

Agents (Claude skills, Steve, routines) never create or edit object files. They write **Inbox Drafts** into `_inbox/drafts/` and **Patch Drafts** into `_inbox/patches/`, using a short front-matter format (`lifeos_draft: 1` or `lifeos_patch: 1`) that references projects, clients, products and people by name.

The application **adopts** each draft: it assigns the UUIDv7 and full Object Envelope, resolves names to IDs, validates, files the object per ADR 0002 and routes it. Text the user dictated (`origin: user-dictated`) becomes an object directly; anything an Agent extracted (`origin: agent-extracted`) becomes a Review Item. Ambiguous or unknown names raise a `link-resolution` Review Item instead of a guess.

Adoption is idempotent on `draft_key` plus content hash, skips files still being written, and moves each draft to `_inbox/processed/` or `_inbox/failed/` with a `.result.md` sidecar. Failed drafts are never deleted automatically.

Why: one writer keeps revision checks, envelope rules, duplicate-ID blocking and audit in one place. It also means the advisory device lease (ADR 0003) does not need to cover Agents, and a half-written agent file can never be scanned as an object.

The object scan ignores `_inbox/` and `_agent/`. Backups include `_inbox/` and exclude `_agent/`.
