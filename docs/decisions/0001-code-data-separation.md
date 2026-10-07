# ADR 0001: Separate code and user data roots

- Status: Superseded by [ADR 0014](0014-code-outside-google-drive.md) (2026-10-07): the code now lives in `~/Developer/LifeOS`, outside Google Drive, and finds the data through `LIFEOS_DATA_ROOT`.
- Date: 2026-09-20

The Git repository lives in `LifeOS App/code`. The synchronized Markdown object store lives in the sibling `LifeOS App/data` directory. This preserves a convenient shared parent folder while ensuring user content is not located inside, staged by, or pushed from the code repository.
