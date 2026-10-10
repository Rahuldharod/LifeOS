// #120: the localhost API built for a test: a temporary data root (with `.lifeos/schema.md`), a temporary backup root,
// the mock calendar and an in-memory secret store, called through Fastify's inject (no port is opened).
// Importing this file registers the cleanup: started APIs are stopped and the temporary roots removed after each test.
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { MockCalendarConnector } from "@lifeos/connectors";
import { KnownSecrets, MemorySecretStore } from "@lifeos/secrets";
import { buildApi, type ApiOptions, type LifeOSApi } from "../../apps/server/src/api.js";
import { calendarSource } from "../../apps/server/src/calendar-source.js";

const roots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];
const apis: LifeOSApi[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((background) => background.stop()));
  await Promise.all(apis.splice(0).map((api) => api.server.close()));
  await Promise.all(roots.splice(0).map(async (root) => { await makeWritable(root); await rm(root, { recursive: true, force: true }); }));
});

/** Backup snapshots are read-only. */
async function makeWritable(root: string) {
  await chmod(root, 0o755).catch(() => undefined);
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) await makeWritable(fullPath);
    else await chmod(fullPath, 0o644).catch(() => undefined);
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Builds the API over a data root holding `files` (relative path → content). Call `start()` for the startup work. */
export async function testApi(options: Partial<ApiOptions> & { files?: Record<string, string> } = {}) {
  const { files = {}, ...overrides } = options;
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-api-"));
  const backupRoot = await mkdtemp(path.join(tmpdir(), "lifeos-api-backups-"));
  roots.push(root, backupRoot);
  for (const [relativePath, content] of Object.entries({ ".lifeos/schema.md": "# LifeOS\n", ...files })) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  const secrets = new KnownSecrets(new MemorySecretStore());
  const calendars = calendarSource({ secrets, mockOnly: true, mock: new MockCalendarConnector(), createGoogle: () => { throw new Error("No Google Calendar in tests"); } });
  const api = await buildApi({ dataRoot: root, backupRoot, deviceId: "desk-mac", secrets, calendars, idleReleaseMs: 15 * 60_000, webRoot: path.join(root, "no-web-build"), ...overrides });
  apis.push(api);
  const start = async () => { const background = await api.start(); running.push(background); return background; };
  const get = (url: string) => api.server.inject({ method: "GET", url });
  const send = (method: Exclude<Method, "GET">, url: string, payload: object = {}) => api.server.inject({ method, url, payload });
  /** The web client's call (`apps/web/src/api.ts`): JSON in and out, and the server's error message thrown on 4xx/5xx. */
  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await api.server.inject({ method: (init?.method ?? "GET") as Method, url, ...(init?.body ? { payload: String(init.body), headers: { "content-type": "application/json" } } : {}) });
    const payload = response.json() as T & { error?: string };
    if (response.statusCode >= 400) throw new Error(payload.error ?? `Request failed: ${response.statusCode}`);
    return payload;
  };
  return { root, api, start, get, send, call };
}
