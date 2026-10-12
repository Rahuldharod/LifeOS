import { describe, expect, it } from "vitest";
import { uuidV7 } from "@lifeos/domain";
import { testApi } from "./test-api.js";

const now = "2026-10-11T12:00:00.000Z";
const seriesId = "synthetic:work:api-legacy-series";

describe("reviewed recurring Note migration API (#153)", () => {
  it("previews read-only, rejects a stale confirmation, and migrates only from the confirmed endpoint", async () => {
    const meetingId = uuidV7();
    const noteId = uuidV7();
    const original = "Legacy API body\n";
    const { call, send, start } = await testApi({ files: {
      "meetings/legacy-meeting.md": `---\nid: ${meetingId}\ntype: meeting\nschema_version: 1\nrevision: 1\ntitle: API legacy weekly\ncreated_at: ${now}\nupdated_at: ${now}\nupdated_by_device: api-test\norigin: calendar\nstatus: scheduled\nstarts_at: 2026-10-12T08:00:00.000Z\nends_at: 2026-10-12T09:00:00.000Z\ntimezone: Europe/Paris\nattendee_ids: []\nrecurrence_series_id: ${seriesId}\nrecurrence_occurrence_id: ${seriesId}:2026-10-12T08:00:00.000Z\noriginal_occurrence_starts_at: 2026-10-12T08:00:00.000Z\n---\n# API legacy weekly\n`,
      "notes/legacy-note.md": `---\nid: ${noteId}\ntype: meeting-note\nschema_version: 1\nrevision: 1\ntitle: API legacy weekly notes\ncreated_at: ${now}\nupdated_at: ${now}\nupdated_by_device: api-test\norigin: app\nmeeting_id: ${meetingId}\n---\n${original}`
    } });
    await start();

    const before = await call("GET /api/v1/objects");
    const preview = await call("GET /api/v1/meetings/:id/recurring-migration", { params: { id: meetingId } });
    expect(preview).toMatchObject({ requiresConfirmation: true, candidates: [{ noteId, body: original }] });
    expect(await call("GET /api/v1/objects")).toEqual(before);

    const candidate = preview.candidates[0]!;
    const changed = await call("PUT /api/v1/objects/:id/body", { params: { id: noteId }, body: { body: "Edited after preview\n", expectedHash: candidate.contentHash } });
    const stale = await send("POST", `/api/v1/meetings/${meetingId}/recurring-migration`, { expectedHashes: { [noteId]: candidate.contentHash } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: expect.stringContaining("stale") });

    const fresh = await call("GET /api/v1/meetings/:id/recurring-migration", { params: { id: meetingId } });
    const migrated = await call("POST /api/v1/meetings/:id/recurring-migration", { params: { id: meetingId }, body: { expectedHashes: { [noteId]: fresh.candidates[0]!.contentHash } } });
    expect(migrated.body).toContain(changed.body);
    const archived = (await call("GET /api/v1/objects")).find((object) => object.frontmatter.id === noteId)!;
    expect(archived.frontmatter).toMatchObject({ archived_at: expect.any(String), redirect_to_note_id: migrated.frontmatter.id });
  });
});
