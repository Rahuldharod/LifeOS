/**
 * #120: the localhost API as an importable module. `buildApi` wires the application, the device lease and every
 * route onto a Fastify instance for one data root, without opening a port, so tests call it through `inject`.
 * `start(listen)` runs the startup work, calls `listen`, and only then starts the background triggers; `main.ts` only
 * reads the environment, refuses a data root without `.lifeos/schema.md` (ADR 0014), opens the port and handles signals.
 *
 * Background object writers (adoption, external-edit audits, person-merge suggestions, the Agent Index) run only
 * while this device holds the lease; the heartbeat runs the idle check (ADR 0015).
 */
import path from "node:path";
import { watch } from "node:fs";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { LifeOSApplication, type AutoBackups, type CalendarConnector } from "@lifeos/application";
import { FilesystemAssetStore } from "@lifeos/assets-filesystem";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";
import { MemoryIndex } from "@lifeos/index-memory";
import { FilesystemAgentIndexWriter, FilesystemInboxStore, FilesystemSessionStore, MarkdownObjectStore } from "@lifeos/object-store-markdown";
import type { KnownSecrets } from "@lifeos/secrets";
import { loadContractFiles } from "./contract-files.js";
import { listBundledSkills, pluginMarketplace, zipBundledSkill } from "./skills-bundle.js";
import type { calendarSource } from "./calendar-source.js";
import { connectionSettings, googleConnectionStatus } from "./connections.js";
import { httpError } from "./http-errors.js";
import { IdleRelease, registerLease } from "./lease.js";
import { registerNotePurge } from "./note-purge-routes.js";
import { registerNotesList } from "./notes-list-route.js";
import { calendarRange, hasExpectedHash, invalidCalendarRange, isCalendarDay } from "./request-checks.js";
import { shutDown } from "./shutdown.js";
import { route } from "./route.js";
import { registerWebApp } from "./web-app.js";

/** What the routes need from the Google Calendar connector beyond reading calendars. */
export interface GoogleCalendar extends CalendarConnector {
  readonly authExpired: boolean;
  authorizationUrl(): Promise<string>;
  completeAuthorization(code: string, state: string): Promise<unknown>;
}

export type CalendarSource = ReturnType<typeof calendarSource<GoogleCalendar>>;

/** The Claude Code plugin and marketplace names in `.claude-plugin/` (ADR 0020). */
const pluginName = "lifeos";
const marketplaceName = "lifeos-skills";

export interface ApiOptions {
  /** A LifeOS data folder; the caller has already checked it holds `.lifeos/schema.md` (ADR 0014). */
  dataRoot: string;
  backupRoot: string;
  deviceId: string;
  /** Status routes answer from what these have seen and never read a secret value (#77). */
  secrets: KnownSecrets;
  calendars: CalendarSource;
  /** Released after this long without user activity (ADR 0015). */
  idleReleaseMs: number;
  /** The production web build served for every non-API URL. */
  webRoot: string;
  logger?: boolean;
  /** ADR 0020: where the bundled contract files are read from; defaults to the repository's `contract/`. */
  contractRoot?: string;
  /** ADR 0020: where the installable skills are read from; defaults to the repository's `skills/`. */
  skillsRoot?: string;
  /** Trigger intervals; the defaults are the stable app's. Tests shorten them. */
  timing?: { heartbeatMs?: number; reconcileDelayMs?: number; adoptionSweepMs?: number; adoptionDebounceMs?: number };
}

export interface LifeOSApi {
  server: FastifyInstance;
  /**
   * Claims the lease (or starts read-only), rebuilds the index, recovers interrupted operations, adopts waiting drafts,
   * calls `listen` (opens the port), and only once it is listening starts automatic backups, the data-folder watcher
   * and the lease heartbeat. If any step throws, adoption stops, the lease is released and the error is rethrown.
   * `stop()` is the clean stop (#95): writes answer 503, triggers stop, HTTP closes, the stop backup runs, the lease is released.
   */
  start(listen: () => PromiseLike<unknown>): Promise<{ stop(): Promise<void> }>;
}

