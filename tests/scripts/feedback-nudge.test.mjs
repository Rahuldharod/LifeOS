import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ADR 0022: the SessionStart hook reports waiting App Feedback files. Temporary roots only, never the real data root.

// The zshrc fallback only matters on the user's Macs; CI runners may lack zsh, so only the fallback success test is skipped there.
const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
const script = path.resolve("scripts/hooks/feedback-nudge.mjs");
const roots = [];
async function makeRoot(files) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-nudge-"));
  roots.push(root);
  if (files) {
    const folder = path.join(root, "_inbox", "feedback");
    await mkdir(folder, { recursive: true });
    for (const name of files) await writeFile(path.join(folder, name), "---\nlifeos_feedback: 1\n---\ntext\n");
  }
  return root;
}
// Every run gets an empty ZDOTDIR unless given one, so the zsh fallback never reads the real ~/.zshrc.
async function run(env) {
  const { LIFEOS_DATA_ROOT: _ignored, ...rest } = process.env;
  const emptyZdotdir = await mkdtemp(path.join(tmpdir(), "lifeos-zdot-"));
  roots.push(emptyZdotdir);
  return spawnSync("node", [script], { encoding: "utf8", env: { ...rest, ZDOTDIR: emptyZdotdir, ...env } });
}
async function zdotdirWith(zshrc) {
  const dir = await mkdtemp(path.join(tmpdir(), "lifeos-zdot-"));
  roots.push(dir);
  await writeFile(path.join(dir, ".zshrc"), zshrc);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

describe("feedback nudge", () => {
  it("prints the count when 3 feedback files wait", async () => {
    const root = await makeRoot(["a.md", "b.md", "c.md"]);
    const result = await run({ LIFEOS_DATA_ROOT: root });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('3 App Feedback items waiting — say "process app feedback"');
  });
  it("uses the singular for one item", async () => {
    const root = await makeRoot(["a.md"]);
    expect((await run({ LIFEOS_DATA_ROOT: root })).stdout.trim()).toBe('1 App Feedback item waiting — say "process app feedback"');
  });
  it("counts only .md files", async () => {
    const root = await makeRoot(["a.md", ".DS_Store", "b.md.tmp", "notes.txt"]);
    expect((await run({ LIFEOS_DATA_ROOT: root })).stdout).toContain("1 App Feedback item");
  });
  it("is silent and exits 0 for an empty folder", async () => {
    const result = await run({ LIFEOS_DATA_ROOT: await makeRoot([]) });
    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
  it("is silent and exits 0 when the folder is missing", async () => {
    expect(await run({ LIFEOS_DATA_ROOT: await makeRoot(undefined) })).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
  it("is silent and exits 0 when LIFEOS_DATA_ROOT is unset or blank everywhere", async () => {
    expect(await run({})).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(await run({ LIFEOS_DATA_ROOT: "  " })).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
  it.skipIf(!hasZsh)("falls back to the root exported in zshrc, ignoring other zshrc output", async () => {
    const root = await makeRoot(["a.md", "b.md"]);
    const zdot = await zdotdirWith(`echo noisy zshrc output\nexport LIFEOS_DATA_ROOT='${root}'\n`);
    const result = await run({ ZDOTDIR: zdot });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('2 App Feedback items waiting — say "process app feedback"');
  });
  it("stays silent and exits 0 when zshrc hangs past the timeout", async () => {
    const zdot = await zdotdirWith("sleep 30\n");
    const started = Date.now();
    const result = await run({ ZDOTDIR: zdot, LIFEOS_NUDGE_TIMEOUT_MS: "300" });
    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
  it("stays silent and exits 0 when zshrc fails", async () => {
    const zdot = await zdotdirWith("exit 3\n");
    expect(await run({ ZDOTDIR: zdot })).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
});
