#!/usr/bin/env node
// Claude Code SessionStart hook (ADR 0022): says how many App Feedback files wait in
// `$LIFEOS_DATA_ROOT/_inbox/feedback/`. Read-only. Silent, and always exits 0, when the data root cannot be
// found, the folder is missing or empty, or anything goes wrong: a nudge must never break a session start.
//
// Hooks started from an editor extension may not inherit LIFEOS_DATA_ROOT, which lives only in ~/.zshrc
// (ADR 0014). When it is unset, ask an interactive zsh for it, with a short timeout.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const marker = "__LIFEOS_ROOT__";
const timeoutMs = Number(process.env.LIFEOS_NUDGE_TIMEOUT_MS) || 3000;

/** The data root from the environment, else from an interactive zsh (value only, between markers). */
function dataRoot() {
  const fromEnv = process.env.LIFEOS_DATA_ROOT?.trim();
  if (fromEnv) return fromEnv;
  const result = spawnSync("zsh", ["-ic", `printf "${marker}%s${marker}" "$LIFEOS_DATA_ROOT"`], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.match(new RegExp(`${marker}([^]*?)${marker}`))?.[1].trim();
}

try {
  const root = dataRoot();
  if (root) {
    const waiting = readdirSync(path.join(root, "_inbox", "feedback")).filter((name) => name.endsWith(".md") && !name.startsWith(".")).length;
    if (waiting > 0) console.log(`${waiting} App Feedback ${waiting === 1 ? "item" : "items"} waiting — say "process app feedback"`);
  }
} catch {
  // Missing folder or unreadable: say nothing.
}
