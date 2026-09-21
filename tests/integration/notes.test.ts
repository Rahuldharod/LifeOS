import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("recent notes", () => {
  it("returns editable note objects newest first and excludes non-note objects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-notes-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const meetingId = "01995d4e-a934-70e5-a5a6-85e31541a91f";
    const base = { schema_version: 1 as const, revision: 1, created_at: "2026-09-20T08:00:00Z", updated_by_device: "test" };
    await store.write({ relativePath: "meetings/older.md", frontmatter: { ...base, id: "01995d52-7baf-7c21-9c96-9c5d2f6a32ac", type: "meeting-note", title: "Older", updated_at: "2026-09-20T09:00:00Z", meeting_id: meetingId }, body: "Older body" });
    await store.write({ relativePath: "meetings/newer.md", frontmatter: { ...base, id: "01995d52-7baf-7c21-9c96-9c5d2f6a32ad", type: "meeting-note", title: "Newer", updated_at: "2026-09-21T09:00:00Z", meeting_id: meetingId }, body: "Newer body" });
    await store.write({ relativePath: "tasks/task.md", frontmatter: { ...base, id: "01995d60-7baf-7c21-9c96-9c5d2f6a32ac", type: "task", title: "Not a note", updated_at: "2026-09-22T09:00:00Z", status: "Inbox", owner_person_id: "01995d3e-912b-7357-8aa6-9816c1ad90a5" }, body: "Task body" });

    const application = new LifeOSApplication(store, new MemoryIndex());
    await application.rebuildIndex();
    expect(application.notes().map((note) => note.frontmatter.title)).toEqual(["Newer", "Older"]);
    expect(application.notes()[0]?.body).toBe("Newer body");
  });
});
