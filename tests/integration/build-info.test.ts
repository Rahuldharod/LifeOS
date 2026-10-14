import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAppInfo } from "@lifeos/build-info";

// #208: the App version read from a real git checkout. Synthetic repositories in a temp folder, fixed commit times.

function git(cwd: string, args: string[], at = "2026-10-14T09:00:00+02:00") {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
}
const commit = (cwd: string, at: string) => git(cwd, ["commit", "--allow-empty", "-q", "-m", `at ${at}`], at);
const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);

/** An "origin" with three merges on 14 Oct and a clone of it. */
async function repos() {
  const origin = await mkdtemp(path.join(tmpdir(), "lifeos-build-info-origin-"));
  git(origin, ["init", "-q", "-b", "main"]);
  commit(origin, "2026-10-13T18:00:00+02:00");
  commit(origin, "2026-10-14T09:00:00+02:00");
  commit(origin, "2026-10-14T11:00:00+02:00");
  commit(origin, "2026-10-14T16:00:00+02:00");
  const clone = await mkdtemp(path.join(tmpdir(), "lifeos-build-info-clone-"));
  git(clone, ["clone", "-q", origin, "."]);
  return { origin, clone };
}

describe("reading the App version from git", () => {
  it("gives a clean version on main", async () => {
    const { clone } = await repos();
    expect(readAppInfo({ root: clone })).toEqual({ version: "26.10.14.3", commit: head(clone).slice(0, 7) });
  });

  it("follows the local main the stable app runs from, even when origin/main is behind it", async () => {
    const { clone } = await repos();
    commit(clone, "2026-10-14T18:00:00+02:00");
    expect(readAppInfo({ root: clone }).version).toBe("26.10.14.4");
  });

  it("marks a feature branch with -dev and its commit, based on origin/main", async () => {
    const { clone } = await repos();
    git(clone, ["checkout", "-q", "-b", "feature/x"]);
    commit(clone, "2026-10-14T17:00:00+02:00");
    expect(readAppInfo({ root: clone }).version).toBe(`26.10.14.3-dev+${head(clone).slice(0, 7)}`);
  });

  it("marks a dev-runtime build", async () => {
    const { clone } = await repos();
    expect(readAppInfo({ root: clone, dev: true }).version).toBe(`26.10.14.3-dev+${head(clone).slice(0, 7)}`);
  });

  it("is unknown in a shallow clone, keeping the commit", async () => {
    const { origin } = await repos();
    const shallow = await mkdtemp(path.join(tmpdir(), "lifeos-build-info-shallow-"));
    git(shallow, ["clone", "-q", "--depth", "1", `file://${origin}`, "."]);
    expect(readAppInfo({ root: shallow })).toEqual({ version: "unknown", commit: head(shallow).slice(0, 7) });
  });

  it("is unknown outside a git checkout", async () => {
    expect(readAppInfo({ root: await mkdtemp(path.join(tmpdir(), "lifeos-build-info-none-")) })).toEqual({ version: "unknown", commit: "unknown" });
  });
});
