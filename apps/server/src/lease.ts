/**
 * The advisory device lease over HTTP (ADR 0003, ADR 0024). The Mac holding the lease keeps it for as long as LifeOS
 * runs there; only the other Mac's explicit takeover ("Use LifeOS here") moves it. A lease still expires 15 minutes after
 * its holder stops renewing (asleep, crashed), and then the other Mac claims it on its user's first activity.
 *
 * What counts as user activity (claims a free lease, or extends our own and records `last_activity_at`):
 *  - `POST /api/v1/session/activity`, which the browser sends only from a visible, focused tab after a real key
 *    press, click, scroll or pointer move (at most once a minute);
 *  - any successful write request, except the system ones in `notActivity` (backups, calendar sync, index rebuild,
 *    connection retry, adopt now): those can run without the user being at this Mac;
 *  - the explicit takeover.
 * The heartbeat only extends a lease this Mac already holds; it never claims one.
 */
import type { FastifyInstance } from "fastify";
import { route } from "./route.js";
import type { SessionStatus } from "@lifeos/object-store-markdown";

export interface LeaseSession {
  refresh(): Promise<SessionStatus>;
  touch(): Promise<SessionStatus>;
  renew(): Promise<SessionStatus>;
  takeOver(): Promise<SessionStatus>;
  status(): SessionStatus;
  holdsLease(): boolean;
}

const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Writes allowed without the lease: they change no objects. */
const allowedWithoutLease = new Set(["/api/v1/session/take-over", "/api/v1/session/activity", "/api/v1/index/rebuild", "/api/v1/settings/connections/retry", "/api/v1/feedback"]);
/** These routes update the lease themselves. */
const sessionRoutes = new Set(["/api/v1/session/take-over", "/api/v1/session/activity"]);
/** Writes that do not prove someone is at this Mac. */
const notActivity = [/^\/api\/v1\/backups(\/|$)/, /^\/api\/v1\/calendar\/day\/sync/, /^\/api\/v1\/index\/rebuild$/, /^\/api\/v1\/settings\/connections\/retry$/, /^\/api\/v1\/inbox\/adopt$/, /^\/api\/v1\/feedback$/];

export function countsAsActivity(method: string, url: string) {
  const route = url.split("?")[0] ?? url;
  return writeMethods.has(method) && !notActivity.some((pattern) => pattern.test(route));
}

/** Read-only enforcement (423), the takeover and activity routes, and lease renewal after writes. */
export function registerLease(server: FastifyInstance, options: { session: LeaseSession; stopping: () => boolean }) {
  const { session, stopping } = options;

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
    if (session.status().writeAllowed) await session.touch();
  });

  route(server, "POST /api/v1/session/take-over", async () => session.takeOver());

  // The browser's "someone is here" signal: claims a free (expired) lease, never a live one held by the other Mac.
  route(server, "POST /api/v1/session/activity", async () => session.touch());
}
