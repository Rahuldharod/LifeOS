// ADR 0022: the running build's identity, written into every App Feedback file. The version has one source, the root
// `package.json`; the commit is the short git commit of the checkout the server runs from. Either falls back to "unknown".
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppInfo } from "@lifeos/application";

const codeRoot = fileURLToPath(new URL("../../../", import.meta.url));

export function readAppInfo(root = codeRoot): AppInfo {
  let version = "unknown";
  try {
    const parsed = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) version = parsed.version;
  } catch { /* keep "unknown" */ }
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"; }
  catch { /* not a git checkout */ }
  return { version, commit };
}
