import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataRootProblem, resolveBackupRoot, resolveDataRoot } from "@lifeos/object-store-markdown";

// ADR 0014: the server and maintenance scripts refuse to start unless LIFEOS_DATA_ROOT holds `.lifeos/schema.md`.

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function emptyRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-guard-"));
  roots.push(root);
  return root;
}
async function markedRoot() {
  const root = await emptyRoot();
  await mkdir(path.join(root, ".lifeos"), { recursive: true });
  await writeFile(path.join(root, ".lifeos", "schema.md"), "# LifeOS data root\n");
  return root;
}

describe("dataRootProblem", () => {
  it("GIVEN LIFEOS_DATA_ROOT is not set THEN it says so and points to the README", async () => {
    const problem = await dataRootProblem(resolveDataRoot({}));
    expect(problem).toMatch(/LIFEOS_DATA_ROOT is not set/);
    expect(problem).toContain("Where the code and the data live");
  });

  it("GIVEN a folder without the marker THEN it names the folder and the file it checked", async () => {
    const root = await emptyRoot();
    const problem = await dataRootProblem(root);
    expect(problem).toContain(root);
    expect(problem).toContain(path.join(root, ".lifeos", "schema.md"));
    expect(problem).toContain("Where the code and the data live");
  });

  it("GIVEN the marker is a folder, not a file THEN the root is refused", async () => {
    const root = await emptyRoot();
    await mkdir(path.join(root, ".lifeos", "schema.md"), { recursive: true });
    expect(await dataRootProblem(root)).toBeDefined();
  });

  it("GIVEN a folder with .lifeos/schema.md THEN there is no problem", async () => {
    expect(await dataRootProblem(await markedRoot())).toBeUndefined();
  });

  it("resolves relative roots from the working directory and defaults backups to ~/LifeOS-backups", () => {
    expect(resolveDataRoot({ LIFEOS_DATA_ROOT: "../../.dev-data" }, "/code/apps/server")).toBe(path.resolve("/code/.dev-data"));
    expect(resolveDataRoot({ LIFEOS_DATA_ROOT: "  " })).toBeUndefined();
    expect(resolveBackupRoot({})).toMatch(/LifeOS-backups$/);
    expect(resolveBackupRoot({ LIFEOS_BACKUP_ROOT: "/tmp/b" })).toBe(path.resolve("/tmp/b"));
  });
});

describe("startup guard (real entry points)", () => {
  const run = (entry: string, dataRoot: string | undefined, backupRoot: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LIFEOS_BACKUP_ROOT: backupRoot, LIFEOS_PORT: "0", LIFEOS_CALENDAR: "mock", LIFEOS_DEVICE_ID: "guard-test" };
    delete env.LIFEOS_DATA_ROOT;
    if (dataRoot) env.LIFEOS_DATA_ROOT = dataRoot;
    // vitest runs from the repository root
    return spawnSync(process.execPath, ["--import", "tsx", entry], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
  };

  it("GIVEN an empty data folder WHEN the server starts THEN it exits non-zero, names the path and writes nothing", async () => {
    const root = await emptyRoot();
    const result = run("apps/server/src/main.ts", root, await emptyRoot());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(root, ".lifeos", "schema.md"));
    expect(result.stderr).toContain("Where the code and the data live");
    expect(await readdir(root)).toEqual([]);
  }, 40_000);

  it("GIVEN LIFEOS_DATA_ROOT is unset WHEN the server starts THEN it exits non-zero", async () => {
    const result = run("apps/server/src/main.ts", undefined, await emptyRoot());
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/LIFEOS_DATA_ROOT is not set/);
  }, 40_000);

  it("GIVEN an empty data folder WHEN reconcile-meetings runs THEN it exits non-zero and writes nothing", async () => {
    const root = await emptyRoot();
    const result = run("scripts/reconcile-meetings.mts", root, await emptyRoot());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(root, ".lifeos", "schema.md"));
    expect(await readdir(root)).toEqual([]);
  }, 40_000);
});
