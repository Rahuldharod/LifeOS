// The start script: reads the environment, picks the real adapters, builds the API (./api.ts), runs its startup
// (which listens before starting background work) and stops cleanly on SIGINT/SIGTERM. Routes, lease wiring and background work live in the API module.
import os from "node:os";
import { fileURLToPath } from "node:url";
import { GoogleCalendarConnector, MockCalendarConnector } from "@lifeos/connectors";
import { exitUnlessDataRoot, resolveBackupRoot, resolveDataRoot } from "@lifeos/object-store-markdown";
import { KnownSecrets, MacOSKeychainSecretStore } from "@lifeos/secrets";
import { buildApi } from "./api.js";
import { calendarSource } from "./calendar-source.js";
import { secretRefs } from "./connections.js";
import { idleReleaseMs } from "./lease.js";

const host = process.env.LIFEOS_HOST ?? "127.0.0.1";
const port = Number(process.env.LIFEOS_PORT ?? 4310);
const deviceId = process.env.LIFEOS_DEVICE_ID ?? os.hostname();
// ADR 0014: the data lives in Google Drive and is found only through LIFEOS_DATA_ROOT. Before anything else runs
// (Keychain, lease, index), refuse to start unless that folder holds `.lifeos/schema.md`.
const dataRoot = await exitUnlessDataRoot(resolveDataRoot());
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI ?? `http://${host}:${port}/api/v1/connections/google/callback`;

// #77: status is answered from what KnownSecrets has seen, so loads and saves never show a Keychain prompt.
const secrets = new KnownSecrets(new MacOSKeychainSecretStore());
if (process.env.GOOGLE_CLIENT_SECRET) await secrets.set(secretRefs.calendarClientSecret, process.env.GOOGLE_CLIENT_SECRET);
if (process.env.GOOGLE_CLIENT_ID) await secrets.set(secretRefs.calendarClientId, process.env.GOOGLE_CLIENT_ID);
// Dev mode (PB-001) forces the mock calendar: Google's OAuth callback belongs to the stable app on 4310. It reads no secret at startup.
// #94: outside dev mode the mock never answers; a denied Keychain makes calendar reads offline (stored meetings + banner).
const calendars = calendarSource({ secrets, mockOnly: process.env.LIFEOS_CALENDAR === "mock", mock: new MockCalendarConnector(), createGoogle: (clientId) => new GoogleCalendarConnector({ clientId, redirectUri: googleRedirectUri, secrets }) });
/** Startup and Retry: the only reads made just to know what is configured. A denied prompt leaves the card showing Retry. */
await calendars.probe().catch((error) => console.error("Could not read Google connection secrets", error));

const api = await buildApi({
  dataRoot,
  backupRoot: resolveBackupRoot(),
  deviceId,
  secrets,
  calendars,
  idleReleaseMs: idleReleaseMs(),
  // The launcher points LIFEOS_WEB_ROOT at its own snapshot of the build, so a later `pnpm build` cannot change the running app.
  webRoot: process.env.LIFEOS_WEB_ROOT ?? fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  logger: true
});

try {
  const running = await api.start(() => api.server.listen({ host, port }));
  const shutdown = async () => {
    await running.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  api.server.log.error(error);
  process.exit(1);
}
