// #121: every JSON endpoint of the localhost API, keyed by "METHOD /path" (Fastify's `:param` syntax).
// The server registers each route from its key (apps/server/src/route.ts) and the browser calls it by the same
// key (apps/web/src/api.ts), so both are type-checked against the one shape declared here. Types only.
//
// Each entry may have: `params` (only to narrow a path parameter; otherwise each `:name` is a string), `query`,
// `body` (optional key = the body may be left out) and `response` (what a 2xx answers). Errors answer `{ error }`.
// `response: unknown` marks an answer the browser does not read; `unknown` forces whoever starts to read it to
// give it a shape here first.
//
// Not listed: the OAuth callback (answers HTML), `GET /api/v1/assets/*` (image bytes) and the web app fallback.
import type * as W from "./wire.js";

type Range = { from?: string; to?: string };
/** #41, #42: list filters; `from`/`to` are ISO instants. */
type ListFilters = { projectId?: string; clientId?: string; productId?: string; personId?: string; status?: string; from?: string; to?: string };
/** A guarded write to a Decision or Open Point: `fields` plus the expected hash of the version they edit. */
type FieldsWrite = { body: { fields: Record<string, unknown>; expectedHash: string } };
type Guarded = { body: { expectedHash: string } };

export interface Endpoints {
  // System
  "GET /api/v1/health": { response: W.SystemHealth };
  "GET /api/v1/objects": { response: W.ObjectLink[] };
  "POST /api/v1/index/rebuild": { response: unknown };
  "POST /api/v1/session/take-over": { response: W.SessionStatus };
  "POST /api/v1/session/activity": { response: W.SessionStatus };

  // Notes (PB-025, #105, PB-030)
  "GET /api/v1/notes": { query: { q?: string; state?: string; type?: string | string[]; projectId?: string; clientId?: string; productId?: string; personId?: string; from?: string; to?: string }; response: W.LifeObject[] };
  "PATCH /api/v1/notes/:id": { body: { changes: Record<string, unknown>; expectedHash: string }; response: W.LifeObject };
  "POST /api/v1/notes/:id/restore": Guarded & { response: W.LifeObject };
  "DELETE /api/v1/notes/:id": Guarded & { response: unknown };
  "GET /api/v1/notes/:id/purge-check": { response: W.PurgeCheck };
  "DELETE /api/v1/notes/:id/permanent": Guarded & { response: unknown };

  // Objects
  "PUT /api/v1/objects/:id/body": { body: { body: string; expectedHash: string }; response: W.LifeObject };
  "POST /api/v1/objects/:id/assets": { body: { fileName: string; mimeType: string; contentBase64: string }; response: W.StoredAsset };
  "POST /api/v1/objects/:id/archive": Guarded & { response: unknown };
  "POST /api/v1/objects/:id/sensitivity": { body: { sensitivity: "normal" | "restricted"; expectedHash: string }; response: W.LifeObject };
  "GET /api/v1/objects/:id/history": { response: W.HistoryPanel };
  "POST /api/v1/objects/:id/history/restore": { body: { versionPath: string; expectedHash?: string }; response: unknown };
  "POST /api/v1/history/:id/restore": { response: unknown };

  // Entities and people (PB-010, #39, #87)
  "GET /api/v1/entities/:type": { params: { type: W.EntityType }; response: W.LifeObject[] };
  "POST /api/v1/entities/:type": { params: { type: W.EntityType }; body: { fields: Record<string, unknown> }; response: W.LifeObject };
  "PATCH /api/v1/entities/by-id/:id": { body: { fields: Record<string, unknown>; expectedHash: string }; response: W.LifeObject };
  "DELETE /api/v1/entities/by-id/:id": Guarded & { response: unknown };
  "GET /api/v1/people/labels": { response: W.PersonLabel[] };
  "PUT /api/v1/people/:id/external": { body: { isExternal: boolean | null; expectedHash: string }; response: W.LifeObject };
  "POST /api/v1/people/:id/reviewed": Guarded & { response: W.LifeObject };

