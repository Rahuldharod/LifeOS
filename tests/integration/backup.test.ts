import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";

const roots: string[] = [];

async function makeWritable(root: string) {
  await chmod(root, 0o755).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) await makeWritable(fullPath);
    else await chmod(fullPath, 0o644).catch(() => undefined);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("versioned filesystem backups", () => {
  it("creates a checksum manifest and completes a temporary restoration drill", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lifeos-backup-"));
    roots.push(root);
    const dataRoot = path.join(root, "data");
    const backupRoot = path.join(root, "backups");
    await mkdir(path.join(dataRoot, "meetings"), { recursive: true });
    await mkdir(path.join(dataRoot, "assets"), { recursive: true });
    await mkdir(path.join(dataRoot, ".lifeos"), { recursive: true });
    await writeFile(path.join(dataRoot, "meetings", "note.md"), "# Note\n", "utf8");
    await writeFile(path.join(dataRoot, "assets", "example.bin"), new Uint8Array([0, 1, 2, 3]));
    await writeFile(path.join(dataRoot, ".lifeos", "session.md"), "temporary lease", "utf8");

    const service = new FilesystemBackupService(dataRoot, backupRoot);
    const created = await service.create();
    expect(created.fileCount).toBe(2);
    expect(await service.list()).toHaveLength(1);

    const manifest = JSON.parse(await readFile(path.join(backupRoot, created.backupId, "manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    expect(manifest.files.map((entry) => entry.path)).not.toContain(".lifeos/session.md");

    const verification = await service.verifyRestorable(created.backupId);
    expect(verification.valid).toBe(true);
    expect(verification.restoredToTemporaryDirectory).toBe(true);
    expect(verification.diagnostics).toEqual([]);
  });
});
