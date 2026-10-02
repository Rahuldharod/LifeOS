// Thin fetch wrapper for the local Fastify API, shared by main.tsx and the note draft controller.
// Also tracks whether the server is reachable (PB-001): a restart via `pnpm update-app` takes a few
// seconds, during which the UI shows "Reconnecting…" and autosave retries once the server is back.
import { useSyncExternalStore } from "react";

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

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = options?.body ? { "content-type": "application/json" } : undefined;
  let response: Response;
  try { response = await fetch(url, { ...options, headers }); }
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
  return payload as T;
}
