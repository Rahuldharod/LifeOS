import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";

// A Merge suggestion for an older Email-only person named by a bare address that another Person holds (CONTEXT.md).

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

const BARE_ID = "01a10000-0000-7000-8000-00000000b4e0";

/** A Person written by an older build: named by the address, no email stored, no origin (so not unreviewed). */
async function seedBareAddressPerson(root: string, address: string) {
  await mkdir(path.join(root, "people"), { recursive: true });
  await writeFile(path.join(root, "people", `bare--${BARE_ID}.md`), `---\nid: ${BARE_ID}\ntype: person\nschema_version: 1\nrevision: 1\ntitle: ${address}\ncreated_at: 2026-09-10T08:00:00Z\nupdated_at: 2026-09-10T08:00:00Z\nupdated_by_device: test\ngiven_name: ${address}\n---\n# ${address}\n`);
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-merge-address-"));
  roots.push(root);
  await seedBareAddressPerson(root, "jane.doe@example.com");
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "test", new FilesystemInboxStore(root));
  await application.rebuildIndex();
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  calendar.events = [{ externalId: "e1", title: "Sync", startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: [], attendeeDetails: [{ email: "jane.doe@example.com", displayName: "Jane Doe" }] }];
  await application.createMeetingFromEvent("e1");
  const jane = (await application.listObjects()).find((object) => object.frontmatter.title === "Jane Doe")!;
  return { application, jane };
}

const merges = (application: LifeOSApplication) => application.reviews().filter((review) => review.frontmatter.review_type === "person-merge");

describe("Merge suggestion: a name that is another Person's address", () => {
  it("proposes merging the bare-address Person into the Person holding the address, with high confidence", async () => {
    const { application, jane } = await setup();
    await application.suggestPersonMerges();
    const [suggestion, ...others] = merges(application);
    expect(others).toEqual([]);
    expect(suggestion!.frontmatter).toMatchObject({ confidence_label: "High", proposed_fields: { keep_person_id: jane.frontmatter.id, merge_person_id: BARE_ID, match: "name-address" } });
  });

  it("keeps the named Person on accept and drops the made-up name instead of keeping it as an Alias", async () => {
    const { application, jane } = await setup();
    await application.suggestPersonMerges();
    const kept = await application.acceptReviewItem(merges(application)[0]!.frontmatter.id);
    expect(kept.frontmatter.id).toBe(jane.frontmatter.id);
    expect(kept.frontmatter.title).toBe("Jane Doe");
    expect(kept.frontmatter.aliases ?? []).toEqual([]);
  });
});
