import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AppContext } from "./context.js";
import { SyncedSetting } from "./synced-settings.js";

/**
 * #84 (PRD stories 81–83, ADR 0004): automatic backups at app start, at a clean stop and daily while running; a weekly
 * checksum-verified copy to a folder outside Google Drive; and a warning when a backup fails or is overdue.
 * Backups run only while this device holds the lease (ADR 0003), in the background, one at a time in the queue they
 * share with adoption (#95, ADR 0013), so a snapshot never captures an adoption half done.
 */

export interface BackupSummary { backupId: string; createdAt: string; fileCount: number; totalBytes: number }

/** The snapshot store this module schedules; `@lifeos/backup-filesystem` implements it. */
export interface BackupService {
  create(): Promise<BackupSummary>;
  list(): Promise<BackupSummary[]>;
  verify(backupId: string): Promise<{ valid: boolean; diagnostics: string[] }>;
  copyTo(backupId: string, folder: string): Promise<BackupSummary>;
  listCopies(folder: string): Promise<BackupSummary[]>;
  /** Removes unfinished `.creating-*` snapshots a killed backup left behind (#95). */
  sweepStaging?(): Promise<unknown>;
}

export type BackupTrigger = "start" | "stop" | "daily" | "manual";
export type BackupWarningKind = "backup-failed" | "off-drive-failed" | "overdue";
/** Shown on Today and System Health: `message` says what is wrong in words, `reason` why. */
export interface BackupWarning { kind: BackupWarningKind; message: string; reason: string; at?: string }
export interface BackupStatus {
  running: boolean;
  lastBackup?: BackupSummary & { trigger: BackupTrigger };
  latestBackupAt?: string;
  offDriveFolder?: string;
  lastOffDriveCopy?: BackupSummary & { copiedAt: string };
  warning?: BackupWarning;
}

export interface AutoBackupOptions {
  /** Checked when each backup starts: only the device holding the lease writes backups. */
  canWrite?: () => boolean;
  now?: () => Date;
  /** How often the daily trigger looks at the age of the latest backup (default hourly). */
  checkMs?: number;
  onError?: (error: unknown, trigger: BackupTrigger) => void;
  /** How long `stop()` waits for the stop backup (default `stopBackupTimeoutMs`). */
  stopTimeoutMs?: number;
}

export interface AutoBackups {
  /** Back up now (the "Back up now" button); also writes the weekly off-Drive copy when it is due. */
  runNow(): Promise<BackupSummary>;
  /** The daily trigger: backs up when the latest backup is 24 hours old. Called by the timer; exposed for tests. */
  check(): Promise<void>;
  /**
   * The clean-stop backup, taken once however often it is called; then the timer stops. Gives up after
   * `stopTimeoutMs` (the backup is then never started later); the next start sweeps what it left behind.
   */
  stop(): Promise<void>;
  /** Stops the timer without a backup. */
  dispose(): void;
  whenIdle(): Promise<void>;
  status(): Promise<BackupStatus>;
}

/** `offDriveFolder` is this device's folder only (#95, ADR 0005); other devices' folders are kept but not shown. */
export interface BackupSettings { offDriveFolder?: string; contentHash?: string }

/**
 * #95: the stop backup gives up after this long. With the server's other bounded stop waits (`shutdownLimits`) it
 * stays below the kill timeout in `scripts/lifeos.mjs`, so the lease is still released after a slow backup.
 */
export const stopBackupTimeoutMs = 35_000;

const day = 24 * 60 * 60 * 1000;
/** A daily backup, plus two hours' grace for a sleeping laptop, before the warning shows (acceptance criterion). */
const overdueAfterMs = 26 * 60 * 60 * 1000;
const offDriveEveryMs = 7 * day;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Paths Google Drive for desktop syncs; the off-Drive folder must be outside them. */
function insideGoogleDrive(folder: string) {
  return /\/Library\/CloudStorage\/Google|\/(Google Drive|My Drive|Shared drives)(\/|$)|\/GoogleDrive-/i.test(folder);
}

/** The folder with symbolic links resolved (#95); a folder not created yet resolves through its nearest existing parent. */
async function resolveReal(folder: string): Promise<string> {
  const absolute = path.resolve(folder);
  const parent = path.dirname(absolute);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === absolute) throw error;
    return path.join(await resolveReal(parent), path.basename(absolute));
  }
}

/** Refuses a folder inside Google Drive, as typed or once its symbolic links are resolved. */
async function assertOffDrive(folder: string) {
  const outside = "Choose a folder outside Google Drive, so a Drive problem cannot take both data and backups";
  if (insideGoogleDrive(folder) || insideGoogleDrive(await resolveReal(folder))) throw new Error(outside);
}

