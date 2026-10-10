/**
 * The advisory device lease over HTTP (ADR 0003) and its idle auto-handover (ADR 0015).
 *
 * What counts as user activity (resets the idle timer):
 *  - `POST /api/v1/session/activity`, which the browser sends only from a visible, focused tab after a real key
 *    press, click, scroll or pointer move (at most once a minute);
 *  - any successful write request, except the system ones in `notActivity` (backups, calendar sync, index rebuild,
 *    connection retry, adopt now): those can run without the user being at this Mac;
 *  - the explicit takeover ("Take over" / "Take back").
 * What never counts: the lease heartbeat timer, automatic adoption, automatic backups, the file watcher, and reads.
 */
import type { FastifyInstance } from "fastify";
import { route } from "./route.js";
import type { SessionStatus } from "@lifeos/object-store-markdown";

export interface LeaseSession {
  refresh(): Promise<SessionStatus>;
  touch(): Promise<SessionStatus>;
  renew(): Promise<SessionStatus>;
  release(): Promise<SessionStatus>;
  takeOver(): Promise<SessionStatus>;
  status(): SessionStatus;
  holdsLease(): boolean;
}

export const defaultIdleReleaseMinutes = 15;

/** Minutes from LIFEOS_IDLE_RELEASE_MINUTES (a positive number), else 15. */
export function idleReleaseMs(env: NodeJS.ProcessEnv = process.env) {
  const minutes = Number(env.LIFEOS_IDLE_RELEASE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : defaultIdleReleaseMinutes) * 60_000;
}

/** Tracks the last user activity and releases the lease once it is `idleMs` old. */
export class IdleRelease {
  private lastActivity: number;

  constructor(private readonly session: LeaseSession, readonly idleMs: number, private readonly now: () => number = Date.now) {
    this.lastActivity = now();
  }

  activity() { this.lastActivity = this.now(); }

  /** The heartbeat (every minute): releases the lease when idle, otherwise extends it. Never claims a lease. */
  async tick() {
    await this.session.refresh();
    if (this.session.holdsLease() && this.now() - this.lastActivity >= this.idleMs) return this.session.release();
    return this.session.renew();
  }
}

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Writes allowed without the lease: they change no objects. */
const allowedWithoutLease = new Set(["/api/v1/session/take-over", "/api/v1/session/activity", "/api/v1/index/rebuild", "/api/v1/settings/connections/retry"]);
/** These routes update the lease themselves. */
const sessionRoutes = new Set(["/api/v1/session/take-over", "/api/v1/session/activity"]);
/** Writes that do not prove someone is at this Mac. */
const notActivity = [/^\/api\/v1\/backups(\/|$)/, /^\/api\/v1\/calendar\/day\/sync/, /^\/api\/v1\/index\/rebuild$/, /^\/api\/v1\/settings\/connections\/retry$/, /^\/api\/v1\/inbox\/adopt$/];

export function countsAsActivity(method: string, url: string) {
  const route = url.split("?")[0] ?? url;
  return writeMethods.has(method) && !notActivity.some((pattern) => pattern.test(route));
}

/** Read-only enforcement (423), the takeover and activity routes, and activity tracking for writes. */
export function registerLease(server: FastifyInstance, options: { session: LeaseSession; idle: IdleRelease; stopping: () => boolean }) {
  const { session, idle, stopping } = options;

  server.addHook("preHandler", async (request, reply) => {
    if (!writeMethods.has(request.method)) return;
    if (stopping()) return reply.status(503).send({ error: "LifeOS is stopping; your change was not saved" });
    const route = request.url.split("?")[0] ?? request.url;
    if (!allowedWithoutLease.has(route) && !(await session.refresh()).writeAllowed) {
      return reply.status(423).send({ error: session.status().warning ?? "LifeOS is read-only because another device lease is active" });
    }
  });

  server.addHook("onResponse", async (request, reply) => {
    const route = request.url.split("?")[0] ?? request.url;
    if (!writeMethods.has(request.method) || reply.statusCode >= 400 || sessionRoutes.has(route)) return;
    if (!countsAsActivity(request.method, request.url)) { await session.renew(); return; }
    idle.activity();
    if (session.status().writeAllowed) await session.touch();
  });

  route(server, "POST /api/v1/session/take-over", async () => {
    idle.activity();
    return session.takeOver();
  });

  // The browser's "someone is here" signal. It never takes back a released lease: only Take back does.
  route(server, "POST /api/v1/session/activity", async () => {
    idle.activity();
    return session.touch();
  });
}
