import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, type AutoBackups } from "@lifeos/application";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";

// #84 (PRD stories 81–83): automatic backups at start, stop and daily; a weekly off-Drive copy; a failure banner.
// Every root is a fresh temporary folder: no test touches the real data, backups or home folder.

const roots: string[] = [];
const running: AutoBackups[] = [];

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
  for (const auto of running.splice(0)) auto.dispose();
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-auto-backups-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const backupRoot = path.join(root, "backups");
  const offDrive = path.join(root, "off-drive");
  await mkdir(path.join(dataRoot, ".lifeos"), { recursive: true });
  await mkdir(path.join(dataRoot, "notes"), { recursive: true });
  await mkdir(offDrive);
  await writeFile(path.join(dataRoot, "notes", "note.md"), "# Note\n", "utf8");
  await writeFile(path.join(dataRoot, ".lifeos", "session.md"), "lease", "utf8");
  const application = new LifeOSApplication(new MarkdownObjectStore(dataRoot), new MemoryIndex(), undefined, undefined, "integration-test");
  await application.rebuildIndex();
  return { root, dataRoot, backupRoot, offDrive, application, service: new FilesystemBackupService(dataRoot, backupRoot) };
}

const hours = (count: number) => count * 60 * 60 * 1000;
const later = (ms: number) => () => new Date(Date.now() + ms);

function start(application: LifeOSApplication, service: Parameters<LifeOSApplication["startAutoBackups"]>[0], options: Parameters<LifeOSApplication["startAutoBackups"]>[1] = {}) {
  const auto = application.startAutoBackups(service, { checkMs: 60 * 60 * 1000, ...options });
  running.push(auto);
  return auto;
}

async function corrupt(backupRoot: string, backupId: string) {
  await makeWritable(path.join(backupRoot, backupId));
  await writeFile(path.join(backupRoot, backupId, "data", "notes", "note.md"), "# Tampered\n", "utf8");
}