  // Calendar (#88)
  "GET /api/v1/calendar/events": { query: Range; response: W.CalendarEvent[] };
  "GET /api/v1/calendar/calendars": { response: W.CalendarOption[] };
  "POST /api/v1/calendar/sync": { query: Range; response: unknown };
  "GET /api/v1/calendar/day": { query: Range; response: W.CalendarDay };
  "POST /api/v1/calendar/day/sync": { query: Range; response: W.CalendarDay };

  // Settings (#48, #54, #39, #47, #84)
  "GET /api/v1/settings/calendar-preferences": { response: W.CalendarPreferences };
  "PUT /api/v1/settings/calendar-preferences": { body: { disabledCalendarIds?: string[]; defaultCalendarId?: string; expectedHash?: string }; response: W.CalendarPreferences };
  "GET /api/v1/settings/internal-domains": { response: W.InternalDomains };
  "PUT /api/v1/settings/internal-domains": { body: { domains: string[]; expectedHash?: string }; response: W.InternalDomains };
  "GET /api/v1/settings/self-emails": { response: W.SelfEmails };
  "PUT /api/v1/settings/self-emails": { body: { emails: string[]; expectedHash?: string }; response: W.SelfEmails };
  "GET /api/v1/settings/today": { response: W.TodaySettings };
  "PUT /api/v1/settings/today": { body: { meetingHoursThreshold?: number; briefTime?: string; briefTimeZone?: string; briefDays?: W.Weekday[]; expectedHash?: string }; response: W.TodaySettings };
  "GET /api/v1/settings/daily-focus": { response: W.FocusSettings };
  "PUT /api/v1/settings/daily-focus": { body: { maxMustDos: number; expectedHash?: string }; response: W.FocusSettings };
  "GET /api/v1/settings/backups": { response: W.BackupSettings };
  "PUT /api/v1/settings/backups": { body: { offDriveFolder: string; expectedHash?: string }; response: W.BackupSettings };

  // Connections (#77)
  "GET /api/v1/connections/google": { response: W.GoogleConnection };
  "GET /api/v1/settings/connections": { response: W.ConnectionSettings };
  "POST /api/v1/settings/connections/retry": { response: W.ConnectionSettings };
  "POST /api/v1/settings/connections/google/:provider": { params: { provider: "calendar" | "drive" }; body: { clientId: string; clientSecret: string }; response: { configured: boolean; connected: boolean } };
  "POST /api/v1/connections/google/configure": { body: { clientId: string; clientSecret: string }; response: W.GoogleConnection };
  "GET /api/v1/connections/google/start": { response: { authorizationUrl: string } };

  // Meetings (PB-020)
  "GET /api/v1/meetings/preview": { query: Range & { externalId: string; calendarId?: string }; response: W.Workspace };
  "POST /api/v1/meetings/from-event": { body: Range & { externalId: string; calendarId?: string; body?: string }; response: W.Workspace };
  "GET /api/v1/meetings/from-event/:externalId": { response: unknown };
  "GET /api/v1/meetings/:id/workspace": { response: W.Workspace };

  // Review (#34, #57)
  "GET /api/v1/review-items": { response: W.ReviewItem[] };
  "POST /api/v1/review-items/:id/accept": { body?: { linkTo?: string }; response: unknown };
  "PATCH /api/v1/review-items/:id": { body: W.ReviewEdits; response: unknown };
  "POST /api/v1/review-items/:id/reject": { response: unknown };

  // Today and Daily Focus (#46, #47, #48)
  "GET /api/v1/today": { query: { date?: string }; response: W.Today };
  "GET /api/v1/today/panels": { query: { date?: string; timeZone?: string }; response: W.TodayPanels };
  "POST /api/v1/focus/replan": { body: { date: string }; response: W.Message };
  "POST /api/v1/focus/overrides": { body: W.FocusChange & { date: string; expectedHash?: string }; response: W.DailyFocus };

  // Tasks, capture, knowledge, rollups
  "GET /api/v1/tasks": { response: W.LifeObject[] };
  "PATCH /api/v1/tasks/:id": { body: { changes: Record<string, unknown>; expectedHash: string }; response: W.LifeObject };
  "POST /api/v1/capture": { body: { text: string }; response: W.LifeObject };
  "GET /api/v1/knowledge": { query: { q?: string }; response: W.LifeObject[] };
  "POST /api/v1/sources/text": { body: { title: string; text: string }; response: unknown };
  "GET /api/v1/rollups/:type": { params: { type: "client" | "product" | "person" }; response: W.EntityRollup[] };
  "GET /api/v1/projects": { response: W.ProjectRollup[] };

