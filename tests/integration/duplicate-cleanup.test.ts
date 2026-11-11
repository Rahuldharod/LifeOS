import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, personEmails, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// Duplicate clean-up (CONTEXT.md): every likely duplicate among all live People, sure matches pre-ticked, a backup first.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

/** A Person written by an older build: named by an address, no email stored, no origin (so not unreviewed). */
async function seedBareAddressPerson(root: string, id: string, address: string) {
  await mkdir(path.join(root, "people"), { recursive: true });
  await writeFile(path.join(root, "people", `bare--${id}.md`), `---\nid: ${id}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: ${address}\ncreated_at: 2026-09-10T08:00:00Z\nupdated_at: 2026-09-10T08:00:00Z\nupdated_by_device: test\ngiven_name: ${address}\n---\n# ${address}\n`);
}

const BARE_JANE = "01a10000-0000-7000-8000-0000000000a1";
const BARE_SOLO = "01a10000-0000-7000-8000-0000000000a2";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-cleanup-"));
  roots.push(root);
  await seedBareAddressPerson(root, BARE_JANE, "jane.doe@example.com");
  await seedBareAddressPerson(root, BARE_SOLO, "solo@example.com");
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  calendar.events = [{ externalId: "e1", title: "Sync", startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: [], attendeeDetails: [{ email: "jane.doe@example.com", displayName: "Jane Doe" }] }];
  const workspace = await application.createMeetingFromEvent("e1");
  const jane = application.entities("person").find((person) => person.frontmatter.title === "Jane Doe")!;
  // Two people the user made with the same name: a name-only match, never pre-ticked.
  const samA = await application.createEntity("person", { title: "Sam Lee", given_name: "Sam", family_name: "Lee" });
  const samB = await application.createEntity("person", { title: "Sam Lee", given_name: "Sam", family_name: "Lee" });
  // A pair the user once kept separate never comes back.
  const kimA = await application.createEntity("person", { title: "Kim Roux", given_name: "Kim", family_name: "Roux" });
  calendar.events = [{ ...calendar.events[0]!, externalId: "e2", attendeeDetails: [{ email: "kim.roux@example.com", displayName: "Kim Roux" }] }];
  await application.createMeetingFromEvent("e2");
  await application.suggestPersonMerges();
  const kimPair = application.reviews().find((review) => (review.frontmatter.proposed_fields as Record<string, string>).keep_title === "Kim Roux")!;
  await application.rejectReviewItem(kimPair.frontmatter.id);
  return { application, jane, samA, samB, kimA, noteId: workspace.note!.frontmatter.id };
}

describe("Duplicate clean-up", () => {
  it("lists merges across all live People, pre-ticks only sure matches, offers repairs, and leaves out pairs kept separate", async () => {
    const { application, jane, samA, samB } = await setup();
    const rows = await application.duplicateCleanup();
    expect(rows).toEqual(expect.arrayContaining([
      { kind: "merge", keepPersonId: jane.frontmatter.id, mergePersonId: BARE_JANE, keepTitle: "Jane Doe", mergeTitle: "jane.doe@example.com", match: "name-address", preTicked: true },
      expect.objectContaining({ kind: "merge", match: "name", preTicked: false, keepTitle: "Sam Lee", mergeTitle: "Sam Lee" }),
      { kind: "repair", personId: BARE_SOLO, title: "solo@example.com", email: "solo@example.com" }
    ]));
    expect(rows.filter((row) => row.kind === "merge" && [row.keepPersonId, row.mergePersonId].sort().join() === [samA.frontmatter.id, samB.frontmatter.id].sort().join())).toHaveLength(1);
    expect(rows.some((row) => row.kind === "merge" && row.keepTitle === "Kim Roux")).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("backs up before changing anything, then merges the ticked pairs and repairs the ticked People", async () => {
    const { application, jane, noteId } = await setup();
    let liveAtBackup: string[] = [];
    const result = await application.applyDuplicateCleanup({ merges: [{ keepPersonId: jane.frontmatter.id, mergePersonId: BARE_JANE }], repairs: [BARE_SOLO] }, async () => {
      liveAtBackup = application.entities("person").map((person) => person.frontmatter.id);
      return { backupId: "backup-1" };
    });
    expect(liveAtBackup).toContain(BARE_JANE);
    expect(result).toEqual({ backupId: "backup-1", merged: 1, repaired: 1, skipped: 0 });
    expect(application.object(BARE_JANE).frontmatter.merged_into_person_id).toBe(jane.frontmatter.id);
    expect(application.object(noteId).frontmatter.people_ids).toContain(jane.frontmatter.id);
    expect(personEmails(application.object(BARE_SOLO))).toEqual(["solo@example.com"]);
  });

  it("changes nothing when the backup fails", async () => {
    const { application, jane } = await setup();
    await expect(application.applyDuplicateCleanup({ merges: [{ keepPersonId: jane.frontmatter.id, mergePersonId: BARE_JANE }], repairs: [BARE_SOLO] }, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(application.object(BARE_JANE).frontmatter.deleted_at).toBeUndefined();
    expect(personEmails(application.object(BARE_SOLO))).toEqual([]);
  });

  it("follows earlier merges in the same run and skips a pair that is already one Person", async () => {
    const { application, samA, samB } = await setup();
    const result = await application.applyDuplicateCleanup({ merges: [{ keepPersonId: samA.frontmatter.id, mergePersonId: samB.frontmatter.id }, { keepPersonId: samB.frontmatter.id, mergePersonId: samA.frontmatter.id }], repairs: [] }, async () => ({ backupId: "b" }));
    expect(result).toMatchObject({ merged: 1, skipped: 1 });
  });
});
