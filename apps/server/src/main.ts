import path from "node:path";
import os from "node:os";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { MockAiProvider } from "@lifeos/ai";
import { LifeOSApplication, type ReviewEdits } from "@lifeos/application";
import { FilesystemAssetStore } from "@lifeos/assets-filesystem";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";
import { GoogleCalendarConnector, MockCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemInboxStore, FilesystemSessionStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { MacOSKeychainSecretStore } from "@lifeos/secrets";
import { httpError } from "./http-errors.js";

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
// Dev mode (PB-001) forces the mock calendar: Google's OAuth callback belongs to the stable app on 4310.
const mockCalendarOnly = process.env.LIFEOS_CALENDAR === "mock";
const savedGoogleClientId = mockCalendarOnly ? undefined : await secrets.get("google:default:client-id");
let google = savedGoogleClientId ? new GoogleCalendarConnector({ clientId: savedGoogleClientId, redirectUri: googleRedirectUri, secrets }) : undefined;
const mockCalendar = new MockCalendarConnector();
const calendar = { get provider() { return (google ?? mockCalendar).provider; }, listEvents: (from: Date, to: Date) => (google ?? mockCalendar).listEvents(from, to), listCalendars: () => (google ?? mockCalendar).listCalendars() };
const application = new LifeOSApplication(store, index, calendar, new MockAiProvider(), deviceId, new FilesystemInboxStore(dataRoot));
const server = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });

