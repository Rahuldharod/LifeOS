// Thin fetch wrapper for the local Fastify API, shared by main.tsx and the note draft controller.
// Also tracks whether the server is reachable (PB-001): a restart via `pnpm update-app` takes a few
// seconds, during which the UI shows "Reconnecting…" and autosave retries once the server is back.
// #121: every call names its endpoint by its wire-contract key, so its params, query, body and answer are
// type-checked against @lifeos/contracts, the same declaration the server's routes are checked against.
import { useSyncExternalStore } from "react";
import type { Endpoint, QueryOf, RequestOf, ResponseOf } from "@lifeos/contracts";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** `reconnects` increments each time the server comes back, so effects can retry on it. */
export type ServerConnection = { online: boolean; reconnects: number };

let connection: ServerConnection = { online: true, reconnects: 0 };
const listeners = new Set<() => void>();
let probe: ReturnType<typeof setInterval> | undefined;

function setConnection(next: ServerConnection) {
  connection = next;
  listeners.forEach((listener) => listener());
}

function markOnline() {
  if (connection.online) return;
  clearInterval(probe); probe = undefined;
  setConnection({ online: true, reconnects: connection.reconnects + 1 });
}

function markOffline() {
  if (!connection.online) return;
  setConnection({ ...connection, online: false });
  probe = setInterval(() => {
    void fetch("/api/v1/health").then((response) => { if (response.ok) markOnline(); }, () => undefined);
  }, 2000);
}

export function currentServerConnection(): ServerConnection { return connection; }

export function useServerConnection(): ServerConnection {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, currentServerConnection);
}

/**
 * What a call passes: path `params`, `query` and `body` as the contract declares them. A query may also be a
 * ready-made `URLSearchParams` (the list filters build theirs); its keys are then not checked.
 */
export type ApiInput<E extends Endpoint> = Omit<RequestOf<E>, "query"> & ("query" extends keyof RequestOf<E> ? { query?: QueryOf<E> | URLSearchParams } : unknown);
/** The input may be left out when the endpoint needs no params and no body. */
type ApiArgs<E extends Endpoint> = Record<string, never> extends ApiInput<E> ? [input?: ApiInput<E>] : [input: ApiInput<E>];

/** The endpoint's URL: each `:name` replaced by its (encoded) value, then the query without its undefined values. */
export function endpointUrl(path: string, params: Record<string, string> = {}, query?: Record<string, string | string[] | undefined> | URLSearchParams) {
  const filled = path.replace(/:([A-Za-z]+)/g, (_match, name: string) => encodeURIComponent(params[name] ?? ""));
  let search = query instanceof URLSearchParams ? query : undefined;
  if (query && !(query instanceof URLSearchParams)) {
    search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const item of [value ?? []].flat()) search.append(key, item);
  }
  const text = search?.toString();
  return text ? `${filled}?${text}` : filled;
}

/** Calls one endpoint of the wire contract, e.g. `api("POST /api/v1/notes/:id/restore", { params: { id }, body: { expectedHash } })`. */
export async function api<E extends Endpoint>(endpoint: E, ...[input]: ApiArgs<E>): Promise<ResponseOf<E>> {
  const space = endpoint.indexOf(" ");
  const { params, query, body } = (input ?? {}) as { params?: Record<string, string>; query?: Record<string, string | string[] | undefined> | URLSearchParams; body?: unknown };
  return request(endpointUrl(endpoint.slice(space + 1), params, query), endpoint.slice(0, space), body === undefined ? undefined : JSON.stringify(body)) as Promise<ResponseOf<E>>;
}

/** The type of `api`, for helpers that take it as a dependency so tests can pass a fake. */
export type Api = typeof api;

async function request(url: string, method: string, body: string | undefined): Promise<unknown> {
  const headers = body ? { "content-type": "application/json" } : undefined;
  let response: Response;
  try { response = await fetch(url, { method, body, headers }); }
  catch {
    // fetch only rejects when the server cannot be reached at all.
    markOffline();
    throw new ApiError("LifeOS server is not reachable", 0);
  }
  const payload = await response.json().catch(() => undefined);
  if (payload === undefined) {
    // The dev proxy answers 5xx with no JSON body while the API is down.
    if (response.status >= 500) { markOffline(); throw new ApiError("LifeOS server is not reachable", 0); }
    throw new ApiError(`Request failed: ${response.status}`, response.status);
  }
  markOnline();
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed: ${response.status}`, response.status);
  return payload;
}
