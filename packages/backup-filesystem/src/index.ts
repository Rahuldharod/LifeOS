import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface BackupFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface BackupManifest {
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  files: BackupFileEntry[];
}

export interface BackupSummary {
  backupId: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
}

export interface BackupVerification extends BackupSummary {
  valid: boolean;
  restoredToTemporaryDirectory: boolean;
  diagnostics: string[];
}

// `_agent/` is the derived Agent Index: rebuildable, so not backed up (ADR 0007). `_inbox/` is kept.
const excludedPaths = new Set([".lifeos/session.md", "_agent"]);

function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function portablePath(value: string) {
  return value.split(path.sep).join("/");
}

async function filesUnder(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = portablePath(path.relative(root, fullPath));
    if (excludedPaths.has(relativePath) || entry.name.endsWith(".tmp")) continue;
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await filesUnder(root, fullPath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

/** Off-Drive copies keep four generations (PRD story 82). */
export const offDriveGenerations = 4;

export class FilesystemBackupService {
  private readonly dataRoot: string;
  private readonly backupRoot: string;

  constructor(dataRoot: string, backupRoot: string, private readonly retentionCount = 10) {
    this.dataRoot = path.resolve(dataRoot);
    this.backupRoot = path.resolve(backupRoot);
  }

  async create(): Promise<BackupSummary> {
    await mkdir(this.backupRoot, { recursive: true });
    const createdAt = new Date().toISOString();
    const backupId = `${createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}--${randomUUID()}`;
    const staging = path.join(this.backupRoot, `.creating-${backupId}`);
    const destination = path.join(this.backupRoot, backupId);
    const snapshotRoot = path.join(staging, "data");
    const sourceFiles = await filesUnder(this.dataRoot);
    const entries: BackupFileEntry[] = [];

    try {
      await mkdir(snapshotRoot, { recursive: true });
      for (const relativePath of sourceFiles) {
        const target = path.join(snapshotRoot, relativePath);
        // The bytes checksummed are the bytes written, so a file saved during the backup cannot break its manifest.
        const content = await readFile(path.join(this.dataRoot, relativePath));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
        entries.push({ path: relativePath, sha256: sha256(content), size: content.byteLength });
      }
      const manifest: BackupManifest = {
        formatVersion: 1,
        backupId,
        createdAt,
        fileCount: entries.length,
        totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
        files: entries
      };
      await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rename(staging, destination);
      await makeReadOnly(destination);
      await this.prune();
      return summaryOf(manifest);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  list(): Promise<BackupSummary[]> {
    return listIn(this.backupRoot);
  }

  /**
   * #95: removes unfinished `.creating-*` snapshots that a killed backup left behind. Call it only while no backup of
   * this root is being written (the application runs it inside the backup queue, before the run's first backup).
   */
  sweepStaging(): Promise<string[]> {
    return sweepStagingIn(this.backupRoot);
  }

  /** Checks a snapshot against its manifest in place (sizes and SHA-256), without a restoration drill. */
  async verify(backupId: string): Promise<{ valid: boolean; diagnostics: string[] }> {
    const diagnostics = await verifyIn(this.backupRoot, backupId);
    return { valid: diagnostics.length === 0, diagnostics };
  }

  async verifyRestorable(backupId: string): Promise<BackupVerification> {
    const manifest = await readManifestIn(this.backupRoot, backupId);
    const snapshotRoot = safePathIn(this.backupRoot, backupId, "data");
    const snapshotDiagnostics = await verifyFiles(snapshotRoot, manifest);
    if (snapshotDiagnostics.length) return { ...summaryOf(manifest), valid: false, restoredToTemporaryDirectory: false, diagnostics: snapshotDiagnostics };

    const restoreRoot = await mkdtemp(path.join(tmpdir(), "lifeos-restore-test-"));
    try {
      for (const entry of manifest.files) {
        const source = path.join(snapshotRoot, entry.path);
        const target = path.join(restoreRoot, entry.path);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      const diagnostics = await verifyFiles(restoreRoot, manifest);
      return { ...summaryOf(manifest), valid: diagnostics.length === 0, restoredToTemporaryDirectory: true, diagnostics };
    } finally {
      await rm(restoreRoot, { recursive: true, force: true });
    }
  }

  /**
   * #84: copies a verified snapshot to a folder outside Google Drive (the off-Drive copy). The source is checked first,
   * the copy is written under a staging name, checksum-verified, then renamed and made read-only. The folder must
   * already exist (an unplugged disk is a failure, not a new folder on the system disk). Keeps `generations` copies.
   */
  async copyTo(backupId: string, folder: string, generations = offDriveGenerations): Promise<BackupSummary> {
    const target = path.resolve(folder);
    const info = await stat(target).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`Off-Drive backup folder not found: ${target}`);
    // Symbolic links resolved (#95): a link into the data or backup folder is still inside it.
    const realTarget = await realpath(target);
    for (const inside of [this.dataRoot, this.backupRoot]) {
      const realInside = await realpath(inside).catch(() => inside);
      if (realTarget === realInside || realTarget.startsWith(`${realInside}${path.sep}`)) throw new Error(`Off-Drive backup folder must be outside ${inside}`);
    }
    const problems = await verifyIn(this.backupRoot, backupId);
    if (problems.length) throw new Error(`Backup ${backupId} failed verification: ${problems.join("; ")}`);
    const manifest = await readManifestIn(this.backupRoot, backupId);
    const destination = path.join(target, backupId);
    if (await stat(destination).catch(() => undefined)) {
      const existing = await verifyIn(target, backupId);
      if (!existing.length) return summaryOf(manifest);
      throw new Error(`An off-Drive copy of ${backupId} exists but failed verification: ${existing.join("; ")}`);
    }
    const staging = path.join(target, `.creating-${backupId}`);
    try {
      // Unfinished copies from an earlier, interrupted run (#95), this backup's included.
      await sweepStagingIn(target);
      for (const entry of manifest.files) {
        const to = path.join(staging, "data", entry.path);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(path.join(this.backupRoot, backupId, "data", entry.path), to);
      }
      await copyFile(path.join(this.backupRoot, backupId, "manifest.json"), path.join(staging, "manifest.json"));
      const diagnostics = await verifyFiles(path.join(staging, "data"), manifest);
      if (diagnostics.length) throw new Error(`Off-Drive copy failed verification: ${diagnostics.join("; ")}`);
      await rename(staging, destination);
      await makeReadOnly(destination);
    } catch (error) {
      await makeWritable(staging);
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await pruneIn(target, generations);
    return summaryOf(manifest);
  }

  /** The off-Drive copies in `folder`, newest first; an unreadable folder lists none. */
  listCopies(folder: string): Promise<BackupSummary[]> {
    return listIn(path.resolve(folder));
  }

  /** ADR 0004 retention: keeps the newest generations, and never deletes the only backup that still verifies. */
  prune() {
    return pruneIn(this.backupRoot, this.retentionCount);
  }
}

async function listIn(root: string): Promise<BackupSummary[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const backups: BackupSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".creating-")) continue;
    const manifest = await readManifestIn(root, entry.name).catch(() => undefined);
    if (manifest) backups.push(summaryOf(manifest));
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function sweepStagingIn(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const swept: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".creating-")) continue;
    const target = path.join(root, entry.name);
    await makeWritable(target);
    await rm(target, { recursive: true, force: true });
    swept.push(entry.name);
  }
  return swept;
}

async function verifyIn(root: string, backupId: string) {
  const manifest = await readManifestIn(root, backupId).catch(() => undefined);
  if (!manifest) return [`Unreadable manifest: ${backupId}`];
  return verifyFiles(safePathIn(root, backupId, "data"), manifest);
}

async function pruneIn(root: string, keep: number) {
  if (keep < 1) return;
  const backups = await listIn(root);
  const extra = backups.slice(keep);
  if (!extra.length) return;
  let keptVerified = false;
  for (const backup of backups.slice(0, keep)) if (!(await verifyIn(root, backup.backupId)).length) { keptVerified = true; break; }
  let spared: string | undefined;
  if (!keptVerified) for (const backup of extra) if (!(await verifyIn(root, backup.backupId)).length) { spared = backup.backupId; break; }
  for (const backup of extra) {
    if (backup.backupId === spared) continue;
    const target = path.join(root, backup.backupId);
    await makeWritable(target);
    await rm(target, { recursive: true, force: true });
  }
}

async function verifyFiles(root: string, manifest: BackupManifest) {
  const diagnostics: string[] = [];
  const expected = new Set(manifest.files.map((entry) => entry.path));
  const actual = await filesUnder(root);
  for (const relativePath of actual) if (!expected.has(relativePath)) diagnostics.push(`Unexpected file: ${relativePath}`);
  for (const entry of manifest.files) {
    const content = await readFile(path.join(root, entry.path)).catch(() => undefined);
    if (!content) diagnostics.push(`Missing file: ${entry.path}`);
    else {
      if (content.byteLength !== entry.size) diagnostics.push(`Size mismatch: ${entry.path}`);
      if (sha256(content) !== entry.sha256) diagnostics.push(`Checksum mismatch: ${entry.path}`);
    }
  }
  return diagnostics;
}

async function readManifestIn(root: string, backupId: string) {
  const content = await readFile(safePathIn(root, backupId, "manifest.json"), "utf8");
  const manifest = JSON.parse(content) as BackupManifest;
  if (manifest.formatVersion !== 1 || manifest.backupId !== backupId || !Array.isArray(manifest.files)) throw new Error(`Invalid backup manifest: ${backupId}`);
  return manifest;
}

function safePathIn(root: string, backupId: string, child: string) {
  if (!/^[0-9TZ]+--[0-9a-f-]+$/.test(backupId)) throw new Error("Invalid backup ID");
  const backup = path.resolve(root, backupId);
  const target = path.resolve(backup, child);
  if (!target.startsWith(`${backup}${path.sep}`)) throw new Error("Backup path escapes its snapshot");
  return target;
}

function summaryOf(manifest: BackupManifest): BackupSummary {
  return { backupId: manifest.backupId, createdAt: manifest.createdAt, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes };
}

async function makeReadOnly(root: string) {
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else await chmod(fullPath, 0o444);
    }
    await chmod(directory, 0o555);
  };
  await visit(root);
}

async function makeWritable(root: string) {
  const info = await stat(root).catch(() => undefined);
  if (!info) return;
  await chmod(root, 0o755);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) await makeWritable(fullPath);
    else await chmod(fullPath, 0o644);
  }
}