describe("backup retention and off-Drive copies (ADR 0004)", () => {
  it("never includes session.md and keeps the newest generations", async () => {
    const { dataRoot, backupRoot } = await setup();
    const service = new FilesystemBackupService(dataRoot, backupRoot, 2);
    const first = await service.create();
    await service.create();
    const third = await service.create();
    const listed = await service.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]!.backupId).toBe(third.backupId);
    expect(listed.map((backup) => backup.backupId)).not.toContain(first.backupId);
    const manifest = JSON.parse(await readFile(path.join(backupRoot, third.backupId, "manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    expect(manifest.files.map((entry) => entry.path)).toEqual(["notes/note.md"]);
  });

  it("backs up an empty data folder (a fresh install's first start)", async () => {
    const { root } = await setup();
    const empty = path.join(root, "empty-data");
    await mkdir(empty);
    const service = new FilesystemBackupService(empty, path.join(root, "empty-backups"));
    const created = await service.create();
    expect(created.fileCount).toBe(0);
    expect((await service.verify(created.backupId)).valid).toBe(true);
  });

  it("pruning keeps the only verified backup even when it is past the retention count", async () => {
    const { dataRoot, backupRoot } = await setup();
    const service = new FilesystemBackupService(dataRoot, backupRoot);
    const older = await service.create();
    const newer = await service.create();
    await corrupt(backupRoot, newer.backupId);
    expect((await service.verify(newer.backupId)).valid).toBe(false);

    await new FilesystemBackupService(dataRoot, backupRoot, 1).prune();
    expect((await service.list()).map((backup) => backup.backupId).sort()).toEqual([older.backupId, newer.backupId].sort());
  });

  it("copies a backup off-Drive, checksum-verified and read-only, keeping four generations", async () => {
    const { dataRoot, backupRoot, offDrive } = await setup();
    const service = new FilesystemBackupService(dataRoot, backupRoot);
    const created: string[] = [];
    for (let count = 0; count < 5; count += 1) {
      const backup = await service.create();
      await service.copyTo(backup.backupId, offDrive);
      created.push(backup.backupId);
    }
    const copies = await service.listCopies(offDrive);
    expect(copies.map((copy) => copy.backupId)).toEqual(created.slice(1).reverse());
    expect(await readFile(path.join(offDrive, created[4]!, "data", "notes", "note.md"), "utf8")).toBe("# Note\n");
    await expect(writeFile(path.join(offDrive, created[4]!, "data", "notes", "note.md"), "x")).rejects.toThrow();
  });

  it("refuses to copy from a backup that fails its checksums, and to a missing folder", async () => {
    const { dataRoot, backupRoot, offDrive, root } = await setup();
    const service = new FilesystemBackupService(dataRoot, backupRoot);
    const backup = await service.create();
    await expect(service.copyTo(backup.backupId, path.join(root, "not-there"))).rejects.toThrow(/not found/);
    await corrupt(backupRoot, backup.backupId);
    await expect(service.copyTo(backup.backupId, offDrive)).rejects.toThrow(/Checksum mismatch/);
    expect(await service.listCopies(offDrive)).toEqual([]);
  });
});

describe("off-Drive backup folder setting (ADR 0005)", () => {
  it("is unset by default, saves an absolute local folder, and refuses Google Drive or relative paths", async () => {
    const { application, offDrive } = await setup();
    expect(await application.getBackupSettings()).toEqual({});
    const saved = await application.saveBackupSettings({ offDriveFolder: offDrive }, undefined);
    expect(saved.offDriveFolder).toBe(offDrive);
    expect(await application.getBackupSettings()).toEqual(saved);
    await expect(application.saveBackupSettings({ offDriveFolder: "backups" }, saved.contentHash)).rejects.toThrow(/full path/);
    await expect(application.saveBackupSettings({ offDriveFolder: "/Users/someone/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/x" }, saved.contentHash)).rejects.toThrow(/outside Google Drive/);
    await expect(application.saveBackupSettings({ offDriveFolder: offDrive }, "stale")).rejects.toThrow(/another device/);
    const cleared = await application.saveBackupSettings({ offDriveFolder: "" }, saved.contentHash);
    expect(cleared.offDriveFolder).toBeUndefined();
  });
});

describe("automatic backups (#84)", () => {
  it("takes one backup at start without blocking the caller, and lists it", async () => {
    const { application, service } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = { ...service, list: () => service.list(), verify: (id: string) => service.verify(id), copyTo: (id: string, folder: string) => service.copyTo(id, folder), listCopies: (folder: string) => service.listCopies(folder), create: async () => { await gate; return service.create(); } };
    const auto = start(application, slow);
    expect(await service.list()).toEqual([]);
    expect((await auto.status()).running).toBe(true);
    release();
    await auto.whenIdle();
    expect(await service.list()).toHaveLength(1);
    expect((await auto.status()).lastBackup?.trigger).toBe("start");
  });

  it("takes one backup at a clean stop, however many times stop is called", async () => {
    const { application, service } = await setup();
    const auto = start(application, service);
    await auto.whenIdle();
    await Promise.all([auto.stop(), auto.stop()]);
    expect(await service.list()).toHaveLength(2);
    expect((await auto.status()).lastBackup?.trigger).toBe("stop");
  });

  it("takes a daily backup only once the latest is 24 hours old", async () => {
    const { application, service } = await setup();
    let offset = 0;
    const auto = start(application, service, { now: () => new Date(Date.now() + offset) });
    await auto.whenIdle();
    offset = hours(23);
    await auto.check();
    expect(await service.list()).toHaveLength(1);
    offset = hours(25);
    await auto.check();
    await auto.check();
    expect(await service.list()).toHaveLength(2);
    expect((await auto.status()).lastBackup?.trigger).toBe("daily");
  });

  it("runs nothing on a device that does not hold the lease", async () => {
    const { application, service } = await setup();
    const auto = start(application, service, { canWrite: () => false, now: later(hours(30)) });
    await auto.whenIdle();
    await auto.check();
    await auto.stop();
    expect(await service.list()).toEqual([]);
  });

  it("writes a weekly off-Drive copy of the latest backup once the folder is set", async () => {
    const { application, service, offDrive } = await setup();
    await application.saveBackupSettings({ offDriveFolder: offDrive }, undefined);
    let offset = 0;
    const auto = start(application, service, { now: () => new Date(Date.now() + offset) });
    await auto.whenIdle();
    const first = await service.listCopies(offDrive);
    expect(first).toHaveLength(1);
    expect((await auto.status()).lastOffDriveCopy?.backupId).toBe(first[0]!.backupId);

    // A daily backup within the week is not copied; one after a week is.
    offset = hours(25);
    await auto.check();
    expect(await service.listCopies(offDrive)).toHaveLength(1);
    offset = hours(24 * 7 + 1);
    await auto.check();
    const copies = await service.listCopies(offDrive);
    expect(copies).toHaveLength(2);
    expect(copies[0]!.backupId).toBe((await service.list())[0]!.backupId);
  });
});

describe("backup warning banner (#84)", () => {
  it("shows the reason when a backup fails, and clears after the next success", async () => {
    const { application, root, dataRoot } = await setup();
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "a file where the backup folder should be", "utf8");
    const failing = new FilesystemBackupService(dataRoot, blocked);
    const auto = start(application, failing);
    await auto.whenIdle();
    const warning = (await auto.status()).warning;
    expect(warning?.kind).toBe("backup-failed");
    expect(warning?.message).toMatch(/Backup failed/);
    expect(warning?.reason).toBeTruthy();

    await rm(blocked);
    await auto.runNow();
    expect((await auto.status()).warning).toBeUndefined();
  });

  it("shows a failed off-Drive copy with its reason", async () => {
    const { application, service, root } = await setup();
    await application.saveBackupSettings({ offDriveFolder: path.join(root, "unplugged-disk") }, undefined);
    const auto = start(application, service);
    await auto.whenIdle();
    const status = await auto.status();
    expect(status.lastBackup).toBeDefined();
    expect(status.warning?.kind).toBe("off-drive-failed");
    expect(status.warning?.reason).toMatch(/not found/);
  });

  it("warns when no backup succeeded in the last 26 hours, and not before", async () => {
    const { application, service } = await setup();
    await service.create();
    const idle = async (auto: AutoBackups) => { await auto.whenIdle(); return auto; };
    expect((await (await idle(start(application, service, { canWrite: () => false, now: later(hours(25)) }))).status()).warning).toBeUndefined();
    const overdue = (await (await idle(start(application, service, { canWrite: () => false, now: later(hours(27)) }))).status()).warning;
    expect(overdue?.kind).toBe("overdue");
    expect(overdue?.message).toMatch(/No backup in the last 26 hours/);
  });

  it("warns when there has never been a backup", async () => {
    const { application, service } = await setup();
    const auto = start(application, service, { canWrite: () => false });
    await auto.whenIdle();
    expect((await auto.status()).warning?.kind).toBe("overdue");
  });
});
