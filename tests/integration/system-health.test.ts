import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemSessionStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("system health and device handoff", () => {
  it("blocks a second active device until an explicit takeover", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-session-"));
    roots.push(root);
    const first = new FilesystemSessionStore(root, "device-a", 60_000);
    const second = new FilesystemSessionStore(root, "device-b", 60_000);

    expect((await first.start()).writeAllowed).toBe(true);
    const blocked = await second.start();
    expect(blocked.writeAllowed).toBe(false);
    expect(blocked.activeDeviceId).toBe("device-a");

    expect((await second.takeOver()).writeAllowed).toBe(true);
    expect((await first.refresh()).writeAllowed).toBe(false);
  });

  it("reports broken references and duplicate canonical notes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-health-"));
    roots.push(root);
    const store = new MarkdownObjectStore(root);
    const timestamp = "2026-09-21T06:00:00Z";
    const meetingId = "01995d4e-a934-70e5-a5a6-85e31541a91f";
    const missingPersonId = "01995d3e-912b-7357-8aa6-9816c1ad90a5";
    await store.write({ relativePath: "meetings/meeting.md", frontmatter: { id: meetingId, type: "meeting", schema_version: 1, revision: 1, title: "Meeting", created_at: timestamp, updated_at: timestamp, updated_by_device: "test", status: "scheduled", starts_at: timestamp, ends_at: "2026-09-21T07:00:00Z", timezone: "UTC", attendee_ids: [] }, body: "" });
    for (const id of ["01995d52-7baf-7c21-9c96-9c5d2f6a32ac", "01995d52-7baf-7c21-9c96-9c5d2f6a32ad"]) {
      await store.write({ relativePath: `meetings/${id}.md`, frontmatter: { id, type: "meeting-note", schema_version: 1, revision: 1, title: "Notes", created_at: timestamp, updated_at: timestamp, updated_by_device: "test", meeting_id: meetingId }, body: "" });
    }
    await store.write({ relativePath: "tasks/task.md", frontmatter: { id: "01995d60-7baf-7c21-9c96-9c5d2f6a32ac", type: "task", schema_version: 1, revision: 1, title: "Task", created_at: timestamp, updated_at: timestamp, updated_by_device: "test", status: "Inbox", owner_person_id: missingPersonId }, body: "" });

    const application = new LifeOSApplication(store, new MemoryIndex());
    const health = await application.rebuildIndex();
    expect(health.diagnostics.some((issue) => issue.includes("missing object"))).toBe(true);
    expect(health.diagnostics.some((issue) => issue.includes("multiple canonical notes"))).toBe(true);
  });
});
