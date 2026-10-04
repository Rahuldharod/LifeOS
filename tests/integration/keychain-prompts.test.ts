import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretStore } from "@lifeos/application";
import { GoogleCalendarConnector } from "@lifeos/connectors";
import { isKeychainAccessDenied, KeychainAccessDeniedError, KnownSecrets, MacOSKeychainSecretStore, MemorySecretStore } from "@lifeos/secrets";
import { connectionSettings, googleConnectionStatus, probeConnectionSecrets, secretRefs } from "../../apps/server/src/connections.js";
import { httpError } from "../../apps/server/src/http-errors.js";

// #77: Keychain pop-ups only when a secret is really needed. Status must never read secret values;
// a denied prompt (-128) is a typed state, not a crash. Only fakes are used: never the real Keychain or helper.

/** Counts every value read, and can answer like a user who clicks Deny. */
class CountingSecretStore implements SecretStore {
  readonly reads: string[] = [];
  deny = false;
  constructor(private readonly inner = new MemorySecretStore()) {}
  async get(reference: string) {
    this.reads.push(reference);
    if (this.deny) throw new KeychainAccessDeniedError();
    return this.inner.get(reference);
  }
  async set(reference: string, value: string) { await this.inner.set(reference, value); }
}

async function seeded(values: Record<string, string>) {
  const inner = new CountingSecretStore();
  for (const [reference, value] of Object.entries(values)) await inner.set(reference, value);
  return inner;
}

const clientId = "example.apps.googleusercontent.com";
const sync = { lastSuccessfulSyncAt: undefined };

describe("connection status never reads secret values (#77)", () => {
  it("knows configured and connected from the startup probe, then reads nothing on every status call", async () => {
    const inner = await seeded({ [secretRefs.calendarClientId]: clientId, [secretRefs.calendarClientSecret]: "s", [secretRefs.calendarTokens]: "{\"refresh_token\":\"r\"}", [secretRefs.driveClientId]: clientId, [secretRefs.driveClientSecret]: "s" });
    const secrets = new KnownSecrets(inner);
    expect(await probeConnectionSecrets(secrets)).toBe(clientId);
    const google = new GoogleCalendarConnector({ clientId, redirectUri: "http://127.0.0.1/callback", secrets });
    const readsAfterStartup = inner.reads.length;
    // The client secrets are never read at startup: only a connect or sync needs them.
    expect(inner.reads).not.toContain(secretRefs.calendarClientSecret);
    expect(inner.reads).not.toContain(secretRefs.driveClientSecret);

    for (let load = 0; load < 5; load += 1) {
      expect(connectionSettings(secrets, google, sync)).toMatchObject({ calendar: { configured: true, connected: true }, drive: { configured: true, connected: false }, keychain: "ok" });
      expect(googleConnectionStatus(secrets, google, sync)).toMatchObject({ configured: true, connected: true, provider: "google" });
    }
    expect(inner.reads).toHaveLength(readsAfterStartup);
  });

  it("reports nothing configured, with no reads, when no secret was ever seen (dev mode skips the probe)", async () => {
    const inner = await seeded({ [secretRefs.calendarClientId]: clientId });
    const secrets = new KnownSecrets(inner);
    expect(connectionSettings(secrets, undefined, sync)).toMatchObject({ calendar: { configured: false, connected: false }, drive: { configured: false }, keychain: "ok" });
    expect(googleConnectionStatus(secrets, undefined, sync)).toMatchObject({ configured: false, connected: false, provider: "mock" });
    expect(inner.reads).toEqual([]);
  });

  it("updates configured and connected when secrets are saved, without reading them back", async () => {
    const inner = await seeded({});
    const secrets = new KnownSecrets(inner);
    await probeConnectionSecrets(secrets);
    const before = inner.reads.length;
    await secrets.set(secretRefs.driveClientId, clientId);
    await secrets.set(secretRefs.driveClientSecret, "s");
    await secrets.set(secretRefs.calendarClientId, clientId);
    await secrets.set(secretRefs.calendarClientSecret, "s");
    const google = new GoogleCalendarConnector({ clientId, redirectUri: "http://127.0.0.1/callback", secrets });
    expect(connectionSettings(secrets, google, sync)).toMatchObject({ calendar: { configured: true, connected: false }, drive: { configured: true } });
    await secrets.set(secretRefs.calendarTokens, "{\"refresh_token\":\"r\"}"); // what completing the OAuth consent writes
    expect(connectionSettings(secrets, google, sync).calendar.connected).toBe(true);
    expect(inner.reads).toHaveLength(before);
  });

  it("reads only the calendar client ID when the calendar is not configured", async () => {
    const inner = await seeded({});
    await probeConnectionSecrets(new KnownSecrets(inner));
    expect(inner.reads).toEqual([secretRefs.calendarClientId, secretRefs.driveClientId]);
  });
});

