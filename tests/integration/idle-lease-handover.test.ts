import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, FilesystemSessionStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { countsAsActivity, IdleRelease, idleReleaseMs, registerLease } from "../../apps/server/src/lease.js";

// ADR 0015 (amends ADR 0003): the lease holder releases its lease after N minutes without user activity, then stays
// read-only until the user takes it back. Background work never counts as activity and never writes objects meanwhile.

const minute = 60_000;
const roots: string[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setUp(idleMinutes = 15) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-idle-"));
  roots.push(root);
  const clock = { now: Date.parse("2026-10-07T08:00:00.000Z") };
  const advance = (minutes: number) => { clock.now += minutes * minute; };
  const device = (id: string) => new FilesystemSessionStore(root, id, 5 * minute, () => new Date(clock.now));
  const session = device("desk-mac");
  await session.start();
  const idle = new IdleRelease(session, idleMinutes * minute, () => clock.now);
  const server = Fastify();
  servers.push(server);
  registerLease(server, { session, idle, stopping: () => false });
  // Stand-ins for real routes: an object save (user activity) and two system writes (not activity).
  server.put("/api/v1/objects/:id/body", async () => ({ saved: true }));
  server.post("/api/v1/backups", async () => ({ backupId: "b1" }));
  server.post("/api/v1/calendar/day/sync", async () => ({ events: [] }));
  server.get("/api/v1/health", async () => ({ session: await session.refresh() }));
  const request = (method: "GET" | "POST" | "PUT", url: string) => server.inject({ method, url, ...(method === "GET" ? {} : { payload: {} }) });
  /** The minute-by-minute heartbeat the server runs. */
  const heartbeats = async (minutes: number) => { for (let index = 0; index < minutes; index += 1) { advance(1); await idle.tick(); } };
  const leaseFile = async () => parse((await readFile(path.join(root, ".lifeos", "session.md"), "utf8")).split("---")[1] ?? "") as Record<string, string>;
  return { root, clock, advance, device, session, idle, request, heartbeats, leaseFile };
}

describe("idle release", () => {
  it("GIVEN no user activity WHEN N minutes pass THEN the lease is released and expires now", async () => {
    const { session, heartbeats, leaseFile, clock } = await setUp();
    await heartbeats(14);
    expect(session.holdsLease()).toBe(true);
    await heartbeats(1);
    expect(session.status()).toMatchObject({ writeAllowed: false, releasedAfterIdle: true, activeDeviceId: "desk-mac" });
    expect(session.status().warning).toMatch(/released the lease after a period without activity/);
    expect((await leaseFile()).lease_expires_at).toBe(new Date(clock.now).toISOString());
  });

  it("honours LIFEOS_IDLE_RELEASE_MINUTES and defaults to 15", async () => {
    expect(idleReleaseMs({})).toBe(15 * minute);
    expect(idleReleaseMs({ LIFEOS_IDLE_RELEASE_MINUTES: "30" })).toBe(30 * minute);
    expect(idleReleaseMs({ LIFEOS_IDLE_RELEASE_MINUTES: "nonsense" })).toBe(15 * minute);
    const { session, heartbeats } = await setUp(2);
    await heartbeats(2);
    expect(session.status().releasedAfterIdle).toBe(true);
  });

  it("GIVEN released THEN saves answer 423 and reads still work", async () => {
    const { request, heartbeats } = await setUp();
    await heartbeats(15);
    const save = await request("PUT", "/api/v1/objects/t1/body");
    expect(save.statusCode).toBe(423);
    expect(save.json().error).toMatch(/read-only until you take it back/);
    const health = await request("GET", "/api/v1/health");
    expect(health.statusCode).toBe(200);
    expect(health.json().session).toMatchObject({ writeAllowed: false, releasedAfterIdle: true });
  });

  it("GIVEN released WHEN the user takes it back THEN writes work again and the idle timer restarts", async () => {
    const { request, heartbeats, session } = await setUp();
    await heartbeats(15);
    const takeBack = await request("POST", "/api/v1/session/take-over");
    expect(takeBack.json()).toMatchObject({ writeAllowed: true, releasedAfterIdle: false, activeDeviceId: "desk-mac" });
    expect((await request("PUT", "/api/v1/objects/t1/body")).statusCode).toBe(200);
    await heartbeats(14);
    expect(session.holdsLease()).toBe(true);
  });

  it("GIVEN released THEN nothing reclaims it automatically: not the heartbeat, not browser activity, not the lease expiring", async () => {
    const { request, heartbeats, session, leaseFile } = await setUp();
    await heartbeats(15);
    const released = await leaseFile();
    await heartbeats(180);
    const activity = await request("POST", "/api/v1/session/activity");
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toMatchObject({ writeAllowed: false, releasedAfterIdle: true });
    await session.touch();
    expect(session.holdsLease()).toBe(false);
    expect(await leaseFile()).toEqual(released);
  });
});

