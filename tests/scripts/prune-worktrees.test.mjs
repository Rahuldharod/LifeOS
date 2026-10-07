import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideWorktree, parseWorktreeList, recentChangeMs, run } from "../../scripts/prune-worktrees.mjs";

// ADR 0014: agent worktrees are removed only when clean, pushed to GitHub and idle for 2 hours.

const nowMs = Date.parse("2026-10-07T12:00:00Z");
const idle = nowMs - recentChangeMs - 1;
const safe = { clean: true, onRemote: true, newestChangeMs: idle, nowMs };

describe("decideWorktree", () => {
  it("removes a clean, pushed worktree idle for more than 2 hours", () => {
    expect(decideWorktree(safe).decision).toBe("remove");
  });
  it("keeps one with uncommitted or untracked files", () => {
    expect(decideWorktree({ ...safe, clean: false })).toMatchObject({ decision: "keep", reason: expect.stringMatching(/uncommitted or untracked/) });
  });
  it("keeps one whose commit is not on GitHub", () => {
    expect(decideWorktree({ ...safe, onRemote: false })).toMatchObject({ decision: "keep", reason: expect.stringMatching(/not on GitHub/) });
  });
  it("keeps everything when offline (GitHub status unknown)", () => {
    expect(decideWorktree({ ...safe, onRemote: undefined })).toMatchObject({ decision: "keep", reason: expect.stringMatching(/could not reach GitHub/) });
  });
  it("keeps one changed in the last 2 hours", () => {
    expect(decideWorktree({ ...safe, newestChangeMs: nowMs - 60_000 })).toMatchObject({ decision: "keep", reason: expect.stringMatching(/last 2 hours/) });
    expect(decideWorktree({ ...safe, newestChangeMs: nowMs - recentChangeMs + 1 }).decision).toBe("keep");
  });
  it("keeps a locked worktree", () => {
    expect(decideWorktree({ ...safe, locked: true }).decision).toBe("keep");
  });
});

describe("parseWorktreeList", () => {
  it("reads paths, branches, detached heads and locks", () => {
    const output = [
      "worktree /code", "HEAD aaa", "branch refs/heads/main", "",
      "worktree /code/.claude/worktrees/agent-1", "HEAD bbb", "branch refs/heads/worktree-agent-1", "",
      "worktree /code/.claude/worktrees/agent-2", "HEAD ccc", "detached", "locked claude agent", ""
    ].join("\n");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/code", head: "aaa", branch: "main", locked: false },
      { path: "/code/.claude/worktrees/agent-1", head: "bbb", branch: "worktree-agent-1", locked: false },
      { path: "/code/.claude/worktrees/agent-2", head: "ccc", branch: "(detached)", locked: true }
    ]);
  });
});

describe("run against a real repository", () => {
  const folders = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const exists = (target) => stat(target).then(() => true, () => false);

  async function repository() {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "lifeos-prune-")));
    folders.push(base);
    const origin = path.join(base, "origin.git");
    const root = path.join(base, "code");
    git(base, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(base, "clone", "--quiet", origin, root);
    await writeFile(path.join(root, "README.md"), "test\n");
    git(root, "add", "README.md");
    git(root, "commit", "--quiet", "-m", "first");
    git(root, "push", "--quiet", "origin", "HEAD:main");
    await mkdir(path.join(root, ".claude", "worktrees"), { recursive: true });
    const add = async (name, { push = true, dirty = false } = {}) => {
      const folder = path.join(root, ".claude", "worktrees", name);
      git(root, "worktree", "add", "--quiet", "-b", `worktree-${name}`, folder);
      await writeFile(path.join(folder, `${name}.md`), name);
      git(folder, "add", ".");
      git(folder, "commit", "--quiet", "-m", name);
      if (push) git(folder, "push", "--quiet", "origin", `worktree-${name}`);
      if (dirty) await writeFile(path.join(folder, "scratch.txt"), "not committed");
      return folder;
    };
    return { root, add };
  }

  it("dry run removes nothing; --apply removes only the safe one and keeps its branch", async () => {
    const { root, add } = await repository();
    const pushed = await add("pushed");
    const unpushed = await add("unpushed", { push: false });
    const dirty = await add("dirty", { dirty: true });
    const later = Date.now() + recentChangeMs + 60_000;
    const lines = [];

    await run([], { root, nowMs: later, log: (line) => lines.push(line) });
    expect(lines.join("\n")).toMatch(/pushed\s+worktree-pushed\s+remove/);
    expect(lines.at(-1)).toMatch(/1 can be removed, 2 kept. Dry run/);
    expect(await exists(pushed)).toBe(true);

    lines.length = 0;
    await run(["--apply", "--quiet"], { root, nowMs: later, log: (line) => lines.push(line) });
    expect(lines).toEqual(["Worktrees: 1 removed, 2 kept."]);
    expect(await exists(pushed)).toBe(false);
    expect(await exists(unpushed)).toBe(true);
    expect(await exists(dirty)).toBe(true);
    expect(git(root, "branch", "--list", "worktree-pushed")).toContain("worktree-pushed");
  }, 30_000);

  it("keeps a pushed worktree changed in the last 2 hours", async () => {
    const { root, add } = await repository();
    const fresh = await add("fresh");
    const lines = [];
    await run(["--apply"], { root, nowMs: Date.now(), log: (line) => lines.push(line) });
    expect(await exists(fresh)).toBe(true);
    expect(lines.join("\n")).toMatch(/changed in the last 2 hours/);
  }, 30_000);

  it("keeps everything when origin cannot be reached", async () => {
    const { root, add } = await repository();
    const pushed = await add("pushed");
    git(root, "remote", "set-url", "origin", path.join(root, "missing-origin.git"));
    const lines = [];
    await run(["--apply", "--quiet"], { root, nowMs: Date.now() + recentChangeMs + 60_000, log: (line) => lines.push(line) });
    expect(await exists(pushed)).toBe(true);
    expect(lines).toEqual(["Worktrees: 0 removed, 1 kept (offline: nothing removed)."]);
  }, 30_000);

  it("--check prints nothing at 10 worktrees or fewer and a warning above", async () => {
    const { root, add } = await repository();
    const lines = [];
    await add("one", { push: false });
    expect(await run(["--check"], { root, log: (line) => lines.push(line) })).toBe(0);
    expect(lines).toEqual([]);
    for (let index = 0; index < 10; index += 1) git(root, "worktree", "add", "--quiet", "--detach", path.join(root, ".claude", "worktrees", `extra-${index}`));
    expect(await run(["--check"], { root, log: (line) => lines.push(line) })).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/11 agent worktrees/);
  }, 60_000);
});
