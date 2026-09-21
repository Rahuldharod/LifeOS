# ADR 0002: Human-readable object filenames

- Status: Accepted
- Date: 2026-09-20

Markdown object filenames use the convention:

```text
YYYY-MM-DD-HHmm-descriptive-title--full-uuid.md
```

The timestamp makes chronological browsing useful, the slug explains the file at a glance, and the complete UUID prevents collisions. The UUID in YAML front matter remains the authoritative identity; paths and titles may change without changing relationships. Meeting filenames use the meeting's local timezone. Other newly created object filenames use their UTC creation timestamp.
