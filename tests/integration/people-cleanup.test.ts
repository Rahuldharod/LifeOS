import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type CalendarAttendee, type CalendarConnector, type CalendarEvent } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #215: `pnpm people-cleanup` finds the same likely duplicates the live sweep finds. Dry run writes nothing; --apply proposes, never merges.

const roots: string[] = [];
// Backups are read-only snapshots, so make them writable before removing them.
async function makeWritable(target: string) {
  await chmod(target, 0o755).catch(() => undefined);
  for (const entry of await readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeWritable(path.join(target, entry.name));
    else await chmod(path.join(target, entry.name), 0o644).catch(() => undefined);
  }
}
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => { await makeWritable(root); await rm(root, { recursive: true, force: true }); })));

class FakeCalendar implements CalendarConnector {
  readonly provider = "fake";
  events: CalendarEvent[] = [];
  async listEvents() { return this.events; }
}

function event(externalId: string, attendeeDetails: CalendarAttendee[]): CalendarEvent {
  const startsAt = new Date(Date.now() + 3_600_000).toISOString();
  return { externalId, title: `Meeting ${externalId}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 1_800_000).toISOString(), timezone: "Europe/Paris", attendees: attendeeDetails.map((attendee) => attendee.displayName ?? attendee.email ?? ""), attendeeDetails };
}

async function tempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A synthetic data root with two likely pairs that no sweep has proposed yet (calendar people are not swept on creation). */
async function legacyRoot() {
  const root = await tempDir("lifeos-people-cleanup-");
  await mkdir(path.join(root, ".lifeos"), { recursive: true });
  await writeFile(path.join(root, ".lifeos", "schema.md"), "# LifeOS data root\n");
  const calendar = new FakeCalendar();
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), calendar, undefined, "test");
  await application.rebuildIndex();
  calendar.events = [
    event("e1", [{ displayName: "John Doe" }, { email: "john.doe@example.com", displayName: "JD" }]),
    event("e2", [{ displayName: "Ana Silva" }, { email: "ana.silva@example.org", displayName: "AS" }])
  ];
  await application.createMeetingFromEvent("e1");
  await application.createMeetingFromEvent("e2");
  return { root, application };
}

const run = (dataRoot: string | undefined, args: string[], backupRoot: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, LIFEOS_BACKUP_ROOT: backupRoot, LIFEOS_PORT: "0", LIFEOS_DEVICE_ID: "cleanup-test" };
  delete env.LIFEOS_DATA_ROOT;
  if (dataRoot) env.LIFEOS_DATA_ROOT = dataRoot;
  // vitest runs from the repository root
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/people-cleanup.mts", ...args], { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 });
};

async function snapshot(root: string) {
  const hashes: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else hashes[path.relative(root, full)] = createHash("sha256").update(await readFile(full)).digest("hex");
    }
  };
  await walk(root);
  return hashes;
}

async function openApplication(root: string) {
  const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "test");
  await application.rebuildIndex();
  return application;
}
const mergeReviews = (application: LifeOSApplication) => application.reviews().filter((review) => review.frontmatter.review_type === "person-merge");
const livePeople = async (application: LifeOSApplication) => (await application.listObjects()).filter((object) => object.frontmatter.type === "person" && !object.frontmatter.deleted_at);

describe("people-cleanup (#215)", () => {
  it("GIVEN likely duplicates WHEN run as a dry run THEN it lists each pair with its reason and changes no file", async () => {
    const { root } = await legacyRoot();
    const before = await snapshot(root);
    const result = run(root, [], await tempDir("lifeos-backup-"));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/JD.*John Doe|John Doe.*JD/);
    expect(result.stdout).toMatch(/Ana Silva.*AS|AS.*Ana Silva/);
    expect(result.stdout).toContain("name-email");
    expect(result.stdout).toContain("Dry run: nothing was changed");
    expect(await snapshot(root)).toEqual(before);
  }, 90_000);

  it("GIVEN likely duplicates WHEN run with --apply THEN it proposes one merge per pair, merges nobody, and a second run adds none", async () => {
    const { root } = await legacyRoot();
    const backups = await tempDir("lifeos-backup-");
    const peopleBefore = (await livePeople(await openApplication(root))).length;

    const first = run(root, ["--apply"], backups);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Proposed 2 merge suggestion(s)");
    const afterFirst = await openApplication(root);
    expect(mergeReviews(afterFirst)).toHaveLength(2);
    expect(await livePeople(afterFirst)).toHaveLength(peopleBefore);

    const second = run(root, ["--apply"], backups);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("No likely duplicate people");
    expect(mergeReviews(await openApplication(root))).toHaveLength(2);
  }, 120_000);

  it("GIVEN a suggestion the user rejected WHEN run again THEN that pair is not proposed again", async () => {
    const { root } = await legacyRoot();
    const backups = await tempDir("lifeos-backup-");
    expect(run(root, ["--apply"], backups).status).toBe(0);
    const application = await openApplication(root);
    await application.rejectReviewItem(mergeReviews(application)[0]!.frontmatter.id);

    const dry = run(root, [], backups);
    expect(dry.stdout).toContain("No likely duplicate people");
    expect(mergeReviews(await openApplication(root))).toHaveLength(2);
  }, 120_000);

  it("GIVEN no valid data root WHEN it runs THEN it exits non-zero and writes nothing", async () => {
    const empty = await tempDir("lifeos-people-cleanup-empty-");
    const result = run(empty, ["--apply"], await tempDir("lifeos-backup-"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(empty, ".lifeos", "schema.md"));
    expect(await readdir(empty)).toEqual([]);
    expect(run(undefined, [], await tempDir("lifeos-backup-")).status).toBe(1);
  }, 90_000);
});
