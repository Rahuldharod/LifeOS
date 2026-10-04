import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOSApplication, stopBackupTimeoutMs, type AutoBackups, type BackupService, type InboxStore } from "@lifeos/application";
import { FilesystemBackupService } from "@lifeos/backup-filesystem";
import { MemoryIndex } from "@lifeos/index-memory";
import { MarkdownObjectStore } from "@lifeos/object-store-markdown";
import { shutDown, shutdownLimits } from "../../apps/server/src/shutdown.js";

// #95: a safe stop sequence, one queue for backups and adoption, a bounded stop backup, stale staging swept,
// a per-device off-Drive folder resolved through symlinks, and a status that always answers.
// Every root is a fresh temporary folder: no test touches the real data, backups or home folder.

const roots: string[] = [];
const running: AutoBackups[] = [];

async function makeWritable(root: string) {
  await chmod(root, 0o755).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await makeWritable(fullPath);
    else if (entry.isFile()) await chmod(fullPath, 0o644).catch(() => undefined);
  }
}

afterEach(async () => {
  for (const auto of running.splice(0)) auto.dispose();
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

const exists = (file: string) => access(file).then(() => true, () => false);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A gate a fake waits on until the test opens it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

async function setup(deviceId = "mac-a", inbox?: InboxStore) {
  const root = await mkdtemp(path.join(tmpdir(), "lifeos-backup-stop-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const backupRoot = path.join(root, "backups");
  const offDrive = path.join(root, "off-drive");
  await mkdir(path.join(dataRoot, "notes"), { recursive: true });
  await mkdir(offDrive);
  await writeFile(path.join(dataRoot, "notes", "note.md"), "# Note\n", "utf8");
  const application = await open(dataRoot, deviceId, inbox);
  return { root, dataRoot, backupRoot, offDrive, application, service: new FilesystemBackupService(dataRoot, backupRoot) };
}

async function open(dataRoot: string, deviceId: string, inbox?: InboxStore) {
  const application = new LifeOSApplication(new MarkdownObjectStore(dataRoot), new MemoryIndex(), undefined, undefined, deviceId, inbox);
  await application.rebuildIndex();
  return application;
}

function start(application: LifeOSApplication, service: BackupService, options: Parameters<LifeOSApplication["startAutoBackups"]>[1] = {}) {
  const auto = application.startAutoBackups(service, { checkMs: 60 * 60 * 1000, ...options });
  running.push(auto);
  return auto;
}

/** Wraps the real service so `create` waits on `until` first. */
function slowCreate(service: FilesystemBackupService, until: Promise<void>): BackupService {
  return {
    create: async () => { await until; return service.create(); },
    list: () => service.list(),
    verify: (id) => service.verify(id),
    copyTo: (id, folder) => service.copyTo(id, folder),
    listCopies: (folder) => service.listCopies(folder),
    sweepStaging: () => service.sweepStaging()
  };
}

/** An inbox whose batch holds at `ensureFolders` until the test opens the gate; it has no drafts. */
function heldInbox(until: Promise<void>, started: () => void): InboxStore {
  return {
    ensureFolders: async () => { started(); await until; },
    list: async () => [],
    read: async () => { throw new Error("no drafts"); },
    move: async () => { throw new Error("no drafts"); },
    writeDocument: async () => { throw new Error("no drafts"); }
  };
}

describe("one queue for backups and adoption (ADR 0013, #95)", () => {
  it("an adoption batch waits for a backup in progress", async () => {
    const hold = gate();
    const { application, service } = await setup();
    const auto = start(application, slowCreate(service, hold.opened));
    let adopted = false;
    const batch = application.adoptDrafts().then(() => { adopted = true; });
    await settle();
    expect(adopted).toBe(false);
    hold.open();
    await batch;
    await auto.whenIdle();
    expect(adopted).toBe(true);
  });

  it("a backup waits for an adoption batch in progress", async () => {
    const hold = gate();
    let batchStarted = false;
    const { application, service, backupRoot } = await setup("mac-a", heldInbox(hold.opened, () => { batchStarted = true; }));
    const batch = application.adoptDrafts();
    await settle();
    expect(batchStarted).toBe(true);
    start(application, service);
    await settle();
    expect(await exists(backupRoot)).toBe(false);
    hold.open();
    await batch;
    await running[0]!.whenIdle();
    expect(await service.list()).toHaveLength(1);
  });

  it("stopping auto-adoption waits for the batch in progress", async () => {
    const hold = gate();
    let batchStarted = false;
    const { application } = await setup("mac-a", heldInbox(hold.opened, () => { batchStarted = true; }));
    const adoption = application.startAutoAdoption({ sweepMs: 60 * 60 * 1000 });
    void adoption.runNow();
    await settle();
    expect(batchStarted).toBe(true);
    let stopped = false;
    const stopping = adoption.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    hold.open();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("stop sequence (#95)", () => {
  it("stops writes, closes HTTP, waits for adoption, backs up, then closes the session", async () => {
    const order: string[] = [];
    const step = (name: string) => async () => { order.push(name); };
    await shutDown({
      stopWrites: () => order.push("writes"),
      stopTriggers: () => order.push("triggers"),
      closeHttp: step("http"),
      waitForIdle: step("idle"),
      stopBackup: step("backup"),
      closeSession: step("session"),
      log: () => undefined
    });
    expect(order).toEqual(["writes", "triggers", "http", "idle", "backup", "session"]);
  });

  it("still backs up and closes the session when an earlier step fails or hangs", async () => {
    const order: string[] = [];
    const logged: string[] = [];
    await shutDown({
      stopWrites: () => order.push("writes"),
      stopTriggers: () => { throw new Error("watcher already closed"); },
      closeHttp: () => new Promise(() => undefined),
      waitForIdle: async () => { throw new Error("adoption failed"); },
      stopBackup: async () => { order.push("backup"); },
      closeSession: async () => { order.push("session"); },
      log: (_error, step) => logged.push(step)
    }, { httpMs: 20, idleMs: 20 });
    expect(order).toEqual(["writes", "backup", "session"]);
    expect(logged).toEqual(["triggers", "http", "idle"]);
  });

  it("finishes every bounded wait before the stop script's kill timeout", async () => {
    const script = await readFile(path.join(process.cwd(), "scripts", "lifeos.mjs") /* vitest runs from the repository root */, "utf8");
    const killAfterMs = Number(/const stopKillAfterMs = ([\d_]+);/.exec(script)?.[1]?.replace(/_/g, ""));
    expect(killAfterMs).toBeGreaterThan(0);
    // Session close and exit need a few seconds of the remaining margin.
    expect(shutdownLimits.httpMs + shutdownLimits.idleMs + stopBackupTimeoutMs).toBeLessThanOrEqual(killAfterMs - 5_000);
  });
});

describe("bounded stop backup and stale staging (#95)", () => {
  it("gives up on a stop backup after its timeout, says so, and never starts it later", async () => {
    const { application, service } = await setup();
    const auto = start(application, service);
    await auto.whenIdle();
    const hold = gate();
    const hung = start(application, slowCreate(service, hold.opened), { stopTimeoutMs: 30 });
    const startedAt = Date.now();
    await hung.stop();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const status = await hung.status();
    expect(status.warning?.kind).toBe("backup-failed");
    expect(status.warning?.reason).toMatch(/did not finish/);
    hold.open();
    await hung.whenIdle();
    // The start backup of `hung` completes; the abandoned stop backup does not run after the stop.
    expect(await service.list()).toHaveLength(2);
  });

  it("sweeps unfinished `.creating-*` folders left by a killed backup when backups start", async () => {
    const { application, service, backupRoot } = await setup();
    const stale = path.join(backupRoot, ".creating-20261004T090000Z--00000000-0000-0000-0000-000000000000");
    await mkdir(path.join(stale, "data", "notes"), { recursive: true });
    await writeFile(path.join(stale, "data", "notes", "note.md"), "# Half\n", "utf8");
    await chmod(path.join(stale, "data", "notes", "note.md"), 0o444);
    await chmod(path.join(stale, "data", "notes"), 0o555);
    const auto = start(application, service);
    await auto.whenIdle();
    expect(await exists(stale)).toBe(false);
    expect(await service.list()).toHaveLength(1);
  });

  it("sweeps unfinished copies in the off-Drive folder before copying", async () => {
    const { service, offDrive } = await setup();
    const stale = path.join(offDrive, ".creating-20261001T090000Z--00000000-0000-0000-0000-000000000000");
    await mkdir(path.join(stale, "data"), { recursive: true });
    const backup = await service.create();
    await service.copyTo(backup.backupId, offDrive);
    expect(await exists(stale)).toBe(false);
    expect((await service.listCopies(offDrive)).map((copy) => copy.backupId)).toEqual([backup.backupId]);
  });
});

describe("per-device off-Drive folder (ADR 0005, #95)", () => {
  it("keeps each device's folder separate in the synced setting", async () => {
    const { application: macA, dataRoot, root } = await setup("mac-a");
    const macB = await open(dataRoot, "mac-b");
    const folderA = path.join(root, "disk-a");
    const folderB = path.join(root, "disk-b");
    await mkdir(folderA);
    await mkdir(folderB);
    const savedA = await macA.saveBackupSettings({ offDriveFolder: folderA }, undefined);
    expect(savedA.offDriveFolder).toBe(folderA);
    const seenByB = await macB.getBackupSettings();
    expect(seenByB.offDriveFolder).toBeUndefined();
    const savedB = await macB.saveBackupSettings({ offDriveFolder: folderB }, seenByB.contentHash);
    expect(savedB.offDriveFolder).toBe(folderB);
    expect((await macA.getBackupSettings()).offDriveFolder).toBe(folderA);
    const clearedB = await macB.saveBackupSettings({ offDriveFolder: "" }, savedB.contentHash);
    expect(clearedB.offDriveFolder).toBeUndefined();
    expect((await macA.getBackupSettings()).offDriveFolder).toBe(folderA);
  });

  it("reads a folder saved before #95 only on the device that saved it, and keeps it on the next save", async () => {
    const { application: macA, dataRoot, root } = await setup("mac-a");
    const legacy = path.join(root, "legacy-disk");
    await mkdir(path.join(dataRoot, "settings"), { recursive: true });
    await writeFile(path.join(dataRoot, "settings", "backups.md"), `---\nid: 01920000-0000-7000-8000-000000000001\ntype: app-setting\nschema_version: 1\nrevision: 1\ntitle: Backups\ncreated_at: 2026-10-01T09:00:00.000Z\nupdated_at: 2026-10-01T09:00:00.000Z\nupdated_by_device: mac-a\norigin: app\nsetting_key: backups\noff_drive_folder: ${legacy}\n---\n# Backups\n`, "utf8");
    await macA.rebuildIndex();
    const macB = await open(dataRoot, "mac-b");
    expect((await macA.getBackupSettings()).offDriveFolder).toBe(legacy);
    const seenByB = await macB.getBackupSettings();
    expect(seenByB.offDriveFolder).toBeUndefined();
    const folderB = path.join(root, "disk-b");
    await mkdir(folderB);
    await macB.saveBackupSettings({ offDriveFolder: folderB }, seenByB.contentHash);
    expect((await macA.getBackupSettings()).offDriveFolder).toBe(legacy);
    expect((await macB.getBackupSettings()).offDriveFolder).toBe(folderB);
  });

  it("refuses a folder that reaches Google Drive through a symbolic link", async () => {
    const { application, root } = await setup();
    const drive = path.join(root, "Library", "CloudStorage", "GoogleDrive-someone@example.com", "My Drive", "LifeOS");
    await mkdir(drive, { recursive: true });
    const link = path.join(root, "innocent-looking");
    await symlink(drive, link);
    await expect(application.saveBackupSettings({ offDriveFolder: link }, undefined)).rejects.toThrow(/outside Google Drive/);
    // A folder not created yet is judged by its nearest existing parent.
    await expect(application.saveBackupSettings({ offDriveFolder: path.join(link, "not-yet") }, undefined)).rejects.toThrow(/outside Google Drive/);
  });

  it("refuses an off-Drive copy into the data folder through a symbolic link", async () => {
    const { service, dataRoot, root } = await setup();
    const link = path.join(root, "data-link");
    await symlink(dataRoot, link);
    const backup = await service.create();
    await expect(service.copyTo(backup.backupId, link)).rejects.toThrow(/must be outside/);
  });
});

describe("backup status before backups start (#95)", () => {
  it("answers a JSON state, not an empty body", async () => {
    const { application, service } = await setup();
    const status = await application.backupStatus(service);
    expect(status).toEqual({ running: false });
    await service.create();
    expect((await application.backupStatus(service)).latestBackupAt).toBeTruthy();
  });
});
