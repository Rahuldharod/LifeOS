import path from "node:path";
import os from "node:os";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication } from "@lifeos/application";
import { FilesystemAssetStore } from "@lifeos/assets-filesystem";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";
import { GoogleCalendarConnector, MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemSessionStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { MacOSKeychainSecretStore } from "@lifeos/secrets";

const host = process.env.LIFEOS_HOST ?? "127.0.0.1";
const port = Number(process.env.LIFEOS_PORT ?? 4310);
const deviceId = process.env.LIFEOS_DEVICE_ID ?? os.hostname();
const defaultDataRoot = fileURLToPath(new URL("../../../../data/", import.meta.url));
const defaultBackupRoot = fileURLToPath(new URL("../../../../backups/", import.meta.url));
const dataRoot = process.env.LIFEOS_DATA_ROOT ? path.resolve(process.cwd(), process.env.LIFEOS_DATA_ROOT) : defaultDataRoot;
const backupRoot = process.env.LIFEOS_BACKUP_ROOT ? path.resolve(process.cwd(), process.env.LIFEOS_BACKUP_ROOT) : defaultBackupRoot;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI ?? `http://${host}:${port}/api/v1/connections/google/callback`;

const store = new MarkdownObjectStore(dataRoot);
const session = new FilesystemSessionStore(dataRoot, deviceId);
const backups = new FilesystemBackupService(dataRoot, backupRoot);
const assets = new FilesystemAssetStore(dataRoot);
const index = new MemoryIndex();
const secrets = new MacOSKeychainSecretStore();
if (process.env.GOOGLE_CLIENT_SECRET) await secrets.set("google:default:client-secret", process.env.GOOGLE_CLIENT_SECRET);
if (process.env.GOOGLE_CLIENT_ID) await secrets.set("google:default:client-id", process.env.GOOGLE_CLIENT_ID);
const savedGoogleClientId = await secrets.get("google:default:client-id");
let google = savedGoogleClientId ? new GoogleCalendarConnector({ clientId: savedGoogleClientId, redirectUri: googleRedirectUri, secrets }) : undefined;
const mockCalendar = new MockCalendarConnector();
const calendar = { get provider() { return (google ?? mockCalendar).provider; }, listEvents: (from: Date, to: Date) => (google ?? mockCalendar).listEvents(from, to) };
const application = new LifeOSApplication(store, index, calendar, new MockAiProvider(), deviceId);
const server = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });

await server.register(cors, { origin: ["http://127.0.0.1:5173", "http://localhost:5173"] });

server.addHook("preHandler", async (request, reply) => {
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  const allowedWithoutLease = request.url === "/api/v1/session/take-over" || request.url === "/api/v1/index/rebuild";
  if (mutating && !allowedWithoutLease && !(await session.refresh()).writeAllowed) {
    return reply.status(423).send({ error: session.status().warning ?? "LifeOS is read-only because another device lease is active" });
  }
});

server.addHook("onResponse", async (request, reply) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && reply.statusCode < 400 && session.status().writeAllowed) await session.touch();
});

