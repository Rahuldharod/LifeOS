#!/usr/bin/env node
// Claude Code SessionStart hook (ADR 0022): says how many App Feedback files wait in
// `$LIFEOS_DATA_ROOT/_inbox/feedback/`. Read-only. Silent, and always exits 0, when the variable is unset,
// the folder is missing or empty, or anything goes wrong: a nudge must never break a session start.
import { readdirSync } from "node:fs";
import path from "node:path";

const root = process.env.LIFEOS_DATA_ROOT?.trim();
try {
  if (root) {
    const waiting = readdirSync(path.join(root, "_inbox", "feedback")).filter((name) => name.endsWith(".md") && !name.startsWith(".")).length;
    if (waiting > 0) console.log(`${waiting} App Feedback ${waiting === 1 ? "item" : "items"} waiting — say "process app feedback"`);
  }
} catch {
  // Missing folder or unreadable: say nothing.
}
