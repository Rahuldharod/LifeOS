import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// PB-021: deleting a note is a tombstone, never a hard delete.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-note-delete-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), new MockCalendarConnector(), undefined, "integration-test");
  await application.rebuildIndex();
  const [event] = await application.listCalendarEvents();
  const workspace = await application.createMeetingFromEvent(event!.externalId, undefined, undefined, undefined, "# Notes\n\nCreated by mistake\n");
  return { root, store, application, event: event!, note: workspace.note!, meetingId: workspace.meeting.frontmatter.id };
}

describe("note deletion (PB-021)", () => {
  it("tombstones the note, keeps the file and hides it everywhere", async () => {
    const { root, store, application, event, note, meetingId } = await setup();

    const deleted = await application.deleteNote(note.frontmatter.id, note.contentHash);
    expect(deleted.frontmatter.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(deleted.frontmatter.revision).toBe(note.frontmatter.revision + 1);

    // The file is still on disk with its body intact, now carrying the tombstone.
    const onDisk = await store.read(note.relativePath);
    expect(onDisk.body).toBe(note.body);
    expect(onDisk.frontmatter.deleted_at).toBe(deleted.frontmatter.deleted_at);

    expect(application.notes().map((candidate) => candidate.frontmatter.id)).not.toContain(note.frontmatter.id);
    expect((await application.meetingWorkspace(meetingId)).note).toBeUndefined();
    expect((await application.listCalendarEvents()).find((candidate) => candidate.externalId === event.externalId)?.hasNote).toBe(false);
    expect((await readdir(path.join(root, "audit"))).some((file) => file.includes("note-deleted"))).toBe(true);
  });

  it("is idempotent and blocks later edits to the deleted note", async () => {
    const { application, note } = await setup();
    const deleted = await application.deleteNote(note.frontmatter.id, note.contentHash);
    // A retry with the pre-delete hash returns the tombstone instead of failing or writing again.
    await expect(application.deleteNote(note.frontmatter.id, note.contentHash)).resolves.toMatchObject({ contentHash: deleted.contentHash });
    await expect(application.updateBody(note.frontmatter.id, "late autosave", deleted.contentHash)).rejects.toThrow("deleted");
  });

  it("starts a fresh note when the event is edited again, leaving the deleted file untouched", async () => {
    const { store, application, event, note, meetingId } = await setup();
    await application.deleteNote(note.frontmatter.id, note.contentHash);
    const tombstone = await store.read(note.relativePath);

    const reopened = await application.createMeetingFromEvent(event.externalId, undefined, undefined, undefined, "# Notes\n\nSecond attempt\n");
    expect(reopened.meeting.frontmatter.id).toBe(meetingId);
    expect(reopened.note?.frontmatter.id).not.toBe(note.frontmatter.id);
    expect(reopened.note?.body).toBe("# Notes\n\nSecond attempt\n");
    expect((await store.read(note.relativePath)).contentHash).toBe(tombstone.contentHash);
  });

  it("refuses a stale hash and non-note objects", async () => {
    const { application, note } = await setup();
    const edited = await application.updateBody(note.frontmatter.id, "# Notes\n\nEdited on the other device\n", note.contentHash);
    await expect(application.deleteNote(note.frontmatter.id, note.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
    expect(application.notes().map((candidate) => candidate.frontmatter.id)).toContain(edited.frontmatter.id);

    const task = await application.createEntity("task", { title: "Not a note" });
    await expect(application.deleteNote(task.frontmatter.id, task.contentHash)).rejects.toThrow("Only notes");
  });
});
