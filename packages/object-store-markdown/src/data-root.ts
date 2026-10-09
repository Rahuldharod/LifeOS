import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * ADR 0014: the startup guard. Every real LifeOS data folder holds this marker file. A process that would read or
 * write objects (the server, maintenance scripts) checks for it first and refuses to start without it, so a wrong
 * or empty LIFEOS_DATA_ROOT (a typo, Google Drive not mounted yet, the old `../data` default) can never become a
 * fresh, empty vault that later syncs over the real one.
 */
export const dataRootMarker = path.join(".lifeos", "schema.md");

const readmePointer = 'See README.md, section "Where the code and the data live".';

/** The data root from LIFEOS_DATA_ROOT (relative values resolve from `cwd`), or undefined when it is not set. */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  const value = env.LIFEOS_DATA_ROOT?.trim();
  return value ? path.resolve(cwd, value) : undefined;
}

/** The backup root from LIFEOS_BACKUP_ROOT, else `~/LifeOS-backups` (local to each Mac, outside Google Drive). */
export function resolveBackupRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const value = env.LIFEOS_BACKUP_ROOT?.trim();
  return value ? path.resolve(cwd, value) : path.join(os.homedir(), "LifeOS-backups");
}

/** Undefined when `root` is a LifeOS data folder; otherwise a plain-English explanation naming the path checked. */
export async function dataRootProblem(root: string | undefined): Promise<string | undefined> {
  if (!root) {
    return [
      "LifeOS did not start: LIFEOS_DATA_ROOT is not set, so it does not know where your data is.",
      "Add it to ~/.zshrc, open a new Terminal window, and try again.",
      readmePointer
    ].join("\n");
  }
  const marker = path.join(root, dataRootMarker);
  const found = await stat(marker).then((entry) => entry.isFile(), () => false);
  if (found) return undefined;
  return [
    "LifeOS did not start: no LifeOS data was found.",
    `  Data folder: ${root}`,
    `  Checked for: ${marker}`,
    "Every LifeOS data folder has this file. Check LIFEOS_DATA_ROOT in ~/.zshrc (and that Google Drive is running),",
    "open a new Terminal window, and try again. Nothing was read or written.",
    readmePointer
  ].join("\n");
}

/** Prints the problem and exits with code 1 when `root` is not a LifeOS data folder. */
export async function exitUnlessDataRoot(root: string | undefined): Promise<string> {
  const problem = await dataRootProblem(root);
  if (problem || !root) {
    console.error(problem);
    process.exit(1);
  }
  return root;
}