  // Decisions (#41) and Open Points (#42)
  "GET /api/v1/decisions": { query: ListFilters; response: W.LifeObject[] };
  "GET /api/v1/decisions/:id": { response: W.DecisionDetail };
  "POST /api/v1/decisions": { body: { fields: Record<string, unknown> }; response: W.LifeObject };
  "PATCH /api/v1/decisions/:id": FieldsWrite & { response: W.LifeObject };
  "POST /api/v1/decisions/:id/supersede": FieldsWrite & { response: { decision: W.LifeObject } };
  "GET /api/v1/open-points": { query: ListFilters; response: W.LifeObject[] };
  "GET /api/v1/open-points/:id": { response: W.OpenPointDetail };
  "POST /api/v1/open-points": { body: { fields: Record<string, unknown> }; response: W.LifeObject };
  "PATCH /api/v1/open-points/:id": FieldsWrite & { response: W.LifeObject };
  "POST /api/v1/open-points/:id/resolve": FieldsWrite & { response: unknown };
  "POST /api/v1/open-points/:id/resolve-with-decision": FieldsWrite & { response: unknown };
  "POST /api/v1/open-points/:id/close": FieldsWrite & { response: unknown };

  // Inbox (ADR 0007), enrichment (#44) and patches (#37)
  "GET /api/v1/inbox/drafts": { response: W.InboxStatus };
  "POST /api/v1/inbox/adopt": { response: W.AdoptionBatch };
  "GET /api/v1/enrichment": { response: W.EnrichmentStatus };
  "POST /api/v1/enrichment/work-orders": { response: W.Message };
  "POST /api/v1/meetings/:id/enrichment/gave-up": Guarded & { response: unknown };
  "GET /api/v1/inbox/patches": { response: W.AppliedPatch[] };
  "POST /api/v1/inbox/patches/:id/undo": { response: unknown };

  // Backups (#84, #95)
  "GET /api/v1/backups": { response: W.BackupSummary[] };
  "POST /api/v1/backups": { response: W.BackupSummary };
  "GET /api/v1/backups/status": { response: unknown };
  "POST /api/v1/backups/:id/verify": { response: W.BackupVerification };
}

export type Endpoint = keyof Endpoints;
export type Method<E extends Endpoint> = E extends `${infer M} ${string}` ? M : never;
export type PathOf<E extends Endpoint> = E extends `${string} ${infer P}` ? P : never;

type ParamNames<Path extends string> =
  Path extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Name}` ? Name : never;
type Spec<E extends Endpoint> = Endpoints[E];

/** The path parameters: each `:name` as a string, unless the entry narrows them with `params`. */
export type ParamsOf<E extends Endpoint> = Spec<E> extends { params: infer P } ? P : { [K in ParamNames<PathOf<E>>]: string };
export type QueryOf<E extends Endpoint> = Spec<E> extends { query: infer Q } ? Q : Record<string, never>;
/** The request body; `undefined` when the endpoint takes none or it may be left out. */
export type BodyOf<E extends Endpoint> = "body" extends keyof Spec<E>
  ? (object extends Pick<Spec<E>, "body" & keyof Spec<E>> ? Spec<E>["body" & keyof Spec<E>] | undefined : Spec<E>["body" & keyof Spec<E>])
  : undefined;
export type ResponseOf<E extends Endpoint> = Spec<E>["response"];

/** What a caller passes: `params` when the path has any, `query` when the endpoint takes one, `body` when it takes one. */
export type RequestOf<E extends Endpoint> =
  ([ParamNames<PathOf<E>>] extends [never] ? unknown : { params: ParamsOf<E> }) &
  ("query" extends keyof Spec<E> ? { query?: QueryOf<E> } : unknown) &
  ("body" extends keyof Spec<E> ? (undefined extends BodyOf<E> ? { body?: BodyOf<E> } : { body: BodyOf<E> }) : unknown);