server.get("/api/v1/health", async () => ({ ...await application.health(), session: await session.refresh() }));
server.post("/api/v1/session/take-over", async () => session.takeOver());
server.get("/api/v1/objects", async () => application.listObjects());
server.get("/api/v1/notes", async () => application.notes());
server.get<{ Params: { type: "task" | "project" | "client" | "product" | "person" } }>("/api/v1/entities/:type", async (request) => application.entities(request.params.type));
server.post<{ Params: { type: "task" | "project" | "client" | "product" | "person" }; Body: { fields: Record<string, unknown> } }>("/api/v1/entities/:type", async (request) => application.createEntity(request.params.type, request.body.fields));
server.patch<{ Params: { id: string }; Body: { fields: Record<string, unknown>; expectedHash: string } }>("/api/v1/entities/by-id/:id", async (request) => application.updateEntity(request.params.id, request.body.fields, request.body.expectedHash));
server.delete<{ Params: { id: string }; Body: { expectedHash: string } }>("/api/v1/entities/by-id/:id", async (request) => application.deleteEntity(request.params.id, request.body.expectedHash));
server.post("/api/v1/index/rebuild", async () => application.rebuildIndex());
server.get<{ Querystring: { from?: string; to?: string } }>("/api/v1/calendar/events", async (request, reply) => {
  const from = request.query.from ? new Date(request.query.from) : undefined;
  const to = request.query.to ? new Date(request.query.to) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) return reply.status(400).send({ error: "Enter a valid calendar date range" });
  return application.listCalendarEvents(from, to);
});
server.post<{ Querystring: { from?: string; to?: string } }>("/api/v1/calendar/sync", async (request, reply) => {
  const from = request.query.from ? new Date(request.query.from) : undefined;
  const to = request.query.to ? new Date(request.query.to) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) return reply.status(400).send({ error: "Enter a valid calendar date range" });
  return application.syncCalendar(from, to);
});
server.get("/api/v1/connections/google", async () => google ? google.status() : ({ configured: false, connected: false, provider: "mock", missing: ["Google OAuth Desktop client credentials"] }));
server.get("/api/v1/settings/connections", async () => ({
  calendar: { configured: Boolean(await secrets.get("google:default:client-id")) && Boolean(await secrets.get("google:default:client-secret")), connected: google ? (await google.status()).connected : false },
  drive: { configured: Boolean(await secrets.get("google-drive:default:client-id")) && Boolean(await secrets.get("google-drive:default:client-secret")), connected: false }
}));
server.post<{ Params: { provider: "calendar" | "drive" }; Body: { clientId: string; clientSecret: string } }>("/api/v1/settings/connections/google/:provider", async (request, reply) => {
  const clientId = request.body.clientId.trim();
  const clientSecret = request.body.clientSecret.trim();
  if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) return reply.status(400).send({ error: "Enter a valid Google OAuth client ID and client secret" });
  const prefix = request.params.provider === "calendar" ? "google:default" : "google-drive:default";
  await Promise.all([secrets.set(`${prefix}:client-id`, clientId), secrets.set(`${prefix}:client-secret`, clientSecret)]);
  if (request.params.provider === "calendar") google = new GoogleCalendarConnector({ clientId, redirectUri: googleRedirectUri, secrets });
  return { configured: true, connected: false };
});
server.post<{ Body: { clientId: string; clientSecret: string } }>("/api/v1/connections/google/configure", async (request, reply) => {
  const clientId = request.body.clientId.trim();
  const clientSecret = request.body.clientSecret.trim();
  if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) return reply.status(400).send({ error: "Enter a valid Google OAuth Desktop client ID and client secret" });
  await Promise.all([secrets.set("google:default:client-id", clientId), secrets.set("google:default:client-secret", clientSecret)]);
  google = new GoogleCalendarConnector({ clientId, redirectUri: googleRedirectUri, secrets });
  return google.status();
});
server.get("/api/v1/connections/google/start", async (_request, reply) => {
  if (!google) return reply.status(400).send({ error: "Configure the Google OAuth Desktop client before connecting Google Calendar" });
  return { authorizationUrl: await google.authorizationUrl() };
});
server.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/v1/connections/google/callback", async (request, reply) => {
  if (!google) return reply.status(400).type("text/html").send("<h1>Google Calendar is not configured</h1>");
  if (request.query.error) return reply.status(400).type("text/html").send(`<h1>Connection declined</h1><p>${request.query.error}</p>`);
  if (!request.query.code || !request.query.state) return reply.status(400).type("text/html").send("<h1>Invalid OAuth callback</h1>");
  await google.completeAuthorization(request.query.code, request.query.state);
  await application.recordGoogleConnection();
  return reply.type("text/html").send('<!doctype html><meta charset="utf-8"><title>LifeOS connected</title><style>body{font-family:system-ui;max-width:560px;margin:80px auto;color:#173f32}a{color:#173f32}</style><h1>Google Calendar connected</h1><p>Your tokens are stored in macOS Keychain. You can return to LifeOS.</p><a href="http://127.0.0.1:5173/">Return to LifeOS</a>');
});
server.post<{ Body: { externalId: string; calendarId?: string; from?: string; to?: string } }>("/api/v1/meetings/from-event", async (request, reply) => {
  const from = request.body.from ? new Date(request.body.from) : undefined;
  const to = request.body.to ? new Date(request.body.to) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) return reply.status(400).send({ error: "Enter a valid calendar date range" });
  return application.createMeetingFromEvent(request.body.externalId, from, to, request.body.calendarId);
});
server.get<{ Params: { externalId: string } }>("/api/v1/meetings/from-event/:externalId", async (request) => application.meetingFromEvent(request.params.externalId));
server.get<{ Params: { id: string } }>("/api/v1/meetings/:id/workspace", async (request) => application.meetingWorkspace(request.params.id));
server.put<{ Params: { id: string }; Body: { body: string; expectedHash: string } }>("/api/v1/objects/:id/body", async (request) => application.updateBody(request.params.id, request.body.body, request.body.expectedHash));
server.post<{ Params: { id: string }; Body: { fileName: string; mimeType: string; contentBase64: string } }>("/api/v1/objects/:id/assets", async (request) => {
  const object = application.object(request.params.id);
  const encoded = request.body.contentBase64.replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid base64 image data");
  const content = Buffer.from(encoded, "base64");
  if (content.byteLength > 10 * 1024 * 1024) throw new Error("Images must be 10 MB or smaller");
  return assets.put({ ownerRelativePath: object.relativePath, fileName: request.body.fileName, mimeType: request.body.mimeType, content });
});
server.get<{ Params: { "*": string } }>("/api/v1/assets/*", async (request, reply) => {
  const relativePath = decodeURIComponent(request.params["*"]);
  const extension = path.extname(relativePath).toLowerCase();
  const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  const mimeType = mimeTypes[extension];
  if (!mimeType) return reply.status(404).send({ error: "Unsupported asset" });
  return reply.type(mimeType).send(await assets.read(relativePath));
});
server.post<{ Params: { id: string }; Body: { expectedHash: string } }>("/api/v1/objects/:id/archive", async (request) => application.archiveObject(request.params.id, request.body.expectedHash));
server.post<{ Params: { id: string } }>("/api/v1/meetings/:id/process", async (request) => application.processMeeting(request.params.id));
server.post<{ Params: { id: string } }>("/api/v1/review-items/:id/accept", async (request) => application.acceptReviewItem(request.params.id));
server.patch<{ Params: { id: string }; Body: { title: string } }>("/api/v1/review-items/:id", async (request) => application.updateReviewTitle(request.params.id, request.body.title));
server.post<{ Params: { id: string } }>("/api/v1/review-items/:id/reject", async (request) => application.rejectReviewItem(request.params.id));
server.get("/api/v1/today", async () => application.today());
server.get("/api/v1/tasks", async () => application.tasks());
server.patch<{ Params: { id: string }; Body: { changes: Record<string, unknown>; expectedHash: string } }>("/api/v1/tasks/:id", async (request) => application.updateTask(request.params.id, request.body.changes, request.body.expectedHash));
server.post<{ Body: { text: string } }>("/api/v1/capture", async (request) => application.quickCapture(request.body.text));
server.get<{ Querystring: { q?: string } }>("/api/v1/knowledge", async (request) => application.knowledge(request.query.q));
server.post<{ Body: { title: string; text: string } }>("/api/v1/sources/text", async (request) => application.ingestTextSource(request.body.title, request.body.text));
server.get<{ Params: { type: "client" | "product" | "person" } }>("/api/v1/rollups/:type", async (request) => application.rollups(request.params.type));
server.get("/api/v1/projects", async () => application.projects());
server.get("/api/v1/review-items", async () => application.reviews());
server.get("/api/v1/backups", async () => backups.list());
server.post("/api/v1/backups", async () => backups.create());
server.post<{ Params: { id: string } }>("/api/v1/backups/:id/verify", async (request) => backups.verifyRestorable(request.params.id));

