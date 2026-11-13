import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { LifeOSApplication } from "@lifeos/application";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, FilesystemSessionStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { countsAsActivity, registerLease } from "../../apps/server/src/lease.js";

// ADR 0024 (replaces ADR 0015): the Mac holding the lease keeps it for as long as LifeOS runs there, however long it is
// left alone. Only the other Mac's "Use LifeOS here" (the takeover) moves it. A lease still expires 15 minutes after its
// holder stops renewing (asleep, crashed), and then the other Mac claims it on its user's first activity.

const minute = 60_000;
const roots: string[] = [];
const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setUp(leaseMinutes = 15) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-lease-"));
  roots.push(root);
  const clock = { now: Date.parse("2026-11-13T08:00:00.000Z") };
  const advance = (minutes: number) => { clock.now += minutes * minute; };
  const device = (id: string) => new FilesystemSessionStore(root, id, leaseMinutes * minute, () => new Date(clock.now));
  const session = device("desk-mac");
  await session.start();
  const server = Fastify();
  servers.push(server);
  registerLease(server, { session, stopping: () => false });
  // Stand-ins for real routes: an object save (user activity) and two system writes (not activity).
  server.put("/api/v1/objects/:id/body", async () => ({ saved: true }));
  server.post("/api/v1/backups", async () => ({ backupId: "b1" }));
  server.post("/api/v1/calendar/day/sync", async () => ({ events: [] }));
  server.get("/api/v1/health", async () => ({ session: await session.refresh() }));
  const request = (method: "GET" | "POST" | "PUT", url: string) => server.inject({ method, url, ...(method === "GET" ? {} : { payload: {} }) });
  /** The minute-by-minute heartbeat the server runs. */
  const heartbeats = async (minutes: number) => { for (let index = 0; index < minutes; index += 1) { advance(1); await session.renew(); } };
  const leaseFilePath = path.join(root, ".lifeos", "session.md");
  const leaseFile = async () => parse((await readFile(leaseFilePath, "utf8")).split("---")[1] ?? "") as Record<string, string>;
  return { root, clock, advance, device, session, request, heartbeats, leaseFile, leaseFilePath };
}

describe("the holder keeps the lease", () => {
  it("GIVEN no user activity WHEN hours pass THEN this Mac still holds the lease and saves work", async () => {
    const { session, heartbeats, request, leaseFile, clock } = await setUp();
    await heartbeats(8 * 60);
    expect(session.holdsLease()).toBe(true);
    expect(session.status()).toMatchObject({ writeAllowed: true, activeDeviceId: "desk-mac" });
    expect(Date.parse((await leaseFile()).lease_expires_at!)).toBeGreaterThan(clock.now);
    expect((await request("PUT", "/api/v1/objects/t1/body")).statusCode).toBe(200);
  });

  it("GIVEN this Mac was asleep and nobody else claimed the lease WHEN it wakes THEN it can write again without a click", async () => {
    const { session, advance, request } = await setUp();
    advance(12 * 60);
    expect((await request("PUT", "/api/v1/objects/t1/body")).statusCode).toBe(200);
    expect(session.holdsLease()).toBe(true);
  });
});