describe("what counts as activity", () => {
  it("the browser's activity signal resets the timer", async () => {
    const { request, heartbeats, session } = await setUp();
    await heartbeats(10);
    expect((await request("POST", "/api/v1/session/activity")).json()).toMatchObject({ writeAllowed: true });
    await heartbeats(14);
    expect(session.holdsLease()).toBe(true);
    await heartbeats(1);
    expect(session.status().releasedAfterIdle).toBe(true);
  });

  it("a save resets the timer and records last activity in the lease file", async () => {
    const { request, heartbeats, session, leaseFile, clock } = await setUp();
    await heartbeats(10);
    expect((await request("PUT", "/api/v1/objects/t1/body")).statusCode).toBe(200);
    // onResponse hooks run just after the reply is sent.
    await vi.waitFor(async () => expect((await leaseFile()).last_activity_at).toBe(new Date(clock.now).toISOString()));
    await heartbeats(14);
    expect(session.holdsLease()).toBe(true);
  });

  it("background work does not: heartbeats, backups and calendar sync leave the timer running", async () => {
    const { request, heartbeats, session, leaseFile } = await setUp();
    const started = (await leaseFile()).last_activity_at;
    for (let index = 0; index < 7; index += 1) {
      await heartbeats(2);
      expect((await request("POST", "/api/v1/backups")).statusCode).toBe(200);
      expect((await request("POST", "/api/v1/calendar/day/sync?from=a&to=b")).statusCode).toBe(200);
    }
    expect((await leaseFile()).last_activity_at).toBe(started); // the heartbeat extends the lease, not the activity time
    await heartbeats(1);
    expect(session.status().releasedAfterIdle).toBe(true);
  });

  it("classifies routes", () => {
    expect(countsAsActivity("PUT", "/api/v1/objects/x/body")).toBe(true);
    expect(countsAsActivity("POST", "/api/v1/capture")).toBe(true);
    expect(countsAsActivity("GET", "/api/v1/notes")).toBe(false);
    for (const url of ["/api/v1/backups", "/api/v1/backups/b1/verify", "/api/v1/calendar/day/sync?from=x", "/api/v1/index/rebuild", "/api/v1/settings/connections/retry", "/api/v1/inbox/adopt"]) expect(countsAsActivity("POST", url)).toBe(false);
  });
});

describe("handover between two Macs", () => {
  it("GIVEN the desk Mac released WHEN the laptop is used THEN the laptop gets the lease and the desk sees it as foreign", async () => {
    const { device, heartbeats, session, request } = await setUp();
    const laptop = device("laptop");
    await laptop.start();
    expect(laptop.status().writeAllowed).toBe(false); // the desk Mac holds the lease
    await heartbeats(15);
    // The laptop's own heartbeat never claims a free lease; its user's activity does.
    await laptop.renew();
    expect(laptop.holdsLease()).toBe(false);
    await laptop.touch();
    expect(laptop.holdsLease()).toBe(true);
    const desk = (await request("GET", "/api/v1/health")).json().session;
    expect(desk).toMatchObject({ writeAllowed: false, releasedAfterIdle: true, activeDeviceId: "laptop" });
    expect(desk.warning).toMatch(/Device laptop has an active lease/);
    // Take back is still the existing takeover (the UI shows its caution first).
    expect((await request("POST", "/api/v1/session/take-over")).json()).toMatchObject({ writeAllowed: true, activeDeviceId: "desk-mac" });
    expect(session.holdsLease()).toBe(true);
  });

  it("a clean stop after an idle release leaves the other Mac's lease alone", async () => {
    const { device, heartbeats, session } = await setUp();
    await heartbeats(15);
    const laptop = device("laptop");
    await laptop.start();
    await session.close();
    expect((await laptop.refresh()).writeAllowed).toBe(true);
    expect(laptop.holdsLease()).toBe(true);
  });
});

describe("background writers", () => {
  const draft = "---\nlifeos_draft: 1\nkind: task\ndraft_key: phone-0915\norigin: user-dictated\ntitle: Send Joel the sizing deck\ncaptured_at: 2026-10-07T09:15:00+02:00\n---\nJoel asked for the deck.\n";

  it("GIVEN released THEN automatic adoption writes nothing until the user takes the lease back", async () => {
    const { root, heartbeats, session, request } = await setUp();
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "desk-mac", new FilesystemInboxStore(root));
    await application.rebuildIndex();
    const adoption = application.startAutoAdoption({ canWrite: () => session.holdsLease(), sweepMs: 3_600_000 });
    try {
      await heartbeats(15);
      const target = path.join(root, "_inbox", "drafts", "task.md");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, draft);
      const past = new Date(Date.now() - minute);
      await utimes(target, past, past);
      expect(await adoption.runNow()).toBeUndefined();
      expect(await readdir(path.dirname(target))).toEqual(["task.md"]);
      expect((await application.listObjects()).filter((object) => object.frontmatter.type === "task")).toHaveLength(0);

      await request("POST", "/api/v1/session/take-over");
      const batch = await adoption.runNow();
      expect(batch?.drafts.map((entry) => entry.outcome)).toEqual(["adopted"]);
    } finally {
      await adoption.stop();
    }
  });

  it("the server wires every background object writer to holding the lease, and the heartbeat to the idle check", async () => {
    const source = await readFile(path.join(process.cwd(), "apps/server/src/main.ts"), "utf8"); // vitest runs from the repository root
    expect(source).toMatch(/startAutoAdoption\(\{ canWrite: \(\) => session\.holdsLease\(\)/);
    expect(source).toMatch(/const reconcile = \(\) => session\.holdsLease\(\) \? application\.recordExternalChanges\(\)/);
    expect(source).toMatch(/setInterval\(\(\) => void idle\.tick\(\)/);
    expect(source).not.toMatch(/setInterval\(\(\) => void session\.touch\(\)/);
    expect(source).not.toMatch(/status\(\)\.writeAllowed\) await application\./);
  });
});