export async function buildApi(options: ApiOptions): Promise<LifeOSApi> {
  const { dataRoot, backupRoot, deviceId, secrets, calendars } = options;
  const timing = { heartbeatMs: 60_000, reconcileDelayMs: 250, ...options.timing };
  const store = new MarkdownObjectStore(dataRoot);
  const session = new FilesystemSessionStore(dataRoot, deviceId);
  const backups = new FilesystemBackupService(dataRoot, backupRoot);
  const assets = new FilesystemAssetStore(dataRoot);
  // #98: no AI provider; Claude does the AI work through the skills (ADR 0008). The mock AI is for tests only.
  // The Agent Index (#43) is rewritten in `_agent/` 1.5 s after the last index rebuild, only by the lease holder and only for files
  // whose summary changed; the watcher ignores `_agent/`.
  const application = new LifeOSApplication(store, new MemoryIndex(), calendars.calendar, undefined, deviceId, new FilesystemInboxStore(dataRoot), new FilesystemAgentIndexWriter(dataRoot), { agentIndexCanWrite: () => session.holdsLease(), contract: await loadContractFiles(options.contractRoot) });
  const server = Fastify({ logger: options.logger ?? false, bodyLimit: 15 * 1024 * 1024 });
  // #84: automatic backups start with the server; the start backup runs in the background (never blocks start-up or the UI).
  let autoBackups: AutoBackups | undefined;
  /** #95: set when a stop begins; writes then answer 503 so the stop backup sees settled data. */
  let stopping = false;
  const backupWarning = async () => {
    const warning = (await autoBackups?.status().catch(() => undefined))?.warning;
    return warning ? { backupWarning: warning } : {};
  };

  // The stable app serves the UI itself (same origin); only the Vite dev UI needs CORS.
  await server.register(cors, { origin: ["http://127.0.0.1:5174", "http://localhost:5174"] });

  // ADR 0003 and 0015: read-only enforcement, takeover, and the idle auto-handover of the device lease.
  const idle = new IdleRelease(session, options.idleReleaseMs);
  registerLease(server, { session, idle, stopping: () => stopping });

  route(server, "GET /api/v1/health", async () => ({ ...await application.health(), session: await session.refresh(), idleReleaseMinutes: idle.idleMs / 60_000, ...await backupWarning() }));
  route(server, "GET /api/v1/objects", async () => application.listObjects());
  registerNotesList(server, application);
  route(server, "GET /api/v1/entities/:type", async (request) => application.entities(request.params.type));
  route(server, "POST /api/v1/entities/:type", async (request) => application.createEntity(request.params.type, request.body.fields));
  route(server, "PATCH /api/v1/entities/by-id/:id", async (request) => application.updateEntity(request.params.id, request.body.fields, request.body.expectedHash));
  route(server, "DELETE /api/v1/entities/by-id/:id", async (request) => application.deleteEntity(request.params.id, request.body.expectedHash));
  // #39: display labels for badges and pickers, and the manual External override (null = back to the email rule).
  route(server, "GET /api/v1/people/labels", async () => application.personLabels());
  route(server, "PUT /api/v1/people/:id/external", async (request, reply) => {
    const { isExternal } = request.body ?? {};
    if (isExternal !== true && isExternal !== false && isExternal !== null) return reply.status(400).send({ error: "isExternal must be true, false or null" });
    if (!hasExpectedHash(request.body)) return reply.status(400).send({ error: "expectedHash is required" });
    return application.setPersonExternal(request.params.id, isExternal, request.body.expectedHash);
  });
  // #87: the user confirms an automatically created ("unreviewed") person.
  route(server, "POST /api/v1/people/:id/reviewed", async (request, reply) => {
    if (!hasExpectedHash(request.body)) return reply.status(400).send({ error: "expectedHash is required" });
    return application.confirmPersonReviewed(request.params.id, request.body.expectedHash);
  });
  route(server, "POST /api/v1/index/rebuild", async () => application.rebuildIndex());

  route(server, "GET /api/v1/calendar/events", async (request, reply) => {
    const range = calendarRange(request.query);
    if (!range) return reply.status(400).send({ error: invalidCalendarRange });
    return application.listCalendarEvents(range.from, range.to);
  });
  route(server, "GET /api/v1/calendar/calendars", async () => application.listCalendars());
  route(server, "GET /api/v1/settings/calendar-preferences", async () => application.getCalendarPreferences());
  route(server, "PUT /api/v1/settings/calendar-preferences", async (request) => {
    const { disabledCalendarIds = [], defaultCalendarId, expectedHash } = request.body ?? {};
    return application.saveCalendarPreferences({ disabledCalendarIds, defaultCalendarId }, expectedHash);
  });
  route(server, "GET /api/v1/settings/internal-domains", async () => application.getInternalDomains());
  route(server, "PUT /api/v1/settings/internal-domains", async (request, reply) => {
    const { domains, expectedHash } = request.body ?? {};
    if (!Array.isArray(domains)) return reply.status(400).send({ error: "domains must be a list" });
    return application.saveInternalDomains(domains, expectedHash);
  });
  // ADR 0020: read-only; derived from the newest .result.md, so it reads no settings or secrets.
  route(server, "GET /api/v1/settings/claude-skills", async () => {
    const [status, skills, marketplace] = await Promise.all([application.skillPackStatus(), listBundledSkills(options.skillsRoot), pluginMarketplace()]);
    return { ...status, skills, ...(marketplace ? { plugin: { marketplace, install: `${pluginName}@${marketplaceName}` } } : {}) };
  });
  // ADR 0020: one bundled skill as a zip for claude.ai (Settings → Capabilities → Skills → Upload skill). Read-only.
  server.get<{ Params: { name: string } }>("/api/v1/settings/claude-skills/:name/zip", async (request, reply) => {
    const zip = await zipBundledSkill(request.params.name, options.skillsRoot);
    if (!zip) return reply.status(404).send({ error: "No such LifeOS skill" });
    return reply.type("application/zip").header("content-disposition", `attachment; filename="${request.params.name}.zip"`).send(zip);
  });
  // #54: the user's own addresses live in a synced setting, never in code.
  route(server, "GET /api/v1/settings/self-emails", async () => application.getSelfEmails());
  route(server, "PUT /api/v1/settings/self-emails", async (request, reply) => {
    const { emails, expectedHash } = request.body ?? {};
    if (!Array.isArray(emails)) return reply.status(400).send({ error: "emails must be a list" });
    return application.saveSelfEmails(emails, expectedHash);
  });
  // #48: meeting-hours threshold and brief time; invalid values answer 400 with every problem named.
  route(server, "GET /api/v1/settings/today", async () => application.getTodaySettings());
  route(server, "PUT /api/v1/settings/today", async (request) => {
    const { expectedHash, meetingHoursThreshold, briefTime, briefTimeZone, briefDays } = request.body ?? {};
    const changes = Object.fromEntries(Object.entries({ meetingHoursThreshold, briefTime, briefTimeZone, briefDays }).filter(([, value]) => value !== undefined));
    return application.saveTodaySettings(changes, expectedHash);
  });
  route(server, "POST /api/v1/calendar/sync", async (request, reply) => {
    const range = calendarRange(request.query);
    if (!range) return reply.status(400).send({ error: invalidCalendarRange });
    return application.syncCalendar(range.from, range.to);
  });
  // #88 (PB-022b): like /calendar/events and /calendar/sync, but a calendar that cannot be read (network, expired
  // token, denied Keychain) answers 200 with the meetings already in LifeOS and an `offline` state, never an error.
  route(server, "GET /api/v1/calendar/day", async (request, reply) => {
    const range = calendarRange(request.query);
    if (!range) return reply.status(400).send({ error: invalidCalendarRange });
    return application.calendarDay(range.from, range.to);
  });
  route(server, "POST /api/v1/calendar/day/sync", async (request, reply) => {
    const range = calendarRange(request.query);
    if (!range) return reply.status(400).send({ error: invalidCalendarRange });
    return application.calendarDay(range.from, range.to, { sync: true });
  });
  route(server, "GET /api/v1/connections/google", async () => googleConnectionStatus(secrets, calendars.google, application.calendarSyncStatus()));
  route(server, "GET /api/v1/settings/connections", async () => connectionSettings(secrets, calendars.google, application.calendarSyncStatus()));
  // #77: Retry on the Connections card after a denied Keychain prompt; may show the prompt again, since the user asked.
  route(server, "POST /api/v1/settings/connections/retry", async () => {
    await calendars.probe();
    return connectionSettings(secrets, calendars.google, application.calendarSyncStatus());
  });
  route(server, "POST /api/v1/settings/connections/google/:provider", async (request, reply) => {
    const clientId = request.body.clientId.trim();
    const clientSecret = request.body.clientSecret.trim();
    if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) return reply.status(400).send({ error: "Enter a valid Google OAuth client ID and client secret" });
    const prefix = request.params.provider === "calendar" ? "google:default" : "google-drive:default";
    await Promise.all([secrets.set(`${prefix}:client-id`, clientId), secrets.set(`${prefix}:client-secret`, clientSecret)]);
    if (request.params.provider === "calendar") calendars.useGoogle(clientId);
    return { configured: true, connected: false };
  });
  route(server, "POST /api/v1/connections/google/configure", async (request, reply) => {
    const clientId = request.body.clientId.trim();
    const clientSecret = request.body.clientSecret.trim();
    if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) return reply.status(400).send({ error: "Enter a valid Google OAuth Desktop client ID and client secret" });
    await Promise.all([secrets.set("google:default:client-id", clientId), secrets.set("google:default:client-secret", clientSecret)]);
    calendars.useGoogle(clientId);
    return googleConnectionStatus(secrets, calendars.google, application.calendarSyncStatus());
  });
  route(server, "GET /api/v1/connections/google/start", async (_request, reply) => {
    if (!calendars.google) return reply.status(400).send({ error: "Configure the Google OAuth Desktop client before connecting Google Calendar" });
    return { authorizationUrl: await calendars.google.authorizationUrl() };
  });
  server.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/v1/connections/google/callback", async (request, reply) => {
    if (!calendars.google) return reply.status(400).type("text/html").send("<h1>Google Calendar is not configured</h1>");
    if (request.query.error) return reply.status(400).type("text/html").send(`<h1>Connection declined</h1><p>${request.query.error}</p>`);
    if (!request.query.code || !request.query.state) return reply.status(400).type("text/html").send("<h1>Invalid OAuth callback</h1>");
    await calendars.google.completeAuthorization(request.query.code, request.query.state);
    await application.recordGoogleConnection();
    return reply.type("text/html").send('<!doctype html><meta charset="utf-8"><title>LifeOS connected</title><style>body{font-family:system-ui;max-width:560px;margin:80px auto;color:#173f32}a{color:#173f32}</style><h1>Google Calendar connected</h1><p>Your tokens are stored in macOS Keychain. You can return to LifeOS.</p><a href="/">Return to LifeOS</a>');
  });
  // Opening an event is a pure read (PB-020): it returns the existing workspace or a non-persisted preview.
  route(server, "GET /api/v1/meetings/preview", async (request, reply) => {
    const range = calendarRange(request.query);
    if (!request.query.externalId || !range) return reply.status(400).send({ error: invalidCalendarRange });
    return application.previewMeetingFromEvent(request.query.externalId, range.from, range.to, request.query.calendarId);
  });
  // Materializes the meeting + note; the web calls it only on the first real edit, with that text as `body`.
  route(server, "POST /api/v1/meetings/from-event", async (request, reply) => {
    const range = calendarRange(request.body);
    if (!range) return reply.status(400).send({ error: invalidCalendarRange });
    if (request.body.body !== undefined && typeof request.body.body !== "string") return reply.status(400).send({ error: "Note body must be text" });
    const created = await application.createMeetingFromEvent(request.body.externalId, range.from, range.to, request.body.calendarId, request.body.body);
    // #40: new calendar people may duplicate older ones; propose merges in the background (never merged automatically).
    void application.suggestPersonMerges().catch((error) => server.log.error(error));
    return created;
  });
  route(server, "GET /api/v1/meetings/from-event/:externalId", async (request) => application.meetingFromEvent(request.params.externalId));
  route(server, "GET /api/v1/meetings/:id/workspace", async (request) => application.meetingWorkspace(request.params.id));
  route(server, "PUT /api/v1/objects/:id/body", async (request) => application.updateBody(request.params.id, request.body.body, request.body.expectedHash));
  route(server, "POST /api/v1/objects/:id/assets", async (request) => {
    const object = application.object(request.params.id);
    const encoded = request.body.contentBase64.replace(/^data:[^;]+;base64,/, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid base64 image data");
    const content = Buffer.from(encoded, "base64");
    if (content.byteLength > 10 * 1024 * 1024) throw new Error("Images must be 10 MB or smaller");
    return assets.put({ ownerRelativePath: object.relativePath, fileName: request.body.fileName, mimeType: request.body.mimeType, content });
  });
  server.get<{ Params: { "*": string } }>("/api/v1/assets/*", async (request, reply) => {
    // Fastify has already percent-decoded the wildcard once; decoding again would break names containing "%" (#141).
    const relativePath = request.params["*"];
    const extension = path.extname(relativePath).toLowerCase();
    const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
    const mimeType = mimeTypes[extension];
    if (!mimeType) return reply.status(404).send({ error: "Unsupported asset" });
    return reply.type(mimeType).send(await assets.read(relativePath));
  });
  route(server, "PATCH /api/v1/notes/:id", async (request, reply) => {
    if (!hasExpectedHash(request.body)) return reply.status(400).send({ error: "expectedHash is required to edit a note" });
    if (!request.body.changes || typeof request.body.changes !== "object") return reply.status(400).send({ error: "changes are required" });
    return application.updateNoteMetadata(request.params.id, request.body.changes, request.body.expectedHash);
  });
  route(server, "POST /api/v1/notes/:id/previous-series", async (request, reply) => {
    if (!hasExpectedHash(request.body) || typeof request.body.previousNoteId !== "string") return reply.status(400).send({ error: "previousNoteId and expectedHash are required" });
    return application.linkPreviousSeriesNote(request.params.id, request.body.previousNoteId, request.body.expectedHash);
  });
  route(server, "POST /api/v1/notes/:id/restore", async (request, reply) => {
    if (!hasExpectedHash(request.body)) return reply.status(400).send({ error: "expectedHash is required to restore a note" });
    return application.restoreNote(request.params.id, request.body.expectedHash);
  });
  route(server, "DELETE /api/v1/notes/:id", async (request, reply) => {
    if (!hasExpectedHash(request.body)) return reply.status(400).send({ error: "expectedHash is required to delete a note" });
    return application.deleteNote(request.params.id, request.body.expectedHash);
  });
  registerNotePurge(server, application);
  route(server, "POST /api/v1/objects/:id/archive", async (request) => application.archiveObject(request.params.id, request.body.expectedHash));
  route(server, "POST /api/v1/objects/:id/sensitivity", async (request, reply) => {
    if (!hasExpectedHash(request.body) || typeof request.body.sensitivity !== "string") return reply.status(400).send({ error: "sensitivity and expectedHash are required" });
    return application.setSensitivity(request.params.id, request.body.sensitivity, request.body.expectedHash);
  });
  route(server, "POST /api/v1/review-items/:id/accept", async (request) => application.acceptReviewItem(request.params.id, { linkTo: typeof request.body?.linkTo === "string" ? request.body.linkTo : undefined }));
  // Edits a pending proposal: title, owner, due, priority and context links (#34); `null` clears a field.
  route(server, "PATCH /api/v1/review-items/:id", async (request) => application.updateReviewFields(request.params.id, request.body ?? {}));
  route(server, "POST /api/v1/review-items/:id/reject", async (request) => application.rejectReviewItem(request.params.id));
  // #46: `date` is the user's local date (the browser knows the display time zone); it picks the Daily Focus brief.
  route(server, "GET /api/v1/today", async (request, reply) => {
    const date = request.query.date;
    if (date !== undefined && !isCalendarDay(date)) return reply.status(400).send({ error: "date must be YYYY-MM-DD" });
    return application.today({ date });
  });
  // #48: the live panels; `timeZone` (IANA, the browser's display zone) sets the local day's boundaries for meetings.
  route(server, "GET /api/v1/today/panels", async (request, reply) => {
    const { date, timeZone } = request.query;
    if (date !== undefined && !isCalendarDay(date)) return reply.status(400).send({ error: "date must be YYYY-MM-DD" });
    return { ...await application.todayPanels({ date, timeZone }), ...await backupWarning() };
  });
  route(server, "POST /api/v1/focus/replan", async (request, reply) => {
    if (!isCalendarDay(request.body?.date)) return reply.status(400).send({ error: "date (YYYY-MM-DD) is required" });
    return application.requestReplan(request.body.date);
  });
  // #47: one change to the date's Top 3 (pin, unpin, replace, dismiss, restore, reset); 409 when expectedHash is stale.
  route(server, "POST /api/v1/focus/overrides", async (request, reply) => {
    const { date, action, taskId, replacementId, expectedHash } = request.body ?? {};
    if (!isCalendarDay(date)) return reply.status(400).send({ error: "date (YYYY-MM-DD) is required" });
    if (expectedHash !== undefined && typeof expectedHash !== "string") return reply.status(400).send({ error: "expectedHash must be text" });
    return application.overrideFocus(date, { action, taskId, replacementId }, expectedHash);
  });
  route(server, "GET /api/v1/settings/daily-focus", async () => application.getFocusSettings());
  route(server, "PUT /api/v1/settings/daily-focus", async (request) => application.saveFocusSettings({ maxMustDos: request.body?.maxMustDos }, request.body?.expectedHash));
  route(server, "GET /api/v1/tasks", async () => application.tasks());
  route(server, "PATCH /api/v1/tasks/:id", async (request) => application.updateTask(request.params.id, request.body.changes, request.body.expectedHash));
  route(server, "POST /api/v1/capture", async (request) => {
    const { text, primaryProjectId, dueOn, ownerPersonId, sensitivity, requestId } = request.body;
    return application.quickCapture(text, { primaryProjectId, dueOn, ownerPersonId, sensitivity, requestId });
  });
  route(server, "GET /api/v1/knowledge", async (request) => application.knowledge(request.query.q));
  route(server, "POST /api/v1/sources/text", async (request) => application.ingestTextSource(request.body.title, request.body.text));
  route(server, "GET /api/v1/rollups/:type", async (request) => application.rollups(request.params.type));
  route(server, "GET /api/v1/projects", async () => application.projects());

  /** A guarded write to a Decision or Open Point: `fields` plus the expected hash of the version they edit. */
  type FieldsWrite = { Params: { id: string }; Body: { fields?: Record<string, unknown>; expectedHash?: string } };
  const fieldsWrite = <Reply>(write: (id: string, fields: Record<string, unknown>, expectedHash: string) => Promise<Reply>) => async (request: FastifyRequest<FieldsWrite>, reply: FastifyReply) => {
    if (!hasExpectedHash(request.body) || !request.body.fields || typeof request.body.fields !== "object") return reply.status(400).send({ error: "fields and expectedHash are required" });
    return write(request.params.id, request.body.fields, request.body.expectedHash);
  };
  // #41 Decisions workspace. Filters: projectId, clientId, productId, personId, status, from/to (ISO instants on decided_at).
  route(server, "GET /api/v1/decisions", async (request) => application.decisions(request.query));
  route(server, "GET /api/v1/decisions/:id", async (request) => application.decision(request.params.id));
  route(server, "POST /api/v1/decisions", async (request, reply) => {
    if (!request.body?.fields || typeof request.body.fields !== "object") return reply.status(400).send({ error: "fields are required" });
    return application.createDecision(request.body.fields);
  });
  route(server, "PATCH /api/v1/decisions/:id", fieldsWrite((id, fields, hash) => application.updateDecision(id, fields, hash)));
  route(server, "POST /api/v1/decisions/:id/supersede", fieldsWrite((id, fields, hash) => application.supersedeDecision(id, fields, hash)));
  // #42 Open Points workspace: same filters as Decisions (from/to on raised_at); resolve, resolve with a new decision, close.
  route(server, "GET /api/v1/open-points", async (request) => application.openPoints(request.query));
  route(server, "GET /api/v1/open-points/:id", async (request) => application.openPoint(request.params.id));
  route(server, "POST /api/v1/open-points", async (request, reply) => {
    if (!request.body?.fields || typeof request.body.fields !== "object") return reply.status(400).send({ error: "fields are required" });
    return application.createOpenPoint(request.body.fields);
  });
  route(server, "PATCH /api/v1/open-points/:id", fieldsWrite((id, fields, hash) => application.updateOpenPoint(id, fields, hash)));
  route(server, "POST /api/v1/open-points/:id/resolve", fieldsWrite((id, fields, hash) => application.resolveOpenPoint(id, fields, hash)));
  route(server, "POST /api/v1/open-points/:id/resolve-with-decision", fieldsWrite((id, fields, hash) => application.resolveOpenPointWithDecision(id, fields, hash)));
  route(server, "POST /api/v1/open-points/:id/close", fieldsWrite((id, fields, hash) => application.closeOpenPoint(id, fields, hash)));
  // Each item carries its evidence per field, with sources looked up now (missing ones come back unresolved).
  route(server, "GET /api/v1/review-items", async () => application.reviews().map((review) => ({ ...review, evidence: application.reviewEvidence(review.frontmatter.id) })));
  route(server, "GET /api/v1/inbox/drafts", async () => application.inboxStatus());
  route(server, "POST /api/v1/inbox/adopt", async () => application.adoptDrafts());
  route(server, "GET /api/v1/enrichment", async () => application.enrichmentStatus());
  route(server, "POST /api/v1/enrichment/work-orders", async () => application.requestEnrichment());
  route(server, "POST /api/v1/meetings/:id/enrichment/gave-up", async (request, reply) => {
    if (!hasExpectedHash(request.body)) return reply.status(400).send({ error: "expectedHash is required" });
    return application.markEnrichmentGaveUp(request.params.id, request.body.expectedHash);
  });
  route(server, "GET /api/v1/inbox/patches", async () => application.appliedPatches());
  route(server, "POST /api/v1/inbox/patches/:id/undo", async (request) => application.undoPatch(request.params.id));
  route(server, "POST /api/v1/history/:id/restore", async (request) => application.restoreVersion(request.params.id));
  // #85: one object's kept versions and the audit events about them, and restoring any kept version.
  // #92: the panel keeps the hash it was opened with and sends it back, so a save made since is never overwritten (409).
  route(server, "GET /api/v1/objects/:id/history", async (request) => application.historyPanel(request.params.id));
  route(server, "POST /api/v1/objects/:id/history/restore", async (request, reply) => {
    if (typeof request.body?.versionPath !== "string" || !hasExpectedHash(request.body)) return reply.status(400).send({ error: "versionPath and expectedHash are required" });
    return application.restoreKeptVersion(request.params.id, request.body.versionPath, request.body.expectedHash);
  });
  route(server, "GET /api/v1/backups", async () => backups.list());
  // "Back up now" (System and the backup warning): recorded like the automatic ones, so a success clears the warning.
  route(server, "POST /api/v1/backups", async () => autoBackups ? autoBackups.runNow() : backups.create());
  // #95: always a JSON state, including before automatic backups start.
  route(server, "GET /api/v1/backups/status", async () => autoBackups ? autoBackups.status() : application.backupStatus(backups));
  route(server, "GET /api/v1/settings/backups", async () => application.getBackupSettings());
  route(server, "PUT /api/v1/settings/backups", async (request) => application.saveBackupSettings({ offDriveFolder: request.body?.offDriveFolder }, request.body?.expectedHash));
  route(server, "POST /api/v1/backups/:id/verify", async (request) => backups.verifyRestorable(request.params.id));

  // Serves the production web build (PB-001), with every app URL falling back to index.html (PB-027).
  registerWebApp(server, options.webRoot);

  server.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = httpError(error);
    reply.status(statusCode).send(body);
  });

  async function start(listen: () => PromiseLike<unknown>) {
    let autoAdoption: ReturnType<typeof application.startAutoAdoption> | undefined;
    try {
      autoAdoption = await beforeListen();
      await listen();
      return afterListen(autoAdoption);
    } catch (error) {
      // Undo what started, then release the lease this start claimed (the clean stop's release path) so another device is not locked out.
      autoBackups?.dispose();
      await autoAdoption?.stop().catch(() => undefined);
      await session.close().catch((closeError) => server.log.error(closeError));
      throw error;
    }
  }

  async function beforeListen() {
    await session.start();
    await application.rebuildIndex();
    // #69: record edits made while the app was closed before this start writes anything.
    if (session.holdsLease()) await application.recordExternalChanges().catch((error) => server.log.error(error));
    // #56: an operation that cannot be recovered is logged and shown in System Health; the server still starts.
    await application.recoverOperations({ onError: (error, operation) => server.log.error({ err: error, operation: operation.id, kind: operation.kind }, "Operation recovery failed") });
    await application.rebuildIndex();
    if (session.holdsLease()) await application.suggestPersonMerges().catch((error) => server.log.error(error));
    // Inbox Drafts and Patch Drafts (ADR 0007, #32) are adopted at startup (which also finishes a batch a crash interrupted), shortly after
    // one lands, and by a periodic sweep in case watcher events are lost on Drive-synced folders; only while this device holds the lease
    // (not after an idle release, ADR 0015).
    const autoAdoption = application.startAutoAdoption({ canWrite: () => session.holdsLease(), onError: (error) => server.log.error(error), sweepMs: timing.adoptionSweepMs, debounceMs: timing.adoptionDebounceMs });
    await autoAdoption.runNow();
    return autoAdoption;
  }

  /** As before #120: background work starts only once the server is listening. */
  function afterListen(autoAdoption: ReturnType<typeof application.startAutoAdoption>) {
    // Backups (#84): at start, daily while running and at a clean stop; only while this device may write (ADR 0003). Backups only
    // read the data folder into this Mac's own backup folder, so they keep running after an idle release (ADR 0015).
    autoBackups = application.startAutoBackups(backups, { canWrite: () => session.status().writeAllowed || session.status().releasedAfterIdle, onError: (error, trigger) => server.log.error({ err: error, trigger }, "Backup failed") });
    let reconcileTimer: NodeJS.Timeout | undefined;
    let reconciling: Promise<unknown> = Promise.resolve();
    const driveCopyOfAppFolder = /^(\.lifeos|_agent|_inbox) \d+\//; // ADR 0016
    const watcher = watch(dataRoot, { recursive: true }, (_event, filename) => {
      // Google Drive's conflict copies of app folders ("_agent 2/", "_inbox 2/") are ignored too: they must not trigger rebuilds.
      if (!filename || driveCopyOfAppFolder.test(filename) || filename.startsWith(".lifeos/") || filename.startsWith("_agent/")) return;
      if (filename.startsWith("_inbox/")) { if (filename.startsWith("_inbox/drafts/") || filename.startsWith("_inbox/patches/")) autoAdoption.notify(); return; }
      clearTimeout(reconcileTimer);
      // U4, U5: record edits made outside the app; read-only (another device holds the lease) only refreshes the index.
      const reconcile = () => session.holdsLease() ? application.recordExternalChanges() : application.rebuildIndex();
      reconcileTimer = setTimeout(() => { reconciling = reconcile().catch((error) => server.log.error(error)); }, timing.reconcileDelayMs);
    });
    // Every minute: extend the lease, or release it after LIFEOS_IDLE_RELEASE_MINUTES without user activity (ADR 0015).
    const heartbeat = setInterval(() => void idle.tick().catch((error) => server.log.error(error)), timing.heartbeatMs);
    heartbeat.unref();
    // #95: writes stop, HTTP and adoption go idle, then the clean-stop backup, then the lease is released.
    const stop = () => shutDown({
      stopWrites: () => { stopping = true; },
      stopTriggers: () => { clearInterval(heartbeat); clearTimeout(reconcileTimer); watcher.close(); },
      closeHttp: () => server.close(),
      waitForIdle: async () => { await autoAdoption.stop(); await reconciling; },
      stopBackup: async () => { await autoBackups?.stop(); },
      closeSession: () => session.close(),
      log: (error, step) => server.log.error({ err: error, step }, "Stop step failed")
    });
    return { stop };
  }

  return { server, start };
}
