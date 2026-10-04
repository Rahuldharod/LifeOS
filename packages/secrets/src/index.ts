import type { SecretStore } from "@lifeos/application";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(reference: string) { return this.values.get(reference); }
  async set(reference: string, value: string) { this.values.set(reference, value); }
}

export interface KeychainHelperOptions {
  /** Defaults to the current user's home; tests pass a temporary folder. */
  homeDir?: string;
  /** Swift source text; defaults to the bundled `keychain-helper.swift`. */
  source?: string;
  /** Compiles `sourcePath` to `outputPath`; defaults to `/usr/bin/swiftc`. */
  compile?: (sourcePath: string, outputPath: string) => Promise<void>;
  /** The uid the helper must be owned by; defaults to the current process uid. */
  uid?: number;
}

const bundledSource = fileURLToPath(new URL("../keychain-helper.swift", import.meta.url));
const swiftc = async (sourcePath: string, outputPath: string) => { await execFileAsync("/usr/bin/swiftc", [sourcePath, "-o", outputPath]); };

/**
 * Returns the path of a verified Keychain helper, building it first when needed.
 * The helper lives in an owner-only folder under Application Support and is named by a hash of its source,
 * so a planted, tampered or stale binary is never executed (issue #23).
 */
export async function ensureKeychainHelper(options: KeychainHelperOptions = {}) {
  const uid = options.uid ?? process.getuid!();
  const source = options.source ?? await readFile(bundledSource, "utf8");
  const folder = path.join(options.homeDir ?? homedir(), "Library", "Application Support", "LifeOS", "keychain-helper");
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const binary = path.join(folder, `keychain-helper-${hash}`);

  await mkdir(folder, { recursive: true, mode: 0o700 });
  const folderStat = await lstat(folder);
  if (!folderStat.isDirectory() || folderStat.uid !== uid) throw new Error(`Keychain helper folder ${folder} is not owned by the current user; refusing to use it.`);
  if ((folderStat.mode & 0o077) !== 0) await chmod(folder, 0o700);

  if (await isTrusted(binary, uid)) return binary;
  // One rebuild at a time per binary, so a parallel call never deletes a helper another call just built.
  let pending = rebuilds.get(binary);
  if (!pending) {
    pending = rebuild(binary, source, uid, options.compile ?? swiftc).finally(() => rebuilds.delete(binary));
    rebuilds.set(binary, pending);
  }
  await pending;
  return binary;
}

const rebuilds = new Map<string, Promise<void>>();

async function rebuild(binary: string, source: string, uid: number, compile: NonNullable<KeychainHelperOptions["compile"]>) {
  await rm(binary, { force: true });
  await build(source, binary, compile);
  if (!await isTrusted(binary, uid)) throw new Error(`Keychain helper ${binary} is not owned by the current user or is writable by others; refusing to run it.`);
  await removeStaleHelpers(path.dirname(binary), path.basename(binary));
}

async function isTrusted(binary: string, uid: number) {
  const info = await lstat(binary).catch(() => undefined);
  return Boolean(info?.isFile() && info.uid === uid && (info.mode & 0o022) === 0);
}

async function build(source: string, binary: string, compile: NonNullable<KeychainHelperOptions["compile"]>) {
  const temporary = `${binary}.${randomUUID()}.tmp`;
  const sourcePath = `${temporary}.swift`;
  try {
    // swiftc reads the source from the same owner-only folder.
    await writeFile(sourcePath, source, { mode: 0o600 });
    await compile(sourcePath, temporary);
    await chmod(temporary, 0o700);
    await rename(temporary, binary);
  } finally {
    await rm(temporary, { force: true });
    await rm(sourcePath, { force: true });
  }
}

async function removeStaleHelpers(folder: string, current: string) {
  const entries = await readdir(folder);
  await Promise.all(entries
    .filter((entry) => /^keychain-helper-[0-9a-f]{16}$/.test(entry) && entry !== current)
    .map((entry) => rm(path.join(folder, entry), { force: true })));
}

export class MacOSKeychainSecretStore implements SecretStore {
  constructor(private readonly service = "com.lifeos.local", private readonly helper: KeychainHelperOptions = {}) {}

  async get(reference: string) {
    const binary = await ensureKeychainHelper(this.helper);
    try {
      const { stdout } = await execFileAsync(binary, ["get", this.service, reference], { encoding: "buffer" });
      return stdout.toString("utf8") || undefined;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 44) return undefined;
      throw error;
    }
  }

  async set(reference: string, value: string) {
    const binary = await ensureKeychainHelper(this.helper);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["set", this.service, reference], { stdio: ["pipe", "ignore", "pipe"] });
      let errorOutput = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { errorOutput += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Keychain write failed (${code}): ${errorOutput.trim()}`)));
      child.stdin.end(value);
    });
  }
}
