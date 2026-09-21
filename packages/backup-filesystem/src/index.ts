import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

const excludedPaths = new Set([".lifeos/session.md"]);

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
      for (const relativePath of sourceFiles) {
        const source = path.join(this.dataRoot, relativePath);
        const target = path.join(snapshotRoot, relativePath);
        const content = await readFile(source);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
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
      await this.makeReadOnly(destination);
      await this.prune();
      return this.summary(manifest);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async list(): Promise<BackupSummary[]> {
    const entries = await readdir(this.backupRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const backups: BackupSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".creating-")) continue;
      const manifest = await this.readManifest(entry.name).catch(() => undefined);
      if (manifest) backups.push(this.summary(manifest));
    }
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async verifyRestorable(backupId: string): Promise<BackupVerification> {
    const manifest = await this.readManifest(backupId);
    const snapshotRoot = this.safeBackupPath(backupId, "data");
    const snapshotDiagnostics = await this.verifyFiles(snapshotRoot, manifest);
    if (snapshotDiagnostics.length) return { ...this.summary(manifest), valid: false, restoredToTemporaryDirectory: false, diagnostics: snapshotDiagnostics };

    const restoreRoot = await mkdtemp(path.join(tmpdir(), "lifeos-restore-test-"));
    try {
      for (const entry of manifest.files) {
        const source = path.join(snapshotRoot, entry.path);
        const target = path.join(restoreRoot, entry.path);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      const diagnostics = await this.verifyFiles(restoreRoot, manifest);
      return { ...this.summary(manifest), valid: diagnostics.length === 0, restoredToTemporaryDirectory: true, diagnostics };
    } finally {
      await rm(restoreRoot, { recursive: true, force: true });
    }
  }

  private async verifyFiles(root: string, manifest: BackupManifest) {
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

  private async readManifest(backupId: string) {
    const content = await readFile(this.safeBackupPath(backupId, "manifest.json"), "utf8");
    const manifest = JSON.parse(content) as BackupManifest;
    if (manifest.formatVersion !== 1 || manifest.backupId !== backupId || !Array.isArray(manifest.files)) throw new Error(`Invalid backup manifest: ${backupId}`);
    return manifest;
  }

  private safeBackupPath(backupId: string, child: string) {
    if (!/^[0-9TZ]+--[0-9a-f-]+$/.test(backupId)) throw new Error("Invalid backup ID");
    const backup = path.resolve(this.backupRoot, backupId);
    const target = path.resolve(backup, child);
    if (!target.startsWith(`${backup}${path.sep}`)) throw new Error("Backup path escapes its snapshot");
    return target;
  }

  private summary(manifest: BackupManifest): BackupSummary {
    return { backupId: manifest.backupId, createdAt: manifest.createdAt, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes };
  }

  private async makeReadOnly(root: string) {
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

  private async makeWritable(root: string) {
    const info = await stat(root).catch(() => undefined);
    if (!info) return;
    await chmod(root, 0o755);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) await this.makeWritable(fullPath);
      else await chmod(fullPath, 0o644);
    }
  }

  private async prune() {
    if (this.retentionCount < 1) return;
    const backups = await this.list();
    for (const backup of backups.slice(this.retentionCount)) {
      const target = path.join(this.backupRoot, backup.backupId);
      await this.makeWritable(target);
      await rm(target, { recursive: true, force: true });
    }
  }
}
