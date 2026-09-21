# ADR 0001: Separate code and user data roots

- Status: Accepted
- Date: 2026-09-20

The Git repository lives in `LifeOS App/code`. The synchronized Markdown object store lives in the sibling `LifeOS App/data` directory. This preserves a convenient shared parent folder while ensuring user content is not located inside, staged by, or pushed from the code repository.
