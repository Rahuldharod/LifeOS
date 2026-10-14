import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ADR 0022: the SessionStart hook reports waiting App Feedback files. Temporary roots only, never the real data root.

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
function run(env) {
  const { LIFEOS_DATA_ROOT: _ignored, ...rest } = process.env;
  return spawnSync("node", [script], { encoding: "utf8", env: { ...rest, ...env } });
}
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

describe("feedback nudge", () => {
  it("prints the count when 3 feedback files wait", async () => {
    const root = await makeRoot(["a.md", "b.md", "c.md"]);
    const result = run({ LIFEOS_DATA_ROOT: root });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('3 App Feedback items waiting — say "process app feedback"');
  });
  it("uses the singular for one item", async () => {
    const root = await makeRoot(["a.md"]);
    expect(run({ LIFEOS_DATA_ROOT: root }).stdout.trim()).toBe('1 App Feedback item waiting — say "process app feedback"');
  });
  it("counts only .md files", async () => {
    const root = await makeRoot(["a.md", ".DS_Store", "b.md.tmp", "notes.txt"]);
    expect(run({ LIFEOS_DATA_ROOT: root }).stdout).toContain("1 App Feedback item");
  });
  it("is silent and exits 0 for an empty folder", async () => {
    const result = run({ LIFEOS_DATA_ROOT: await makeRoot([]) });
    expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
  it("is silent and exits 0 when the folder is missing", async () => {
    expect(run({ LIFEOS_DATA_ROOT: await makeRoot(undefined) })).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
  it("is silent and exits 0 when LIFEOS_DATA_ROOT is unset or blank", () => {
    expect(run({})).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(run({ LIFEOS_DATA_ROOT: "  " })).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });
});