const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
server.get("/*", async (request, reply) => {
  const requested = request.url === "/" ? "index.html" : request.url.replace(/^\//, "").split("?")[0]!;
  const target = path.resolve(webRoot, requested);
  if (!target.startsWith(webRoot)) return reply.status(404).send({ error: "Not found" });
  const content = await readFile(target).catch(() => requested === "index.html" ? undefined : readFile(path.join(webRoot, "index.html")).catch(() => undefined));
  if (!content) return reply.status(404).send({ error: "Web build not found; run pnpm build" });
  const contentType = target.endsWith(".js") ? "application/javascript" : target.endsWith(".css") ? "text/css" : "text/html";
  return reply.type(contentType).send(content);
});

server.setErrorHandler((error, _request, reply) => {
  const failure = error instanceof Error ? error : new Error("Unknown server error");
  const statusCode = failure.name === "ObjectConflictError" ? 409 : 400;
  reply.status(statusCode).send({ error: failure.message });
});

try {
  await session.start();
  await application.rebuildIndex();
  await application.recoverOperations();
  await application.rebuildIndex();
  await server.listen({ host, port });
  let reconcileTimer: NodeJS.Timeout | undefined;
  const watcher = watch(dataRoot, { recursive: true }, (_event, filename) => {
    if (!filename || filename.startsWith(".lifeos/")) return;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => void application.rebuildIndex().catch((error) => server.log.error(error)), 250);
  });
  const heartbeat = setInterval(() => void session.touch(), 60_000);
  heartbeat.unref();
  const shutdown = async () => {
    clearInterval(heartbeat);
    clearTimeout(reconcileTimer);
    watcher.close();
    await session.close();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
