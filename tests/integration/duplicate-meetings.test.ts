import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { MockCalendarConnector } from "@lifeos/connectors";
import { uuidV7 } from "@lifeos/domain";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// PB-004: two near-simultaneous first edits created two meetings for one calendar event. Creation
// is now serialized per event, and a one-off reconcile archives the extra copy.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-duplicates-"));
  roots.push(root);
  const store = new MarkdownObjectStore(root);
  const application = new LifeOSApplication(store, new MemoryIndex(), new MockCalendarConnector(), undefined, "integration-test");
  await application.rebuildIndex();
  const [event] = await application.listCalendarEvents();
  return { store, application, event: event! };
}

const meetings = (application: LifeOSApplication) => application.listObjects().then((objects) => objects.filter((object) => object.frontmatter.type === "meeting"));

/** Writes a meeting + note pair directly, the way the old race left them on disk. */
async function writeCopy(store: MarkdownObjectStore, externalId: string, noteBody: string, revision: number) {
  const meetingId = uuidV7();
  const noteId = uuidV7();
  const now = new Date().toISOString();
  const envelope = (id: string, type: "meeting" | "meeting-note", title: string) => ({ id, type, schema_version: 1, revision, title, created_at: now, updated_at: now, updated_by_device: "old-race" });
  await store.write({ relativePath: `meetings/product-weekly--${meetingId}.md`, frontmatter: { ...envelope(meetingId, "meeting", "Product Weekly"), status: "scheduled", starts_at: "2026-09-21T08:15:00.000Z", ends_at: "2026-09-21T09:00:00.000Z", timezone: "Europe/Paris", attendee_ids: [], external_refs: [{ provider: "mock", external_id: externalId }] }, body: "# Product Weekly\n" });
  await store.write({ relativePath: `meetings/product-weekly-notes--${noteId}.md`, frontmatter: { ...envelope(noteId, "meeting-note", "Product Weekly notes"), meeting_id: meetingId }, body: noteBody });
  return { meetingId, noteId };
}

describe("duplicate meetings (PB-004)", () => {
  it("concurrent first edits for one event create a single meeting and note", async () => {
    const { application, event } = await setup();
    const [first, second] = await Promise.all([
      application.createMeetingFromEvent(event.externalId, undefined, undefined, event.calendarId, "First tab.\n"),
      application.createMeetingFromEvent(event.externalId, undefined, undefined, event.calendarId, "Second tab.\n")
    ]);
    expect(second.meeting.frontmatter.id).toBe(first.meeting.frontmatter.id);
    expect(second.note?.frontmatter.id).toBe(first.note?.frontmatter.id);
    expect(await meetings(application)).toHaveLength(1);
    expect(application.notes()).toHaveLength(1);
    expect((await application.health()).diagnostics).toEqual([]);
  });

  it("dry run reports, apply archives the empty copy and keeps the one with real notes", async () => {
    const { store, application } = await setup();
    const kept = await writeCopy(store, "evt-1", "Real decisions from the meeting.\n", 10);
    const extra = await writeCopy(store, "evt-1", "# Notes\n\n", 1);
    await application.rebuildIndex();
    expect((await application.health()).diagnostics.join("\n")).toContain("Duplicate external reference mock:evt-1");

    const dryRun = await application.reconcileDuplicateMeetings({ apply: false });
    expect(dryRun.groups).toHaveLength(1);
    expect(dryRun.groups[0]).toMatchObject({ needsManualMerge: false, keep: { meetingId: kept.meetingId, noteIds: [kept.noteId] } });
    expect(dryRun.groups[0]!.archive.map((target) => target.id).sort()).toEqual([extra.meetingId, extra.noteId].sort());
    expect(application.notes()).toHaveLength(2); // nothing written yet

    await application.reconcileDuplicateMeetings({ apply: true });
    const archived = (await application.listObjects()).filter((object) => object.frontmatter.archived_at);
    expect(archived.map((object) => object.frontmatter.id).sort()).toEqual([extra.meetingId, extra.noteId].sort());
    expect(application.notes().map((note) => note.frontmatter.id)).toEqual([kept.noteId]);
    expect((await application.health()).diagnostics).toEqual([]);
    expect((await application.listObjects()).filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === "object.archived")).toHaveLength(2);

    // Idempotent: a second run finds nothing left to do.
    expect((await application.reconcileDuplicateMeetings({ apply: true })).groups).toEqual([]);
  });

  it("never archives a copy whose note also has real text", async () => {
    const { store, application } = await setup();
    await writeCopy(store, "evt-2", "Notes typed in one tab.\n", 3);
    await writeCopy(store, "evt-2", "Different notes typed in another tab.\n", 2);
    await application.rebuildIndex();

    const result = await application.reconcileDuplicateMeetings({ apply: true });
    expect(result.groups[0]?.needsManualMerge).toBe(true);
    expect((await application.listObjects()).filter((object) => object.frontmatter.archived_at)).toHaveLength(0);
  });
});