describe("a denied Keychain prompt (-128) is a typed state (#77)", () => {
  it("does not fail the startup probe; status shows 'denied' until a retry succeeds", async () => {
    const inner = await seeded({ [secretRefs.calendarClientId]: clientId, [secretRefs.calendarClientSecret]: "s" });
    const secrets = new KnownSecrets(inner);
    inner.deny = true;
    expect(await probeConnectionSecrets(secrets)).toBeUndefined();
    expect(connectionSettings(secrets, undefined, sync)).toMatchObject({ calendar: { configured: false, connected: false }, keychain: "denied" });
    expect(googleConnectionStatus(secrets, undefined, sync)).toMatchObject({ keychain: "denied" });

    inner.deny = false; // the user clicks Retry and allows access
    expect(await probeConnectionSecrets(secrets)).toBe(clientId);
    expect(connectionSettings(secrets, undefined, sync)).toMatchObject({ calendar: { configured: true }, keychain: "ok" });
  });

  it("a denial during a sync marks the Connections card denied and answers 403, not a crash", async () => {
    const inner = await seeded({ [secretRefs.calendarClientId]: clientId, [secretRefs.calendarTokens]: "{\"refresh_token\":\"r\"}" });
    const secrets = new KnownSecrets(inner);
    await probeConnectionSecrets(secrets);
    const google = new GoogleCalendarConnector({ clientId, redirectUri: "http://127.0.0.1/callback", secrets });
    inner.deny = true;
    const failure = await google.listCalendars().catch((error: unknown) => error);
    expect(isKeychainAccessDenied(failure)).toBe(true);
    expect(httpError(failure)).toEqual({ statusCode: 403, body: { error: "Keychain access denied", reason: "keychain-denied" } });
    expect(connectionSettings(secrets, google, sync).keychain).toBe("denied");
    // What was known stays known: the card still says configured and connected.
    expect(connectionSettings(secrets, google, sync).calendar).toMatchObject({ configured: true, connected: true });
  });
});

describe("MacOSKeychainSecretStore maps errSecUserCanceled (-128) to KeychainAccessDeniedError (#77)", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  /** Fake `swiftc`: the "helper" answers like the real one when the user clicks Deny. */
  const denyingCompiler = async (_source: string, output: string) => {
    await writeFile(output, ["#!/bin/sh", "if [ \"$1\" = get ]; then echo 'Keychain lookup failed (-128)' >&2; exit 1; fi", "cat > /dev/null; echo 'Keychain update failed (-128)' >&2; exit 1"].join("\n"), { mode: 0o755 });
  };
  const failingCompiler = async (_source: string, output: string) => {
    await writeFile(output, ["#!/bin/sh", "echo 'Keychain lookup failed (-25293)' >&2; exit 1"].join("\n"), { mode: 0o755 });
  };

  it("throws a typed denial for get and set", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "lifeos-keychain-denied-"));
    roots.push(home);
    const store = new MacOSKeychainSecretStore("com.lifeos.test", { homeDir: home, compile: denyingCompiler });
    const read = await store.get("google:default:tokens").catch((error: unknown) => error);
    expect(read).toBeInstanceOf(KeychainAccessDeniedError);
    expect((read as Error).message).toBe("Keychain access denied");
    expect(await store.set("google:default:tokens", "x").catch((error: unknown) => error)).toBeInstanceOf(KeychainAccessDeniedError);
  });

  it("keeps other Keychain failures as ordinary errors", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "lifeos-keychain-failed-"));
    roots.push(home);
    const store = new MacOSKeychainSecretStore("com.lifeos.test", { homeDir: home, compile: failingCompiler });
    const read = await store.get("google:default:tokens").catch((error: unknown) => error);
    expect(isKeychainAccessDenied(read)).toBe(false);
    expect(read).toBeInstanceOf(Error);
  });
});
