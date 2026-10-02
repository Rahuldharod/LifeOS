// Stable LifeOS launcher (PB-001): one background process on 127.0.0.1:4310 serving the built UI
// and the API, with no file watcher, so code changes never reload the app mid-note.
//   node scripts/lifeos.mjs start | stop | status | update
// The PID file and log are device-local (not in the synced Drive folder, not in Git).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const codeRoot = fileURLToPath(new URL("../", import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.LIFEOS_PORT ?? 4310);
const url = `http://${host}:${port}/`;
const runDir = process.env.LIFEOS_RUN_DIR ?? path.join(os.homedir(), "Library", "Application Support", "LifeOS");
const logDir = process.env.LIFEOS_LOG_DIR ?? path.join(os.homedir(), "Library", "Logs", "LifeOS");
const pidFile = path.join(runDir, "server.pid");
const logFile = path.join(logDir, "server.log");
// Snapshot of the web build served by the running app; refreshed only by start/update-app.
const webSnapshot = path.join(runDir, "web");
const serverEntry = "apps/server/src/main.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The PID of the running stable server, or undefined. Checks the command line too, so a PID
 * reused by an unrelated process after a crash is never mistaken for LifeOS. */
function runningPid() {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.includes(serverEntry) ? pid : undefined;
}

async function healthy() {
  try { return (await fetch(`${url}api/v1/health`, { signal: AbortSignal.timeout(2000) })).ok; }
  catch { return false; }
}

function tailLog(lines = 15) {
  if (!existsSync(logFile)) return "";
  return readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

function build() {
  console.log("Building LifeOS…");
  return spawnSync("corepack", ["pnpm", "build"], { cwd: codeRoot, stdio: "inherit" }).status === 0;
}

async function start() {
  const existing = runningPid();
  if (existing) { console.log(`LifeOS is already running at ${url} (PID ${existing}).`); return true; }
  rmSync(pidFile, { force: true });
  if (await healthy()) {
    console.error(`Something else is already answering on port ${port}. Stop it first (an old \`pnpm dev\`?):\n  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    return false;
  }
  if (!existsSync(path.join(codeRoot, "apps/web/dist/index.html")) && !build()) { console.error("Build failed; LifeOS was not started."); return false; }
  mkdirSync(runDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  rmSync(webSnapshot, { recursive: true, force: true });
  cpSync(path.join(codeRoot, "apps/web/dist"), webSnapshot, { recursive: true });
  const log = openSync(logFile, "a");
  writeFileSync(log, `\n--- LifeOS start ${new Date().toISOString()} ---\n`);
  // `node --import tsx` (not the tsx binary) so the PID is the server itself and SIGTERM reaches it.
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: codeRoot, detached: true, stdio: ["ignore", log, log], env: { ...process.env, NODE_ENV: "production", LIFEOS_WEB_ROOT: webSnapshot }
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  let exited = false;
  child.once("exit", () => { exited = true; });
  for (let waited = 0; waited < 60_000; waited += 500) {
    if (exited) break;
    if (await healthy()) { console.log(`LifeOS is running at ${url}\nLog: ${logFile}`); return true; }
    await sleep(500);
  }
  if (!exited) process.kill(child.pid, "SIGTERM");
  rmSync(pidFile, { force: true });
  console.error(`LifeOS did not start. Last log lines (${logFile}):\n${tailLog()}`);
  return false;
}

async function stop() {
  const pid = runningPid();
  if (!pid) { rmSync(pidFile, { force: true }); console.log("LifeOS is not running."); return true; }
  // SIGTERM lets the server release its device lease before exiting.
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 10_000; waited += 250) {
    if (!runningPid()) { rmSync(pidFile, { force: true }); console.log("LifeOS stopped."); return true; }
    await sleep(250);
  }
  process.kill(pid, "SIGKILL");
  rmSync(pidFile, { force: true });
  console.log("LifeOS did not stop in 10 seconds and was force-stopped.");
  return true;
}

async function status() {
  const pid = runningPid();
  if (!pid) { console.log("LifeOS is not running. Start it with: corepack pnpm start"); return true; }
  console.log(await healthy() ? `LifeOS is running at ${url} (PID ${pid}).\nLog: ${logFile}` : `LifeOS (PID ${pid}) is running but not answering yet. Log: ${logFile}`);
  return true;
}

async function update() {
  // Build first: if it fails, the running app is left untouched.
  if (!build()) { console.error("Build failed; the running LifeOS was left untouched."); return false; }
  return (await stop()) && (await start());
}

const commands = { start, stop, status, update };
const command = commands[process.argv[2]];
if (!command) { console.error("Usage: node scripts/lifeos.mjs start | stop | status | update"); process.exit(2); }
process.exit((await command()) ? 0 : 1);
