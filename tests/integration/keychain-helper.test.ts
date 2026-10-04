import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureKeychainHelper, MacOSKeychainSecretStore } from "@lifeos/secrets";

// Issue #23: the Keychain helper must live in a user-private folder and be verified before every run.
// These tests use a temporary home and a fake compiler, so the real Keychain is never touched.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "lifeos-keychain-home-"));
  roots.push(home);
  return home;
}

/** Fake `swiftc`: writes a shell script that stores values as files beside the helper. */
function fakeCompiler() {
  const calls: string[] = [];
  const compile = async (_source: string, output: string) => {
    calls.push(output);
    const store = path.join(path.dirname(output), "fake-store");
    await writeFile(output, [
      "#!/bin/sh",
      `mkdir -p '${store}'`,
      `if [ "$1" = get ]; then [ -f '${store}'/"$3" ] || exit 44; cat '${store}'/"$3"; fi`,
      `if [ "$1" = set ]; then cat > '${store}'/"$3"; fi`,
    ].join("\n"), { mode: 0o755 });
  };
  return { compile, calls };
}

const helperFolder = (home: string) => path.join(home, "Library", "Application Support", "LifeOS", "keychain-helper");

describe("Keychain helper location and verification", () => {
  it("builds a fresh helper into an owner-only folder under Application Support", async () => {
    const home = await tempHome();
    const { compile, calls } = fakeCompiler();
    const binary = await ensureKeychainHelper({ homeDir: home, compile });

    expect(path.dirname(binary)).toBe(helperFolder(home));
    expect(path.basename(binary)).toMatch(/^keychain-helper-[0-9a-f]{16}$/);
    // Never directly in the shared temp folder; the fake home itself may live under /tmp on Linux CI.
    expect(path.dirname(binary)).not.toBe(tmpdir());
    expect(path.relative(home, binary).startsWith("..")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(path.dirname(calls[0]!)).toBe(helperFolder(home));
    expect(calls[0]).not.toBe(binary); // compiled to a temporary name, then renamed into place
    expect((await stat(helperFolder(home))).mode & 0o777).toBe(0o700);
    expect((await stat(binary)).mode & 0o077).toBe(0);
    expect(await readdir(helperFolder(home))).toEqual([path.basename(binary)]);
  });

  it("reuses a valid helper without recompiling", async () => {
    const home = await tempHome();
    const { compile, calls } = fakeCompiler();
    const first = await ensureKeychainHelper({ homeDir: home, compile });
    const second = await ensureKeychainHelper({ homeDir: home, compile });
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("deletes and rebuilds a helper that is group- or world-writable", async () => {
    const home = await tempHome();
    const { compile, calls } = fakeCompiler();
    const binary = await ensureKeychainHelper({ homeDir: home, compile });
    await chmod(binary, 0o777);
    await ensureKeychainHelper({ homeDir: home, compile });
    expect(calls).toHaveLength(2);
    expect((await stat(binary)).mode & 0o077).toBe(0);
  });

  it("refuses a helper owned by someone else with a clear error", async () => {
    const home = await tempHome();
    const { compile } = fakeCompiler();
    // Pretend the current user is someone else, so every file on disk looks foreign.
    await expect(ensureKeychainHelper({ homeDir: home, compile, uid: process.getuid!() + 1 }))
      .rejects.toThrow(/Keychain helper .* is not owned by the current user/);
  });

  it("rebuilds when the helper source changes", async () => {
    const home = await tempHome();
    const { compile, calls } = fakeCompiler();
    const first = await ensureKeychainHelper({ homeDir: home, compile, source: "print(1)" });
    const second = await ensureKeychainHelper({ homeDir: home, compile, source: "print(2)" });
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("keeps secret get/set behaviour through the verified helper", async () => {
    const home = await tempHome();
    const { compile } = fakeCompiler();
    const secrets = new MacOSKeychainSecretStore("com.lifeos.test", { homeDir: home, compile });
    expect(await secrets.get("google:default:tokens")).toBeUndefined();
    await secrets.set("google:default:tokens", "{\"refresh_token\":\"r\"}");
    expect(await secrets.get("google:default:tokens")).toBe("{\"refresh_token\":\"r\"}");
  });
});