describe("handover between two Macs", () => {
  it("GIVEN the desk Mac holds a live lease THEN the laptop is read-only and its activity never takes it", async () => {
    const { device, heartbeats } = await setUp();
    const laptop = device("laptop");
    expect((await laptop.start())).toMatchObject({ writeAllowed: false, activeDeviceId: "desk-mac" });
    await heartbeats(60);
    await laptop.touch();
    await laptop.renew();
    expect(laptop.holdsLease()).toBe(false);
    expect(laptop.status().warning).toMatch(/Device desk-mac has an active lease/);
  });

  it("GIVEN the laptop clicks Use LifeOS here THEN it holds the lease and the desk Mac turns read-only and stays so", async () => {
    const { device, heartbeats, session, request, leaseFile } = await setUp();
    const laptop = device("laptop");
    await laptop.start();
    expect(await laptop.takeOver()).toMatchObject({ writeAllowed: true, activeDeviceId: "laptop" });
    const health = (await request("GET", "/api/v1/health")).json().session;
    expect(health).toMatchObject({ writeAllowed: false, activeDeviceId: "laptop" });
    const save = await request("PUT", "/api/v1/objects/t1/body");
    expect(save.statusCode).toBe(423);
    expect(save.json().error).toMatch(/Device laptop has an active lease/);
    // The desk's heartbeat and its user's activity never take a live lease back.
    const laptopLease = await leaseFile();
    for (let index = 0; index < 4; index += 1) { await heartbeats(1); await laptop.renew(); }
    expect((await request("POST", "/api/v1/session/activity")).json()).toMatchObject({ writeAllowed: false });
    expect(session.holdsLease()).toBe(false);
    expect((await leaseFile()).device_id).toBe("laptop");
    expect((await leaseFile()).started_at).toBe(laptopLease.started_at);
  });

  it("GIVEN the laptop holds the lease WHEN the desk clicks Use LifeOS here THEN the desk holds it and the laptop turns read-only", async () => {
    const { device, session, request } = await setUp();
    const laptop = device("laptop");
    await laptop.start();
    await laptop.takeOver();
    expect((await request("POST", "/api/v1/session/take-over")).json()).toMatchObject({ writeAllowed: true, activeDeviceId: "desk-mac" });
    expect(session.holdsLease()).toBe(true);
    expect(await laptop.refresh()).toMatchObject({ writeAllowed: false, activeDeviceId: "desk-mac" });
  });

  it("GIVEN the laptop holds the lease and goes to sleep WHEN 15 minutes pass THEN the desk's next activity claims it, and the laptop wakes read-only", async () => {
    const { device, advance, session, request } = await setUp();
    const laptop = device("laptop");
    await laptop.start();
    await laptop.takeOver();
    advance(14);
    expect((await request("POST", "/api/v1/session/activity")).json()).toMatchObject({ writeAllowed: false });
    advance(2);
    expect((await request("POST", "/api/v1/session/activity")).json()).toMatchObject({ writeAllowed: true, activeDeviceId: "desk-mac" });
    expect(session.holdsLease()).toBe(true);
    expect(await laptop.refresh()).toMatchObject({ writeAllowed: false, activeDeviceId: "desk-mac" });
    expect(laptop.holdsLease()).toBe(false);
  });

  it("GIVEN the desk's renewal reaches Drive after the laptop's takeover THEN the newer claim (the laptop's) stands", async () => {
    const { device, advance, session, leaseFile, leaseFilePath } = await setUp();
    const deskLease = await leaseFile();
    advance(1);
    const laptop = device("laptop");
    await laptop.start();
    await laptop.takeOver();
    // Drive delivers the desk's late renewal (made before it saw the takeover) on top of the laptop's claim.
    const lateRenewal = { ...deskLease, lease_expires_at: new Date(Date.parse(deskLease.started_at!) + 16 * minute).toISOString() };
    await writeFile(leaseFilePath, `---\n${stringify(lateRenewal).trimEnd()}\n---\n`);
    expect(await laptop.refresh()).toMatchObject({ writeAllowed: true, activeDeviceId: "laptop" });
    expect((await leaseFile()).device_id).toBe("laptop");
    expect(await session.refresh()).toMatchObject({ writeAllowed: false, activeDeviceId: "laptop" });
  });

  it("a clean stop after a takeover leaves the other Mac's lease alone", async () => {
    const { device, session } = await setUp();
    const laptop = device("laptop");
    await laptop.start();
    await laptop.takeOver();
    await session.refresh();
    await session.close();
    expect((await laptop.refresh()).writeAllowed).toBe(true);
    expect(laptop.holdsLease()).toBe(true);
  });

  it("remembers whether this Mac held the lease during this run (backups keep running after a takeover)", async () => {
    const { device, session } = await setUp();
    const laptop = device("laptop");
    await laptop.start();
    expect(laptop.hasHeldLease()).toBe(false);
    await laptop.takeOver();
    await session.refresh();
    expect(session.holdsLease()).toBe(false);
    expect(session.hasHeldLease()).toBe(true);
  });
});

describe("what counts as activity", () => {
  it("a save records last activity in the lease file", async () => {
    const { request, heartbeats, leaseFile, clock } = await setUp();
    await heartbeats(10);
    expect((await request("PUT", "/api/v1/objects/t1/body")).statusCode).toBe(200);
    // onResponse hooks run just after the reply is sent.
    await vi.waitFor(async () => expect((await leaseFile()).last_activity_at).toBe(new Date(clock.now).toISOString()));
  });

  it("background work does not: heartbeats, backups and calendar sync leave last activity alone", async () => {
    const { request, heartbeats, session, leaseFile } = await setUp();
    const started = (await leaseFile()).last_activity_at;
    for (let index = 0; index < 7; index += 1) {
      await heartbeats(2);
      expect((await request("POST", "/api/v1/backups")).statusCode).toBe(200);
      expect((await request("POST", "/api/v1/calendar/day/sync?from=a&to=b")).statusCode).toBe(200);
    }
    expect((await leaseFile()).last_activity_at).toBe(started); // the heartbeat extends the lease, not the activity time
    expect(session.holdsLease()).toBe(true);
  });

  it("classifies routes", () => {
    expect(countsAsActivity("PUT", "/api/v1/objects/x/body")).toBe(true);
    expect(countsAsActivity("POST", "/api/v1/capture")).toBe(true);
    expect(countsAsActivity("GET", "/api/v1/notes")).toBe(false);
    for (const url of ["/api/v1/backups", "/api/v1/backups/b1/verify", "/api/v1/calendar/day/sync?from=x", "/api/v1/index/rebuild", "/api/v1/settings/connections/retry", "/api/v1/inbox/adopt"]) expect(countsAsActivity("POST", url)).toBe(false);
  });
});

