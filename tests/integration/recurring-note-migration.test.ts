import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const now = "2026-10-11T12:00:00.000Z";
const seriesId = "synthetic:work:weekly-planning";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-note-migration-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const app = new LifeOSApplication(store, new MemoryIndex(), undefined, undefined, "migration-test");
  await app.rebuildIndex();
  return { root, store, app };
}

async function seedLegacy(store: MarkdownObjectStore, input: { body: string; original: string; starts?: string; recurrence?: boolean; title?: string }) {
  const meetingId = uuidV7();
  const noteId = uuidV7();
  const title = input.title ?? "Weekly planning";
  const starts = input.starts ?? input.original;
  await store.write({
    relativePath: `meetings/${meetingId}.md`,
    frontmatter: {
      id: meetingId, type: "meeting", schema_version: 1, revision: 1, title, created_at: now, updated_at: now, updated_by_device: "migration-test", origin: "calendar",
      status: "scheduled", starts_at: starts, ends_at: "2026-10-12T09:00:00.000Z", timezone: "Europe/Paris", attendee_ids: [],
      ...(input.recurrence === false ? {} : { recurrence_series_id: seriesId, recurrence_occurrence_id: `${seriesId}:${input.original}`, original_occurrence_starts_at: input.original })
    },
    body: `# ${title}\n`
  });
  const note = await store.write({
    relativePath: `notes/${noteId}.md`,
    frontmatter: { id: noteId, type: "meeting-note", schema_version: 1, revision: 1, title: `${title} notes`, created_at: now, updated_at: now, updated_by_device: "migration-test", origin: "app", meeting_id: meetingId },
    body: input.body
  });
  return { meetingId, note };
}

