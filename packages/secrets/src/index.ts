import type { SecretStore } from "@lifeos/application";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(reference: string) { return this.values.get(reference); }
  async set(reference: string, value: string) { this.values.set(reference, value); }
}

export class MacOSKeychainSecretStore implements SecretStore {
  private readonly helperSource = fileURLToPath(new URL("../keychain-helper.swift", import.meta.url));
  private readonly helperBinary = "/private/tmp/lifeos-keychain-helper-v1";
  private helperReady?: Promise<void>;
  constructor(private readonly service = "com.lifeos.local") {}

  async get(reference: string) {
    await this.ensureHelper();
    try {
      const { stdout } = await execFileAsync(this.helperBinary, ["get", this.service, reference], { encoding: "buffer" });
      return stdout.toString("utf8") || undefined;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 44) return undefined;
      throw error;
    }
  }

  async set(reference: string, value: string) {
    await this.ensureHelper();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.helperBinary, ["set", this.service, reference], { stdio: ["pipe", "ignore", "pipe"] });
      let errorOutput = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { errorOutput += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Keychain write failed (${code}): ${errorOutput.trim()}`)));
      child.stdin.end(value);
    });
  }

  private ensureHelper() {
    this.helperReady ??= (async () => {
      const exists = await access(this.helperBinary).then(() => true).catch(() => false);
      if (!exists) await execFileAsync("/usr/bin/swiftc", [this.helperSource, "-o", this.helperBinary]);
    })();
    return this.helperReady;
  }
}
