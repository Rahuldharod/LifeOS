// #154: starts the real LifeOS server for browser tests on port 4319, over a fresh temporary synthetic data root.
// Serves the built web app (apps/web/dist). Never touches the real data root, .dev-data/ or ports 4310/4311/5174.
import { spawn } from "node:child_process";
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const webRoot = path.join(repo, "apps/web/dist");
const index = await stat(path.join(webRoot, "index.html")).catch(() => undefined);
if (!index) {
  console.error("apps/web/dist/index.html is missing: run `pnpm --filter @lifeos/web build` first.");
  process.exit(1);
}

const dataRoot = await mkdtemp(path.join(tmpdir(), "lifeos-browser-data-"));
const backupRoot = await mkdtemp(path.join(tmpdir(), "lifeos-browser-backups-"));
await mkdir(path.join(dataRoot, ".lifeos"), { recursive: true });
await writeFile(path.join(dataRoot, ".lifeos/schema.md"), "# LifeOS data root\n\nSynthetic browser-test data (#154).\n");
await mkdir(path.join(dataRoot, "people"), { recursive: true });
await cp(path.join(repo, "schemas/fixtures/person-self.md"), path.join(dataRoot, "people/person-self.md"));

// Inbox Drafts (skills/lifeos-object-contract): the server adopts them once they are 2 seconds old, so they are
// written here (the API has no route that creates them) and backdated. `seed()` in fixtures.ts triggers adoption.
const drafts = path.join(dataRoot, "_inbox/drafts");
await mkdir(drafts, { recursive: true });
const longBody = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. Synthetic research notes about portable Markdown, offline-first storage and review workflows. `.repeat(6).trim()).join("\n\n");
const files = {};
const draft = (name, front, body) => { files[`${name}.md`] = `---\nlifeos_draft: 1\n${Object.entries({ ...front, captured_at: "2026-10-01T09:00:00Z" }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}\n`; };
for (let i = 1; i <= 12; i += 1) {
  draft(`knowledge-${String(i).padStart(2, "0")}`, { kind: "knowledge-note", draft_key: `browser-knowledge-${i}`, origin: "user-dictated", title: `Browser knowledge note ${i}` }, i === 1 ? longBody : `Synthetic knowledge body ${i} for example.com testing.\n\nSecond paragraph ${i}.`);
}
draft("review-task-1", { kind: "task", draft_key: "browser-review-task-1", origin: "agent-extracted", confidence: "High", title: "Browser review: send the example.com agenda" }, "Extracted from a synthetic email.");
draft("review-task-2", { kind: "task", draft_key: "browser-review-task-2", origin: "agent-extracted", confidence: "Medium", title: "Browser review: confirm the pilot date" }, "Extracted from a synthetic transcript.");
draft("review-decision-1", { kind: "decision", draft_key: "browser-review-decision-1", origin: "agent-extracted", confidence: "Medium", title: "Browser review: adopt weekly reviews" }, "Extracted from a synthetic meeting.");
for (const [name, content] of Object.entries(files)) {
  const file = path.join(drafts, name);
  await writeFile(file, content);
  const old = new Date(Date.now() - 60_000);
  await utimes(file, old, old);
}

const server = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  cwd: path.join(repo, "apps/server"),
  stdio: "inherit",
  env: {
    ...process.env,
    LIFEOS_PORT: "4319",
    LIFEOS_HOST: "127.0.0.1",
    LIFEOS_DATA_ROOT: dataRoot,
    LIFEOS_BACKUP_ROOT: backupRoot,
    LIFEOS_DEVICE_ID: "browser-test",
    LIFEOS_CALENDAR: "mock",
    LIFEOS_WEB_ROOT: webRoot
  }
});

/** Backup snapshots are read-only. */
function makeWritable(root) {
  try { chmodSync(root, 0o755); } catch { return; }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(full);
    else try { chmodSync(full, 0o644); } catch { /* already gone */ }
  }
}
// Synchronous so it also finishes when the runner follows its SIGTERM with a SIGKILL.
function cleanup() {
  for (const root of [dataRoot, backupRoot]) { makeWritable(root); try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { console.error(`Could not remove ${root}: ${error.message}`); } }
}
// Let the server finish its own shutdown (it may still be writing) before removing its folders; never wait forever.
const stop = (signal) => {
  if (server.exitCode !== null) { cleanup(); process.exit(0); }
  server.kill(signal);
  setTimeout(() => { cleanup(); process.exit(0); }, 5_000).unref();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGTERM"));
process.on("exit", cleanup);
server.on("exit", (code) => { cleanup(); process.exit(code ?? 1); });