type FolderMap = Record<string, string>;
const foldersOf = (frontmatter: Record<string, unknown> | undefined): FolderMap => {
  const raw = frontmatter?.off_drive_folders;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
};
/** A folder saved before #95 (`off_drive_folder`) belongs to the device that last saved the setting. */
const legacyFolders = (frontmatter: Record<string, unknown> | undefined): FolderMap => {
  const folder = frontmatter?.off_drive_folder;
  const device = frontmatter?.updated_by_device;
  return typeof folder === "string" && folder && typeof device === "string" ? { [device]: folder } : {};
};

export class BackupModule {
  private readonly setting: SyncedSetting;

  constructor(private readonly ctx: AppContext) {
    this.setting = new SyncedSetting(ctx, {
      key: "backups", title: "Backups",
      body: "# Backups\n\nEach device's weekly copy of the latest backup goes to its own folder outside Google Drive (four generations are kept).\n",
      changedMessage: "Backup settings changed on another device; reload and try again",
      removedMessage: "Backup settings were removed; reload and try again"
    });
  }

  /**
   * Read from disk so another device's edit is seen at once (ADR 0005). The folder is a local path, so it is stored
   * per device (keyed by device ID, #95): each device sees and uses only its own.
   */
  async settings(): Promise<BackupSettings> {
    const current = await this.setting.read();
    const frontmatter = current?.frontmatter as Record<string, unknown> | undefined;
    const folder = { ...legacyFolders(frontmatter), ...foldersOf(frontmatter) }[this.ctx.deviceId];
    return { ...(folder ? { offDriveFolder: folder } : {}), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  /**
   * Saves this device's off-Drive folder: a full local path outside Google Drive (symbolic links resolved); empty
   * clears it. Other devices' folders are kept. A guarded write (409 when stale).
   */
  async saveSettings(input: { offDriveFolder?: unknown }, expectedHash?: string): Promise<BackupSettings> {
    const { ctx } = this;
    const raw = input.offDriveFolder;
    if (raw !== undefined && raw !== null && typeof raw !== "string") throw new Error("Off-Drive backup folder must be text");
    const folder = typeof raw === "string" ? raw.trim() : "";
    if (folder && !path.isAbsolute(folder)) throw new Error("Enter the folder's full path, starting with /");
    if (folder) await assertOffDrive(folder);
    const written = await this.setting.save((previous) => {
      // The legacy single folder moves into the per-device map on this save.
      const folders = { ...legacyFolders(previous), ...foldersOf(previous) };
      if (folder) folders[ctx.deviceId] = path.normalize(folder);
      else delete folders[ctx.deviceId];
      return { off_drive_folder: undefined, off_drive_folders: Object.keys(folders).length ? folders : undefined };
    }, expectedHash);
    return { ...(folder ? { offDriveFolder: path.normalize(folder) } : {}), contentHash: written.contentHash };
  }

  start(service: BackupService, options: AutoBackupOptions = {}): AutoBackups {
    const { canWrite = () => true, now = () => new Date(), checkMs = 60 * 60 * 1000, onError, stopTimeoutMs = stopBackupTimeoutMs } = options;
    let pending = 0;
    let swept = false;
    let stopAbandoned = false;
    let idle: Promise<unknown> = Promise.resolve();
    let lastBackup: BackupStatus["lastBackup"];
    let lastOffDriveCopy: BackupStatus["lastOffDriveCopy"];
    let backupFailure: BackupWarning | undefined;
    let offDriveFailure: BackupWarning | undefined;
    let stopping: Promise<void> | undefined;
    /** When this process last took a backup, on its own clock: the daily window starts from the later of this and the newest backup. */
    let takenAt = 0;

    const latest = async () => (await service.list().catch(() => []))[0];

    /** Weekly: copies the latest verified backup when the folder is set and its newest copy is a week old. */
    const copyOffDrive = async (force: boolean) => {
      const { offDriveFolder } = await this.settings();
      if (!offDriveFolder) { offDriveFailure = undefined; return; }
      try {
        await assertOffDrive(offDriveFolder);
        const copies = await service.listCopies(offDriveFolder);
        const newest = copies[0];
        if (!force && newest && now().getTime() - Date.parse(newest.createdAt) < offDriveEveryMs) { offDriveFailure = undefined; return; }
        let source: BackupSummary | undefined;
        for (const backup of await service.list()) if ((await service.verify(backup.backupId)).valid) { source = backup; break; }
        if (!source) throw new Error("No verified backup to copy");
        if (newest?.backupId === source.backupId) { offDriveFailure = undefined; return; }
        const copied = await service.copyTo(source.backupId, offDriveFolder);
        lastOffDriveCopy = { ...copied, copiedAt: now().toISOString() };
        offDriveFailure = undefined;
      } catch (error) {
        offDriveFailure = { kind: "off-drive-failed", message: "Off-Drive backup copy failed", reason: message(error), at: now().toISOString() };
        onError?.(error, "daily");
      }
    };

    /** One backup at a time; `when` decides, once the backup's turn comes, whether it is still needed. */
    const backUp = (trigger: BackupTrigger, when: () => Promise<boolean> = async () => true) => {
      pending += 1;
      const work = this.ctx.runExclusive(async () => {
        try {
          if (!canWrite() || !(await when())) return undefined;
          // A backup killed part-way (e.g. by the stop script's timeout) leaves a `.creating-*` folder; swept once per run.
          if (!swept) { swept = true; await service.sweepStaging?.().catch((error: unknown) => onError?.(error, trigger)); }
          let created: BackupSummary;
          try {
            created = await service.create();
          } catch (error) {
            backupFailure = { kind: "backup-failed", message: "Backup failed", reason: message(error), at: now().toISOString() };
            onError?.(error, trigger);
            throw error;
          }
          lastBackup = { ...created, trigger };
          takenAt = now().getTime();
          backupFailure = undefined;
          await copyOffDrive(false);
          return created;
        } finally {
          pending -= 1;
        }
      });
      idle = work.catch(() => undefined);
      return work;
    };

    const check = async () => {
      if (stopping) return;
      await backUp("daily", async () => {
        const newest = await latest();
        return now().getTime() - Math.max(takenAt, newest ? Date.parse(newest.createdAt) : 0) >= day;
      }).catch(() => undefined);
    };

    // The start backup runs in the background: the caller (server start-up) never waits for it.
    void backUp("start").catch(() => undefined);
    const timer = setInterval(() => void check(), checkMs);
    timer.unref?.();

    return {
      runNow: async () => {
        const created = await backUp("manual");
        if (!created) throw new Error("This device does not hold the lease, so it cannot back up");
        return created;
      },
      check,
      stop: () => stopping ??= (async () => {
        clearInterval(timer);
        let limit: NodeJS.Timeout | undefined;
        const finished = await Promise.race([
          backUp("stop", async () => !stopAbandoned).then(() => true, () => true),
          new Promise<false>((resolve) => { limit = setTimeout(() => resolve(false), stopTimeoutMs); limit.unref?.(); })
        ]);
        clearTimeout(limit);
        if (finished) return;
        stopAbandoned = true;
        const reason = `The stop backup did not finish within ${Math.round(stopTimeoutMs / 1000)} s; the next start backs up again and clears what it left.`;
        backupFailure = { kind: "backup-failed", message: "Backup failed", reason, at: now().toISOString() };
        onError?.(new Error(reason), "stop");
      })(),
      dispose: () => clearInterval(timer),
      whenIdle: async () => { while (pending) await idle; },
      status: async () => {
        const newest = await latest();
        const { offDriveFolder } = await this.settings().catch(() => ({ offDriveFolder: undefined }));
        const running = pending > 0;
        const overdue: BackupWarning | undefined = !running && (!newest || now().getTime() - Date.parse(newest.createdAt) > overdueAfterMs)
          ? { kind: "overdue", message: "No backup in the last 26 hours", reason: newest ? `The latest backup is from ${newest.createdAt}.` : "No backup has been taken yet." }
          : undefined;
        const warning = backupFailure ?? offDriveFailure ?? overdue;
        return {
          running,
          ...(lastBackup ? { lastBackup } : {}),
          ...(newest ? { latestBackupAt: newest.createdAt } : {}),
          ...(offDriveFolder ? { offDriveFolder } : {}),
          ...(lastOffDriveCopy ? { lastOffDriveCopy } : {}),
          ...(warning ? { warning } : {})
        };
      }
    };
  }

  /** #95: the status before automatic backups start (or when they are off): always a JSON state, never empty. */
  async idleStatus(service: BackupService): Promise<BackupStatus> {
    const newest = (await service.list().catch(() => []))[0];
    const { offDriveFolder } = await this.settings().catch(() => ({ offDriveFolder: undefined }));
    return { running: false, ...(newest ? { latestBackupAt: newest.createdAt } : {}), ...(offDriveFolder ? { offDriveFolder } : {}) };
  }
}
