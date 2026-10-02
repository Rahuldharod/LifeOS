import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOSApplication } from "@lifeos/application";
import { GoogleAuthError, GoogleCalendarConnector } from "@lifeos/connectors";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { MemorySecretStore } from "@lifeos/secrets";
import { httpError } from "../../apps/server/src/http-errors.js";

// PB-022a: an expired or revoked Google token must surface as a reconnect prompt, never as an empty calendar.

const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const invalidGrant = () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);

/** Routes Google endpoints; `token` decides what the OAuth token endpoint answers. */
function mockGoogle(token: () => Response) {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return token();
    if (url.includes("/users/me/calendarList")) return json({ items: [{ id: "primary", summary: "Work", selected: true }] });
    if (url.includes("/calendars/primary/events")) return json({ items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function connectorWithExpiredAccessToken() {
  const secrets = new MemorySecretStore();
  await secrets.set("google:default:tokens", JSON.stringify({ access_token: "stale", refresh_token: "refresh", expires_at: 0 }));
  const connector = new GoogleCalendarConnector({ clientId: "client.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:4310/api/v1/connections/google/callback", secrets });
  return { secrets, connector };
}

describe("Google token failure (PB-022a)", () => {
  it("throws a typed GoogleAuthError on invalid_grant and reports connected=false with reason expired", async () => {
    const { connector } = await connectorWithExpiredAccessToken();
    expect(await connector.status()).toEqual({ configured: true, connected: true, provider: "google" });

    mockGoogle(invalidGrant);
    const failure = await connector.listEvents(new Date("2026-10-02T00:00:00Z"), new Date("2026-10-03T00:00:00Z")).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GoogleAuthError);
    expect(failure).toMatchObject({ name: "GoogleAuthError", reason: "expired", reconnect: true });
    expect(await connector.status()).toEqual({ configured: true, connected: false, provider: "google", reason: "expired" });

    // A later successful refresh clears the failure.
    mockGoogle(() => json({ access_token: "fresh", expires_in: 3600 }));
    await connector.listEvents(new Date("2026-10-02T00:00:00Z"), new Date("2026-10-03T00:00:00Z"));
    expect(await connector.status()).toEqual({ configured: true, connected: true, provider: "google" });
  });

  it("treats a 401 from the Calendar API as an auth failure", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("google:default:tokens", JSON.stringify({ access_token: "revoked", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 }));
    const connector = new GoogleCalendarConnector({ clientId: "client.apps.googleusercontent.com", redirectUri: "http://127.0.0.1:4310/cb", secrets });
    globalThis.fetch = vi.fn(async () => json({ error: { message: "Invalid Credentials" } }, 401)) as typeof fetch;
    await expect(connector.listEvents(new Date(), new Date(Date.now() + 86_400_000))).rejects.toBeInstanceOf(GoogleAuthError);
    expect((await connector.status()).reason).toBe("expired");
  });

  it("propagates the error to callers, keeps the last successful sync time and throttles repeated failed Sync Runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-google-auth-"));
    roots.push(root);
    const { secrets, connector } = await connectorWithExpiredAccessToken();
    const application = new LifeOSApplication(new MarkdownObjectStore(root), new MemoryIndex(), connector, undefined, "integration-test");
    await application.rebuildIndex();
    await application.recordGoogleConnection();
    const from = new Date("2026-10-02T00:00:00Z");
    const to = new Date("2026-10-03T00:00:00Z");
    const syncRuns = async () => (await readdir(path.join(root, "sync-runs"))).length;

    mockGoogle(() => json({ access_token: "fresh", expires_in: 3600 }));
    await expect(application.syncCalendar(from, to)).resolves.toEqual([]);
    const { lastSuccessfulSyncAt } = application.calendarSyncStatus();
    expect(lastSuccessfulSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Google revokes the refresh token.
    await secrets.set("google:default:tokens", JSON.stringify({ access_token: "stale", refresh_token: "refresh", expires_at: 0 }));
    mockGoogle(invalidGrant);
    await expect(application.syncCalendar(from, to)).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(application.syncCalendar(from, to)).rejects.toBeInstanceOf(GoogleAuthError);
    // Viewing a day must fail too, so the timeline can never claim the calendar is clear.
    await expect(application.listCalendarEvents(from, to)).rejects.toBeInstanceOf(GoogleAuthError);
    expect(await syncRuns()).toBe(2);
    expect(application.calendarSyncStatus()).toEqual({ lastSuccessfulSyncAt, lastError: expect.stringContaining("expired or was revoked") });

    // After the throttle window an identical failure is recorded again.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61 * 60 * 1000 });
    await expect(application.syncCalendar(from, to)).rejects.toBeInstanceOf(GoogleAuthError);
    expect(await syncRuns()).toBe(3);
  });

  it("maps GoogleAuthError to HTTP 401 with a reconnect flag", () => {
    expect(httpError(new GoogleAuthError("Google Calendar access expired", "expired"))).toEqual({
      statusCode: 401,
      body: { error: "Google Calendar access expired", reconnect: true, reason: "expired" }
    });
    expect(httpError(new Error("Enter a valid calendar date range")).statusCode).toBe(400);
  });
});
