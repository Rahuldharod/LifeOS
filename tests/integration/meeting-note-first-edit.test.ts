import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// PB-020: opening a calendar event must not write anything. The meeting, its note and the
// client/project/person context are created only when the web UI sends the first real edit.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-first-edit-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), new MockCalendarConnector(), undefined, "integration-test");
  await application.rebuildIndex();
  const [event] = await application.listCalendarEvents();
  const files = async () => (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
  return { root, store, application, event: event!, files };
}

describe("meeting note is created on the first real edit", () => {
  it("opening an event writes no files and returns a non-persisted preview", async () => {
    const { application, event, files } = await setup();
    const before = await files();

    const preview = await application.previewMeetingFromEvent(event.externalId);
    await application.previewMeetingFromEvent(event.externalId); // repeated opens are still read-only

    expect(preview.persisted).toBe(false);
    expect(preview.note).toBeUndefined();
    expect(preview.meeting.frontmatter.title).toBe(event.title);
    expect(preview.context.project?.frontmatter.title).toBe("LifeOS MVP");
    expect(preview.context.people).toHaveLength(2);
    expect(await files()).toEqual(before);
    expect(application.entities("project")).toHaveLength(0);
    expect(application.notes()).toHaveLength(0);
    expect((await application.listCalendarEvents())[0]).toMatchObject({ hasNote: false, meetingId: undefined });
  });

  it("creates the meeting and a note holding the first edit, and tolerates retries", async () => {
    const { application, event, files } = await setup();
    const first = await application.createMeetingFromEvent(event.externalId, undefined, undefined, undefined, "Confirm audience sizing.\n");
    expect(first.persisted).toBe(true);
    expect(first.note?.body).toBe("Confirm audience sizing.\n");
    expect(first.note?.body).not.toContain("# Notes");
    const afterFirst = await files();

    // Lost response -> the client retries, possibly with more text. Same objects, no overwrite, no duplicates.
    const retry = await application.createMeetingFromEvent(event.externalId, undefined, undefined, undefined, "Confirm audience sizing.\nPlus more typed since.\n");
    expect(retry.meeting.frontmatter.id).toBe(first.meeting.frontmatter.id);
    expect(retry.note?.frontmatter.id).toBe(first.note?.frontmatter.id);
    expect(retry.note?.body).toBe("Confirm audience sizing.\n");
    expect(await files()).toEqual(afterFirst);
    expect(application.notes()).toHaveLength(1);

    // After creation the preview is the real workspace, and later edits use the ordinary hash-checked path.
    const reopened = await application.previewMeetingFromEvent(event.externalId);
    expect(reopened.persisted).toBe(true);
    expect(reopened.note?.frontmatter.id).toBe(first.note?.frontmatter.id);
    const updated = await application.updateBody(first.note!.frontmatter.id, "Confirm audience sizing.\nPlus more typed since.\n", first.note!.contentHash);
    expect(updated.frontmatter.revision).toBe(2);
    await expect(application.updateBody(first.note!.frontmatter.id, "stale", first.note!.contentHash)).rejects.toMatchObject({ name: "ObjectConflictError" });
  });

  it("recovers an interrupted create with the user's text, not a placeholder", async () => {
    const { root, store, application, event } = await setup();
    await store.prepareOperation("create-meeting", { externalId: event.externalId, meetingId: "01995d4e-a934-70e5-a5a6-85e31541a91f", noteId: "01995d52-7baf-7c21-9c96-9c5d2f6a32ac", body: "Typed before the crash\n" }, "01995d53-0000-7000-8000-000000000001");

    expect(await application.recoverOperations()).toHaveLength(1);

    const note = application.notes()[0]!;
    expect(note.frontmatter.id).toBe("01995d52-7baf-7c21-9c96-9c5d2f6a32ac");
    expect(await readFile(path.join(root, note.relativePath), "utf8")).toContain("Typed before the crash");
    expect(await application.recoverOperations()).toHaveLength(0);
    expect(application.notes()).toHaveLength(1);
  });

  it("creates the note for a meeting that exists without one (older open-time flow)", async () => {
    const { root, application, event } = await setup();
    const created = await application.createMeetingFromEvent(event.externalId, undefined, undefined, undefined, "seed\n");
    await rm(path.join(root, created.note!.relativePath));
    await application.rebuildIndex();
    expect((await application.previewMeetingFromEvent(event.externalId)).note).toBeUndefined();

    const repaired = await application.createMeetingFromEvent(event.externalId, undefined, undefined, undefined, "first real edit\n");

    expect(repaired.meeting.frontmatter.id).toBe(created.meeting.frontmatter.id);
    expect(repaired.note?.body).toBe("first real edit\n");
    expect((await application.listObjects()).filter((object) => object.frontmatter.type === "meeting")).toHaveLength(1);
  });
});