describe("few lease-file writes (the lease file syncs through Google Drive)", () => {
  /** Counts how many times the lease file's content changes while `run` executes, sampling after every step. */
  const countWrites = async (leaseFile: () => Promise<Record<string, string>>, steps: Array<() => Promise<unknown>>) => {
    let last = JSON.stringify(await leaseFile());
    let writes = 0;
    for (const step of steps) {
      await step();
      const now = JSON.stringify(await leaseFile());
      if (now !== last) writes += 1;
      last = now;
    }
    return writes;
  };

  it("defaults to a 15-minute lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-lease-"));
    roots.push(root);
    const now = new Date("2026-11-13T08:00:00.000Z");
    const session = new FilesystemSessionStore(root, "desk-mac", undefined, () => now);
    await session.start();
    expect(session.status().leaseExpiresAt).toBe(new Date(now.getTime() + 15 * minute).toISOString());
  });

  it("GIVEN a 15-minute lease WHEN the minute heartbeat runs for 15 minutes THEN the file is rewritten only every 5 minutes, and the lease never lapses", async () => {
    const { session, leaseFile, advance, clock } = await setUp();
    const writes = await countWrites(leaseFile, Array.from({ length: 15 }, () => async () => {
      advance(1);
      await session.renew();
      expect(Date.parse((await leaseFile()).lease_expires_at!)).toBeGreaterThan(clock.now + 9 * minute);
    }));
    expect(writes).toBe(3);
    expect(session.holdsLease()).toBe(true);
  });

  it("GIVEN a 15-minute lease WHEN the user is active every minute THEN activity is recorded at most every 5 minutes", async () => {
    const { request, leaseFile, advance, session, clock } = await setUp();
    const writes = await countWrites(leaseFile, Array.from({ length: 15 }, () => async () => {
      advance(1);
      await session.renew();
      await request("POST", "/api/v1/session/activity");
    }));
    expect(writes).toBe(3);
    expect(clock.now - Date.parse((await leaseFile()).last_activity_at!)).toBeLessThan(5 * minute);
  });

  it("GIVEN the lease expired WHEN the user is active THEN it is claimed at once, however recent the last write", async () => {
    const { session, leaseFile, advance, request, clock } = await setUp();
    advance(16);
    expect((await request("POST", "/api/v1/session/activity")).json()).toMatchObject({ writeAllowed: true });
    expect(session.holdsLease()).toBe(true);
    expect((await leaseFile()).lease_expires_at).toBe(new Date(clock.now + 15 * minute).toISOString());
  });

  it("GIVEN the old holder keeps renewing over a slow sync THEN the newer holder rewrites its claim at most once a minute", async () => {
    const { device, leaseFile, leaseFilePath, advance } = await setUp();
    const deskLease = await leaseFile();
    advance(1);
    const laptop = device("laptop");
    await laptop.start();
    await laptop.takeOver();
    const late = `---\n${stringify({ ...deskLease, lease_expires_at: new Date(Date.parse(deskLease.started_at!) + 20 * minute).toISOString() }).trimEnd()}\n---\n`;
    await writeFile(leaseFilePath, late);
    await laptop.refresh();
    expect((await leaseFile()).device_id).toBe("laptop");
    await writeFile(leaseFilePath, late);
    await laptop.refresh(); // within the minute: still allowed to write, but no second rewrite
    expect(laptop.status().writeAllowed).toBe(true);
    expect((await leaseFile()).device_id).toBe("desk-mac");
    advance(1);
    await laptop.refresh();
    expect((await leaseFile()).device_id).toBe("laptop");
  });
});

describe("background writers", () => {
  const draft = "---\nlifeos_draft: 1\nkind: task\ndraft_key: phone-0915\norigin: user-dictated\ntitle: Send Joel the sizing deck\ncaptured_at: 2026-10-07T09:15:00+02:00\n---\nJoel asked for the deck.\n";

  it("GIVEN the laptop took over THEN the desk's automatic adoption writes nothing until the desk uses LifeOS here again", async () => {
    const { root, device, session, request } = await setUp();
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), undefined, undefined, "desk-mac", new FilesystemInboxStore(root));
    await application.rebuildIndex();
    const adoption = application.startAutoAdoption({ canWrite: () => session.holdsLease(), sweepMs: 3_600_000 });
    try {
      const laptop = device("laptop");
      await laptop.start();
      await laptop.takeOver();
      await session.refresh();
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
  // The server's own wiring (adoption, external-edit audits and the heartbeat, through the real API) is tested in server-api.test.ts (#120).
});