describe("reviewed recurring Note migration (#153)", () => {
  it("offers one exact recurrence candidate without changing it, then adopts only after explicit confirmation", async () => {
    const { app, store, root } = await setup();
    const legacy = await seedLegacy(store, { body: "# Notes\n\nKeep this body byte-for-byte.\n", original: "2026-10-12T08:00:00.000Z" });
    await app.rebuildIndex();
    const before = await readFile(path.join(root, legacy.note.relativePath), "utf8");

    const preview = app.recurringMigrationPreview(legacy.meetingId);
    expect(preview).toMatchObject({ requiresConfirmation: true, candidates: [{ noteId: legacy.note.frontmatter.id, body: legacy.note.body }] });
    expect(await readFile(path.join(root, legacy.note.relativePath), "utf8")).toBe(before);

    const [migrated, retry] = await Promise.all([
      app.confirmRecurringMigration(legacy.meetingId, { [legacy.note.frontmatter.id]: legacy.note.contentHash }),
      app.confirmRecurringMigration(legacy.meetingId, { [legacy.note.frontmatter.id]: legacy.note.contentHash })
    ]);
    expect(retry.frontmatter.id).toBe(migrated.frontmatter.id);
    expect(migrated.frontmatter.recurrence_series_id).toBe(seriesId);
    expect(migrated.body).toContain(legacy.note.body);
    const original = app.object(legacy.note.frontmatter.id);
    expect(original.frontmatter.archived_at).toBeDefined();
    expect(original.frontmatter.redirect_to_note_id).toBe(migrated.frontmatter.id);
    expect(app.resolveObjectLink(legacy.note.frontmatter.id)).toMatchObject({ object: { frontmatter: { id: migrated.frontmatter.id } }, sectionId: "occurrence-2026-10-12t08-00-00-000z" });
    expect(app.resolveObjectLink(legacy.meetingId)).toMatchObject({ object: { frontmatter: { id: legacy.meetingId } }, sectionId: "occurrence-2026-10-12t08-00-00-000z" });
  });

  it("previews every exact candidate, permits cancellation by making no write, and never treats a lookalike as a candidate", async () => {
    const { app, store } = await setup();
    const older = await seedLegacy(store, { body: "Older original body\n", original: "2026-10-05T08:00:00.000Z" });
    const newer = await seedLegacy(store, { body: "Newer original body\n", original: "2026-10-12T08:00:00.000Z" });
    const lookalike = await seedLegacy(store, { body: "Do not migrate me\n", original: "2026-10-12T08:00:00.000Z", recurrence: false });
    await app.rebuildIndex();

    const preview = app.recurringMigrationPreview(newer.meetingId);
    expect(preview.candidates.map((candidate) => candidate.noteId)).toEqual([newer.note.frontmatter.id, older.note.frontmatter.id]);
    expect(app.object(older.note.frontmatter.id).frontmatter.archived_at).toBeUndefined();
    expect(app.object(newer.note.frontmatter.id).frontmatter.archived_at).toBeUndefined();
    expect(app.object(lookalike.note.frontmatter.id).frontmatter.archived_at).toBeUndefined();

    const migrated = await app.confirmRecurringMigration(newer.meetingId, {
      [older.note.frontmatter.id]: older.note.contentHash,
      [newer.note.frontmatter.id]: newer.note.contentHash
    });
    expect(migrated.body).toContain("Older original body\n");
    expect(migrated.body).toContain("Newer original body\n");
    expect(migrated.body.indexOf("Newer original body")).toBeLessThan(migrated.body.indexOf("Older original body"));
    expect(app.object(lookalike.note.frontmatter.id).frontmatter.archived_at).toBeUndefined();
  });

  it("offers legacy occurrence Notes even when a shared series Note already exists", async () => {
    const { app, store } = await setup();
    const legacy = await seedLegacy(store, { body: "Legacy body joins the existing note\n", original: "2026-10-12T08:00:00.000Z" });
    const targetId = uuidV7();
    await store.write({
      relativePath: `meetings/${targetId}.md`,
      frontmatter: {
        id: targetId, type: "meeting-note", schema_version: 1, revision: 1, title: "Weekly planning notes", created_at: now, updated_at: now, updated_by_device: "migration-test", origin: "app",
        meeting_id: legacy.meetingId, meeting_ids: [], recurrence_series_id: seriesId, occurrence_sections: []
      },
      body: "# Shared series note\n"
    });
    await app.rebuildIndex();

    const preview = app.recurringMigrationPreview(legacy.meetingId);
    expect(preview.candidates).toHaveLength(1);
    const migrated = await app.confirmRecurringMigration(legacy.meetingId, { [legacy.note.frontmatter.id]: legacy.note.contentHash });
    expect(migrated.frontmatter.id).toBe(targetId);
    expect(migrated.body).toContain("Legacy body joins the existing note\n");
    expect(app.object(legacy.note.frontmatter.id).frontmatter.archived_at).toBeDefined();
  });

  it("replays a migration interrupted after the target write but before its source redirect without duplicate Notes or lost bodies", async () => {
    const { app, store } = await setup();
    const legacy = await seedLegacy(store, { body: "Source body survives recovery\n", original: "2026-10-12T08:00:00.000Z" });
    const newNoteId = uuidV7();
    const operationId = uuidV7();
    const sectionId = "occurrence-2026-10-12T08-00-00-000Z";
    await store.prepareOperation("migrate-recurring-notes", {
      seriesId, noteId: newNoteId, title: "Weekly planning notes", now,
      candidates: [{ noteId: legacy.note.frontmatter.id, meetingId: legacy.meetingId, title: "Weekly planning", body: legacy.note.body, contentHash: legacy.note.contentHash, occurrenceId: `${seriesId}:2026-10-12T08:00:00.000Z`, sectionId, originalStartsAt: "2026-10-12T08:00:00.000Z", startsAt: "2026-10-12T08:00:00.000Z" }]
    }, operationId);
    await store.write({
      relativePath: `meetings/${newNoteId}.md`,
      frontmatter: {
        id: newNoteId, type: "meeting-note", schema_version: 1, revision: 1, title: "Weekly planning notes", created_at: now, updated_at: now, updated_by_device: "migration-test", origin: "app",
        meeting_id: legacy.meetingId, meeting_ids: [legacy.meetingId], recurrence_series_id: seriesId,
        occurrence_sections: [{ occurrence_id: `${seriesId}:2026-10-12T08:00:00.000Z`, section_id: sectionId, meeting_id: legacy.meetingId, original_starts_at: "2026-10-12T08:00:00.000Z", starts_at: "2026-10-12T08:00:00.000Z" }]
      },
      body: `## Weekly planning — 2026-10-12T08:00:00.000Z\n<a id="${sectionId}"></a>\n\n${legacy.note.body}`
    });
    await app.rebuildIndex();

    const recoveryErrors: Error[] = [];
    await app.recoverOperations({ onError: (error) => recoveryErrors.push(error as Error) });
    expect(recoveryErrors).toEqual([]);
    await app.recoverOperations();
    await app.rebuildIndex();

    expect(app.object(newNoteId).body).toContain("Source body survives recovery\n");
    expect(app.object(legacy.note.frontmatter.id).frontmatter.archived_at).toBeDefined();
    expect((await app.listObjects()).filter((object) => object.frontmatter.type === "meeting-note" && object.frontmatter.recurrence_series_id === seriesId)).toHaveLength(1);
    expect((await store.incompleteOperations()).find((operation) => operation.id === operationId)).toBeUndefined();
  });

  it("leaves a journal open and the original intact when it changed after confirmation", async () => {
    const { app, store } = await setup();
    const legacy = await seedLegacy(store, { body: "Confirmed text\n", original: "2026-10-12T08:00:00.000Z" });
    const operationId = uuidV7();
    await store.prepareOperation("migrate-recurring-notes", {
      seriesId, noteId: uuidV7(), title: "Weekly planning notes", now,
      candidates: [{ noteId: legacy.note.frontmatter.id, meetingId: legacy.meetingId, title: "Weekly planning", body: legacy.note.body, contentHash: legacy.note.contentHash, occurrenceId: `${seriesId}:2026-10-12T08:00:00.000Z`, sectionId: "occurrence-2026-10-12T08-00-00-000Z", originalStartsAt: "2026-10-12T08:00:00.000Z", startsAt: "2026-10-12T08:00:00.000Z" }]
    }, operationId);
    await store.write({
      relativePath: legacy.note.relativePath, expectedHash: legacy.note.contentHash,
      frontmatter: { ...legacy.note.frontmatter, revision: 2, updated_at: now }, body: "Edited after confirmation\n"
    });
    await app.rebuildIndex();

    const errors: Error[] = [];
    await app.recoverOperations({ onError: (error) => errors.push(error as Error) });
    expect(errors[0]?.message).toContain("changed after confirmation");
    expect(app.object(legacy.note.frontmatter.id).body).toBe("Edited after confirmation\n");
    expect(app.object(legacy.note.frontmatter.id).frontmatter.archived_at).toBeUndefined();
    expect((await store.incompleteOperations()).find((operation) => operation.id === operationId)).toBeDefined();
  });

  it("never accepts a same-text target collision whose occurrence metadata belongs to another Meeting", async () => {
    const { app, store } = await setup();
    const legacy = await seedLegacy(store, { body: "Collision text\n", original: "2026-10-12T08:00:00.000Z" });
    const targetId = uuidV7();
    const otherMeetingId = uuidV7();
    const sectionId = "occurrence-2026-10-12T08-00-00-000Z";
    await store.prepareOperation("migrate-recurring-notes", {
      seriesId, noteId: targetId, title: "Weekly planning notes", now,
      candidates: [{ noteId: legacy.note.frontmatter.id, meetingId: legacy.meetingId, title: "Weekly planning", body: legacy.note.body, contentHash: legacy.note.contentHash, occurrenceId: `${seriesId}:2026-10-12T08:00:00.000Z`, sectionId, originalStartsAt: "2026-10-12T08:00:00.000Z", startsAt: "2026-10-12T08:00:00.000Z" }]
    }, uuidV7());
    await store.write({
      relativePath: `meetings/${targetId}.md`,
      frontmatter: {
        id: targetId, type: "meeting-note", schema_version: 1, revision: 1, title: "Weekly planning notes", created_at: now, updated_at: now, updated_by_device: "migration-test", origin: "app",
        meeting_id: otherMeetingId, meeting_ids: [otherMeetingId], recurrence_series_id: seriesId,
        occurrence_sections: [{ occurrence_id: `${seriesId}:2026-10-12T08:00:00.000Z`, section_id: sectionId, meeting_id: otherMeetingId, original_starts_at: "2026-10-12T08:00:00.000Z", starts_at: "2026-10-12T08:00:00.000Z" }]
      },
      body: `## Weekly planning — 2026-10-12T08:00:00.000Z\n<a id="${sectionId}"></a>\n\n${legacy.note.body}`
    });
    await app.rebuildIndex();

    const errors: Error[] = [];
    await app.recoverOperations({ onError: (error) => errors.push(error as Error) });
    expect(errors[0]?.message).toContain("already present");
    expect(app.object(legacy.note.frontmatter.id).frontmatter.archived_at).toBeUndefined();
  });
});
