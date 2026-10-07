// Cleans up Claude Code agent worktrees under .claude/worktrees (ADR 0014).
//   node scripts/prune-worktrees.mjs            dry run: prints a table of what would be removed and why
//   node scripts/prune-worktrees.mjs --apply    removes the safe ones (`git worktree remove`, never --force)
//   node scripts/prune-worktrees.mjs --quiet    prints only a one-line summary (used by the SessionEnd hook)
//   node scripts/prune-worktrees.mjs --check    warns when there are more than 10 (SessionStart hook); always exits 0
// A worktree is removed only when ALL hold: nothing uncommitted or untracked, its commit is on GitHub (in an
// origin/* branch), and nothing in it (outside node_modules) changed in the last 2 hours. Branches are never deleted.
import { spawnSync } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const recentChangeMs = 2 * 60 * 60 * 1000;
export const checkThreshold = 10;

/**
 * The pure decision for one worktree. `onRemote` is true/false, or undefined when GitHub could not be reached
 * (offline): unknown means keep. Returns { decision: "remove" | "keep", reason }.
 */
export function decideWorktree({ clean, onRemote, newestChangeMs, nowMs, locked = false }) {
  if (locked) return { decision: "keep", reason: "locked by git" };
  if (!clean) return { decision: "keep", reason: "has uncommitted or untracked files" };
  if (onRemote === undefined) return { decision: "keep", reason: "could not reach GitHub, so cannot tell if it is pushed" };
  if (!onRemote) return { decision: "keep", reason: "its commit is not on GitHub yet (push the branch)" };
  if (newestChangeMs !== undefined && nowMs - newestChangeMs < recentChangeMs) return { decision: "keep", reason: "changed in the last 2 hours" };
  return { decision: "remove", reason: "clean, pushed and idle for 2 hours" };
}

/** Parses `git worktree list --porcelain` into [{ path, head, branch, locked }]. */
export function parseWorktreeList(output) {
  const worktrees = [];
  for (const block of output.split(/\n\s*\n/)) {
    const entry = { path: "", head: "", branch: "", locked: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") entry.branch = "(detached)";
      else if (line === "locked" || line.startsWith("locked ")) entry.locked = true;
    }
    if (entry.path) worktrees.push(entry);
  }
  return worktrees;
}

const git = (cwd, args, timeout = 60_000) => spawnSync("git", args, { cwd, encoding: "utf8", timeout });

/** The main checkout, even when this script is run from inside a worktree. */
function repositoryRoot(from) {
  const result = git(from, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.status !== 0) throw new Error(`Not a git repository: ${from}`);
  return path.dirname(result.stdout.trim());
}

/** Newest modification time of anything in `folder`, skipping node_modules and not following links. */
async function newestChange(folder) {
  let newest;
  const visit = async (current) => {
    const info = await lstat(current).catch(() => undefined);
    if (!info) return;
    newest = Math.max(newest ?? 0, info.mtimeMs);
    if (!info.isDirectory()) return;
    for (const name of await readdir(current).catch(() => [])) if (name !== "node_modules") await visit(path.join(current, name));
  };
  await visit(folder);
  return newest;
}

function agentWorktrees(root) {
  const list = git(root, ["worktree", "list", "--porcelain"]);
  if (list.status !== 0) throw new Error(list.stderr.trim() || "git worktree list failed");
  const folder = path.join(root, ".claude", "worktrees") + path.sep;
  return parseWorktreeList(list.stdout).filter((worktree) => worktree.path.startsWith(folder));
}

function table(rows) {
  const header = ["NAME", "BRANCH", "DECISION", "REASON"];
  const cells = rows.map((row) => [row.name, row.branch, row.decision, row.reason]);
  const widths = header.map((title, column) => Math.max(title.length, ...cells.map((cell) => cell[column].length)));
  return [header, ...cells].map((cell) => cell.map((value, column) => value.padEnd(widths[column])).join("  ").trimEnd()).join("\n");
}

/** Runs the command; returns the exit code. `options` (root, nowMs, log) exist for tests. */
export async function run(argv, options = {}) {
  const log = options.log ?? console.log;
  // realpath: git prints resolved paths (macOS /var is /private/var).
  const root = await realpath(options.root ?? repositoryRoot(path.dirname(fileURLToPath(import.meta.url))));
  const worktrees = agentWorktrees(root);

  if (argv.includes("--check")) {
    if (worktrees.length > checkThreshold) log(`LifeOS: ${worktrees.length} agent worktrees under .claude/worktrees (more than ${checkThreshold}). Run \`corepack pnpm worktrees:prune\` to see which can be removed.`);
    return 0;
  }

  const apply = argv.includes("--apply");
  const quiet = argv.includes("--quiet");
  const nowMs = options.nowMs ?? Date.now();
  const online = worktrees.length === 0 || git(root, ["fetch", "--quiet", "origin"], 30_000).status === 0;
  const rows = [];
  for (const worktree of worktrees) {
    const status = git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
    const clean = status.status === 0 && status.stdout.trim() === "";
    let onRemote;
    if (online && worktree.head) {
      const contains = git(root, ["branch", "--remotes", "--contains", worktree.head]);
      onRemote = contains.status === 0 && contains.stdout.split("\n").some((line) => line.trim().startsWith("origin/"));
    }
    const verdict = decideWorktree({ clean, onRemote, newestChangeMs: await newestChange(worktree.path), nowMs, locked: worktree.locked });
    const row = { name: path.basename(worktree.path), branch: worktree.branch || "-", ...verdict };
    if (apply && verdict.decision === "remove") {
      const removed = git(root, ["worktree", "remove", worktree.path]);
      if (removed.status === 0) row.decision = "removed";
      else {
        const message = (removed.stderr || removed.stdout).trim().split("\n")[0] ?? "unknown error";
        row.decision = "failed";
        row.reason = /permission denied|operation not permitted|EACCES|EPERM/i.test(message) ? `permission error, left in place: ${message}` : `git refused: ${message}`;
      }
    }
    rows.push(row);
  }
  if (apply) git(root, ["worktree", "prune"]);

  const count = (decision) => rows.filter((row) => row.decision === decision).length;
  const summary = apply
    ? `Worktrees: ${count("removed")} removed, ${count("keep")} kept${count("failed") ? `, ${count("failed")} could not be removed` : ""}${online ? "" : " (offline: nothing removed)"}.`
    : `Worktrees: ${count("remove")} can be removed, ${count("keep")} kept${online ? "" : " (offline: nothing can be removed)"}. Dry run; add --apply to remove.`;
  if (!quiet && rows.length) log(table(rows));
  log(summary);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  try {
    process.exitCode = await run(argv);
  } catch (error) {
    console.error(`prune-worktrees: ${error instanceof Error ? error.message : String(error)}`);
    // The check runs as a SessionStart hook: it must never fail the session.
    process.exitCode = argv.includes("--check") ? 0 : 1;
  }
}