// The stable app serves the UI itself (same origin); only the Vite dev UI needs CORS.
await server.register(cors, { origin: ["http://127.0.0.1:5174", "http://localhost:5174"] });

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
server.get<{ Querystring: { q?: string; state?: string } }>("/api/v1/notes", async (request, reply) => {
  const state = request.query.state ?? "open";
  if (state !== "open" && state !== "deleted") return reply.status(400).send({ error: "state must be open or deleted" });
  return application.searchNotes(request.query.q ?? "", state);
});
server.get<{ Params: { type: "task" | "project" | "client" | "product" | "person" } }>("/api/v1/entities/:type", async (request) => application.entities(request.params.type));
server.post<{ Params: { type: "task" | "project" | "client" | "product" | "person" }; Body: { fields: Record<string, unknown> } }>("/api/v1/entities/:type", async (request) => application.createEntity(request.params.type, request.body.fields));
server.patch<{ Params: { id: string }; Body: { fields: Record<string, unknown>; expectedHash: string } }>("/api/v1/entities/by-id/:id", async (request) => application.updateEntity(request.params.id, request.body.fields, request.body.expectedHash));
server.delete<{ Params: { id: string }; Body: { expectedHash: string } }>("/api/v1/entities/by-id/:id", async (request) => application.deleteEntity(request.params.id, request.body.expectedHash));
// #39: display labels for badges and pickers, and the manual External override (null = back to the email rule).
server.get("/api/v1/people/labels", async () => application.personLabels());
server.put<{ Params: { id: string }; Body: { isExternal?: boolean | null; expectedHash?: string } }>("/api/v1/people/:id/external", async (request, reply) => {
  const { isExternal, expectedHash } = request.body ?? {};
  if (isExternal !== true && isExternal !== false && isExternal !== null) return reply.status(400).send({ error: "isExternal must be true, false or null" });
  if (typeof expectedHash !== "string") return reply.status(400).send({ error: "expectedHash is required" });
  return application.setPersonExternal(request.params.id, isExternal, expectedHash);
});
server.post("/api/v1/index/rebuild", async () => application.rebuildIndex());
server.get<{ Querystring: { from?: string; to?: string } }>("/api/v1/calendar/events", async (request, reply) => {
  const from = request.query.from ? new Date(request.query.from) : undefined;
  const to = request.query.to ? new Date(request.query.to) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) return reply.status(400).send({ error: "Enter a valid calendar date range" });
  return application.listCalendarEvents(from, to);
});
server.get("/api/v1/calendar/calendars", async () => application.listCalendars());
server.get("/api/v1/settings/calendar-preferences", async () => application.getCalendarPreferences());
server.put<{ Body: { disabledCalendarIds?: string[]; defaultCalendarId?: string; expectedHash?: string } }>("/api/v1/settings/calendar-preferences", async (request) => {
  const { disabledCalendarIds = [], defaultCalendarId, expectedHash } = request.body ?? {};
  return application.saveCalendarPreferences({ disabledCalendarIds, defaultCalendarId }, expectedHash);
});
server.get("/api/v1/settings/internal-domains", async () => application.getInternalDomains());
server.put<{ Body: { domains?: unknown[]; expectedHash?: string } }>("/api/v1/settings/internal-domains", async (request, reply) => {
  const { domains, expectedHash } = request.body ?? {};
  if (!Array.isArray(domains)) return reply.status(400).send({ error: "domains must be a list" });
  return application.saveInternalDomains(domains, expectedHash);
});
server.post<{ Querystring: { from?: string; to?: string } }>("/api/v1/calendar/sync", async (request, reply) => {
  const from = request.query.from ? new Date(request.query.from) : undefined;
  const to = request.query.to ? new Date(request.query.to) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) return reply.status(400).send({ error: "Enter a valid calendar date range" });
  return application.syncCalendar(from, to);
});
server.get("/api/v1/connections/google", async () => google ? ({ ...await google.status(), ...application.calendarSyncStatus() }) : ({ configured: false, connected: false, provider: "mock", missing: ["Google OAuth Desktop client credentials"] }));
server.get("/api/v1/settings/connections", async () => ({
  calendar: { ...(google ? await google.status() : { connected: false }), configured: Boolean(await secrets.get("google:default:client-id")) && Boolean(await secrets.get("google:default:client-secret")), ...application.calendarSyncStatus() },
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
  return reply.type("text/html").send('<!doctype html><meta charset="utf-8"><title>LifeOS connected</title><style>body{font-family:system-ui;max-width:560px;margin:80px auto;color:#173f32}a{color:#173f32}</style><h1>Google Calendar connected</h1><p>Your tokens are stored in macOS Keychain. You can return to LifeOS.</p><a href="/">Return to LifeOS</a>');
});
// Opening an event is a pure read (PB-020): it returns the existing workspace or a non-persisted preview.
server.get<{ Querystring: { externalId: string; calendarId?: string; from?: string; to?: string } }>("/api/v1/meetings/preview", async (request, reply) => {
  const from = request.query.from ? new Date(request.query.from) : undefined;
  const to = request.query.to ? new Date(request.query.to) : undefined;
  if (!request.query.externalId || (from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) return reply.status(400).send({ error: "Enter a valid calendar date range" });
  return application.previewMeetingFromEvent(request.query.externalId, from, to, request.query.calendarId);
});
// Materializes the meeting + note; the web calls it only on the first real edit, with that text as `body`.
server.post<{ Body: { externalId: string; calendarId?: string; from?: string; to?: string; body?: string } }>("/api/v1/meetings/from-event", async (request, reply) => {
  const from = request.body.from ? new Date(request.body.from) : undefined;
  const to = request.body.to ? new Date(request.body.to) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to)) return reply.status(400).send({ error: "Enter a valid calendar date range" });
  if (request.body.body !== undefined && typeof request.body.body !== "string") return reply.status(400).send({ error: "Note body must be text" });
  const created = await application.createMeetingFromEvent(request.body.externalId, from, to, request.body.calendarId, request.body.body);
  // #40: new calendar people may duplicate older ones; propose merges in the background (never merged automatically).
  void application.suggestPersonMerges().catch((error) => server.log.error(error));
  return created;
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
server.patch<{ Params: { id: string }; Body: { changes?: Record<string, unknown>; expectedHash?: string } }>("/api/v1/notes/:id", async (request, reply) => {
  if (typeof request.body?.expectedHash !== "string") return reply.status(400).send({ error: "expectedHash is required to edit a note" });
  if (!request.body.changes || typeof request.body.changes !== "object") return reply.status(400).send({ error: "changes are required" });
  return application.updateNoteMetadata(request.params.id, request.body.changes, request.body.expectedHash);
});
server.post<{ Params: { id: string }; Body: { expectedHash?: string } }>("/api/v1/notes/:id/restore", async (request, reply) => {
  if (typeof request.body?.expectedHash !== "string") return reply.status(400).send({ error: "expectedHash is required to restore a note" });
  return application.restoreNote(request.params.id, request.body.expectedHash);
});
server.delete<{ Params: { id: string }; Body: { expectedHash?: string } }>("/api/v1/notes/:id", async (request, reply) => {
  if (typeof request.body?.expectedHash !== "string") return reply.status(400).send({ error: "expectedHash is required to delete a note" });
  return application.deleteNote(request.params.id, request.body.expectedHash);
});
server.post<{ Params: { id: string }; Body: { expectedHash: string } }>("/api/v1/objects/:id/archive", async (request) => application.archiveObject(request.params.id, request.body.expectedHash));
server.post<{ Params: { id: string }; Body: { sensitivity?: "normal" | "restricted"; expectedHash?: string } }>("/api/v1/objects/:id/sensitivity", async (request, reply) => {
  if (typeof request.body?.expectedHash !== "string" || typeof request.body.sensitivity !== "string") return reply.status(400).send({ error: "sensitivity and expectedHash are required" });
  return application.setSensitivity(request.params.id, request.body.sensitivity, request.body.expectedHash);
});
server.post<{ Params: { id: string } }>("/api/v1/meetings/:id/process", async (request) => application.processMeeting(request.params.id));
server.post<{ Params: { id: string }; Body: { linkTo?: string } | undefined }>("/api/v1/review-items/:id/accept", async (request) => application.acceptReviewItem(request.params.id, { linkTo: typeof request.body?.linkTo === "string" ? request.body.linkTo : undefined }));
// Edits a pending proposal: title, owner, due, priority and context links (#34); `null` clears a field.
server.patch<{ Params: { id: string }; Body: ReviewEdits }>("/api/v1/review-items/:id", async (request) => application.updateReviewFields(request.params.id, request.body ?? {}));
server.post<{ Params: { id: string } }>("/api/v1/review-items/:id/reject", async (request) => application.rejectReviewItem(request.params.id));
// #46: `date` is the user's local date (the browser knows the display time zone); it picks the Daily Focus brief.
server.get<{ Querystring: { date?: string } }>("/api/v1/today", async (request, reply) => {
  const date = request.query.date;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.status(400).send({ error: "date must be YYYY-MM-DD" });
  return application.today({ date });
});
server.post<{ Body: { date?: string } }>("/api/v1/focus/replan", async (request, reply) => {
  if (typeof request.body?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(request.body.date)) return reply.status(400).send({ error: "date (YYYY-MM-DD) is required" });
  return application.requestReplan(request.body.date);
});
server.get("/api/v1/tasks", async () => application.tasks());
server.patch<{ Params: { id: string }; Body: { changes: Record<string, unknown>; expectedHash: string } }>("/api/v1/tasks/:id", async (request) => application.updateTask(request.params.id, request.body.changes, request.body.expectedHash));
server.post<{ Body: { text: string } }>("/api/v1/capture", async (request) => application.quickCapture(request.body.text));
server.get<{ Querystring: { q?: string } }>("/api/v1/knowledge", async (request) => application.knowledge(request.query.q));
server.post<{ Body: { title: string; text: string } }>("/api/v1/sources/text", async (request) => application.ingestTextSource(request.body.title, request.body.text));
server.get<{ Params: { type: "client" | "product" | "person" } }>("/api/v1/rollups/:type", async (request) => application.rollups(request.params.type));
server.get("/api/v1/projects", async () => application.projects());
// #41 Decisions workspace. Filters: projectId, clientId, productId, personId, status, from/to (ISO instants on decided_at).
server.get<{ Querystring: { projectId?: string; clientId?: string; productId?: string; personId?: string; status?: string; from?: string; to?: string } }>("/api/v1/decisions", async (request) => application.decisions(request.query));
server.get<{ Params: { id: string } }>("/api/v1/decisions/:id", async (request) => application.decision(request.params.id));
server.post<{ Body: { fields?: Record<string, unknown> } }>("/api/v1/decisions", async (request, reply) => {
  if (!request.body?.fields || typeof request.body.fields !== "object") return reply.status(400).send({ error: "fields are required" });
  return application.createDecision(request.body.fields);
});
server.patch<{ Params: { id: string }; Body: { fields?: Record<string, unknown>; expectedHash?: string } }>("/api/v1/decisions/:id", async (request, reply) => {
  if (typeof request.body?.expectedHash !== "string" || !request.body.fields || typeof request.body.fields !== "object") return reply.status(400).send({ error: "fields and expectedHash are required" });
  return application.updateDecision(request.params.id, request.body.fields, request.body.expectedHash);
});
server.post<{ Params: { id: string }; Body: { fields?: Record<string, unknown>; expectedHash?: string } }>("/api/v1/decisions/:id/supersede", async (request, reply) => {
  if (typeof request.body?.expectedHash !== "string" || !request.body.fields || typeof request.body.fields !== "object") return reply.status(400).send({ error: "fields and expectedHash are required" });
  return application.supersedeDecision(request.params.id, request.body.fields, request.body.expectedHash);
});
// Each item carries its evidence per field, with sources looked up now (missing ones come back unresolved).
server.get("/api/v1/review-items", async () => application.reviews().map((review) => ({ ...review, evidence: application.reviewEvidence(review.frontmatter.id) })));
server.get("/api/v1/inbox/drafts", async () => application.inboxStatus());
server.post("/api/v1/inbox/adopt", async () => application.adoptDrafts());
server.get("/api/v1/enrichment", async () => application.enrichmentStatus());
server.post("/api/v1/enrichment/work-orders", async () => application.requestEnrichment());
server.post<{ Params: { id: string }; Body: { expectedHash?: string } }>("/api/v1/meetings/:id/enrichment/gave-up", async (request, reply) => {
  if (typeof request.body?.expectedHash !== "string") return reply.status(400).send({ error: "expectedHash is required" });
  return application.markEnrichmentGaveUp(request.params.id, request.body.expectedHash);
});
server.get("/api/v1/inbox/patches", async () => application.appliedPatches());
server.post<{ Params: { id: string } }>("/api/v1/inbox/patches/:id/undo", async (request) => application.undoPatch(request.params.id));
server.get("/api/v1/backups", async () => backups.list());
server.post("/api/v1/backups", async () => backups.create());
server.post<{ Params: { id: string } }>("/api/v1/backups/:id/verify", async (request) => backups.verifyRestorable(request.params.id));

// Serves the production web build (PB-001): unknown non-API paths fall back to index.html.
// The launcher points LIFEOS_WEB_ROOT at its own snapshot of the build, so a later `pnpm build` cannot change the running app.
const webRoot = process.env.LIFEOS_WEB_ROOT ? path.join(path.resolve(process.env.LIFEOS_WEB_ROOT), path.sep) : fileURLToPath(new URL("../../web/dist/", import.meta.url));
const webMimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json" };
server.get("/*", async (request, reply) => {
  let requested: string;
  try { requested = decodeURIComponent(request.url.split("?")[0]!.replace(/^\//, "")) || "index.html"; }
  catch { return reply.status(404).send({ error: "Not found" }); }
  if (requested.startsWith("api/")) return reply.status(404).send({ error: "Not found" });
  const target = path.resolve(webRoot, requested);
  if (!target.startsWith(webRoot)) return reply.status(404).send({ error: "Not found" });
  let served = target;
  let content = await readFile(target).catch(() => undefined);
  if (!content && !path.extname(requested)) { served = path.join(webRoot, "index.html"); content = await readFile(served).catch(() => undefined); }
  if (!content) return reply.status(404).send({ error: requested === "index.html" ? "Web build not found; run pnpm build" : "Not found" });
  // Vite fingerprints files under assets/, so they can be cached; index.html must always be fresh.
  reply.header("cache-control", served.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
  return reply.type(webMimeTypes[path.extname(served).toLowerCase()] ?? "application/octet-stream").send(content);
});

server.setErrorHandler((error, _request, reply) => {
  const { statusCode, body } = httpError(error);
  reply.status(statusCode).send(body);
});

try {
  await session.start();
  await application.rebuildIndex();
  await application.recoverOperations();
  await application.rebuildIndex();
  if (session.status().writeAllowed) await application.suggestPersonMerges().catch((error) => server.log.error(error));
  // Inbox Drafts and Patch Drafts (ADR 0007) are adopted at startup and shortly after one lands, but only while this device holds the lease.
  let adoptTimer: NodeJS.Timeout | undefined;
  const adopt = async () => {
    if (!session.status().writeAllowed) return;
    const batch = await application.adoptDrafts();
    // Drafts still being written are skipped; look again once the 2-second grace period has passed.
    if (batch.retrySoon) scheduleAdoption();
  };
  const scheduleAdoption = () => {
    clearTimeout(adoptTimer);
    adoptTimer = setTimeout(() => void adopt().catch((error) => server.log.error(error)), 2500);
  };
  await adopt().catch((error) => server.log.error(error));
  await server.listen({ host, port });
  let reconcileTimer: NodeJS.Timeout | undefined;
  const watcher = watch(dataRoot, { recursive: true }, (_event, filename) => {
    if (!filename || filename.startsWith(".lifeos/") || filename.startsWith("_agent/")) return;
    if (filename.startsWith("_inbox/")) { if (filename.startsWith("_inbox/drafts/") || filename.startsWith("_inbox/patches/")) scheduleAdoption(); return; }
    clearTimeout(reconcileTimer);
    // U4, U5: record edits made outside the app; read-only (another device holds the lease) only refreshes the index.
    const reconcile = () => session.status().writeAllowed ? application.recordExternalChanges() : application.rebuildIndex();
    reconcileTimer = setTimeout(() => void reconcile().catch((error) => server.log.error(error)), 250);
  });
  const heartbeat = setInterval(() => void session.touch(), 60_000);
  heartbeat.unref();
  const shutdown = async () => {
    clearInterval(heartbeat);
    clearTimeout(reconcileTimer);
    clearTimeout(adoptTimer);
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
