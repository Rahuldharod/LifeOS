// ADR 0022, #208: the running build's identity, shown on the System page and written into every App Feedback file.
// The App version comes from git history (`appVersion`); the commit is the short git commit of the checkout. Both fall
// back to "unknown" outside a git checkout. The web build calls this too, so the UI carries the version it was built from.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appVersion, type MainCommit } from "@lifeos/shared";

const codeRoot = fileURLToPath(new URL("../../../", import.meta.url));

function git(root: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
  catch { return undefined; }
}

/** `origin/main` when the checkout has it (CI, agent worktrees), else the local `main`. */
function mainRef(root: string) {
  return git(root, ["rev-parse", "--verify", "--quiet", "origin/main"]) ? "origin/main" : "main";
}

export function readAppInfo(root = codeRoot, options: { dev?: boolean } = {}): { version: string; commit: string } {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head) return { version: "unknown", commit: "unknown" };
  const commit = head.slice(0, 7);
  const base = git(root, ["merge-base", "HEAD", mainRef(root)]);
  if (!base) return { version: "unknown", commit };
  const main: MainCommit[] = (git(root, ["log", "--first-parent", "--format=%H %cI", base]) ?? "").split("\n").filter(Boolean)
    .map((line) => { const [hash = "", committedAt = ""] = line.split(" "); return { commit: hash, committedAt }; });
  return { version: appVersion(main, head, options), commit };
}
