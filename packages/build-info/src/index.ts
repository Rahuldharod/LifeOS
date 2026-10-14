// #208 (PB-032): reads the App version from the git checkout. Node only: the server calls it at start and the web build
// (apps/web/vite.config.ts) at build time, so both runtimes count the same way. The version rule itself is `appVersion`
// in @lifeos/shared; this module only gathers the git facts it needs.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appVersion, unknownAppInfo, type AppInfo, type MainCommit } from "@lifeos/shared";

const codeRoot = fileURLToPath(new URL("../../../", import.meta.url));

function git(root: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
  catch { return undefined; }
}

/**
 * Which main to count from. On main itself, the local branch: the stable app runs from it, and a `git pull` can leave it
 * ahead of a stale `origin/main`. Elsewhere `origin/main` when present (CI, agent worktrees), else the local `main`.
 */
function mainRef(root: string) {
  if (git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) === "main") return "main";
  return git(root, ["rev-parse", "--verify", "--quiet", "origin/main"]) ? "origin/main" : "main";
}

export function readAppInfo({ root = codeRoot, dev = false }: { root?: string; dev?: boolean } = {}): AppInfo {
  const buildCommit = git(root, ["rev-parse", "HEAD"]);
  if (!buildCommit) return unknownAppInfo;
  const ref = mainRef(root);
  const main: MainCommit[] = (git(root, ["log", "--first-parent", "--format=%H %cI", ref]) ?? "").split("\n").filter(Boolean)
    .map((line) => { const [commit = "", committedAt = ""] = line.split(" "); return { commit, committedAt }; });
  const version = appVersion({
    main,
    base: git(root, ["merge-base", "HEAD", ref]) ?? "",
    buildCommit,
    shallow: git(root, ["rev-parse", "--is-shallow-repository"]) === "true",
    dev
  });
  return { version, commit: buildCommit.slice(0, 7) };
}
