import path from "node:path";
import { uuidV7, type ObjectEnvelope } from "@lifeos/domain";
import { ObjectConflictError, type AppContext } from "./context.js";
import { OneAtATime } from "./support.js";

/**
 * #84 (PRD stories 81–83, ADR 0004): automatic backups at app start, at a clean stop and daily while running; a weekly
 * checksum-verified copy to a folder outside Google Drive; and a warning when a backup fails or is overdue.
 * Backups run only while this device holds the lease (ADR 0003), one at a time, in the background.
 */

export interface BackupSummary { backupId: string; createdAt: string; fileCount: number; totalBytes: number }

/** The snapshot store this module schedules; `@lifeos/backup-filesystem` implements it. */
export interface BackupService {
  create(): Promise<BackupSummary>;
  list(): Promise<BackupSummary[]>;
  verify(backupId: string): Promise<{ valid: boolean; diagnostics: string[] }>;
  copyTo(backupId: string, folder: string): Promise<BackupSummary>;
  listCopies(folder: string): Promise<BackupSummary[]>;
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
}

export interface AutoBackups {
  /** Back up now (the "Back up now" button); also writes the weekly off-Drive copy when it is due. */
  runNow(): Promise<BackupSummary>;
  /** The daily trigger: backs up when the latest backup is 24 hours old. Called by the timer; exposed for tests. */
  check(): Promise<void>;
  /** The clean-stop backup, taken once however often it is called; then the timer stops. */
  stop(): Promise<void>;
  /** Stops the timer without a backup. */
  dispose(): void;
  whenIdle(): Promise<void>;
  status(): Promise<BackupStatus>;
}

export interface BackupSettings { offDriveFolder?: string; contentHash?: string }

const backupSettingsPath = "settings/backups.md";
const day = 24 * 60 * 60 * 1000;
/** A daily backup, plus two hours' grace for a sleeping laptop, before the warning shows (acceptance criterion). */
const overdueAfterMs = 26 * 60 * 60 * 1000;
const offDriveEveryMs = 7 * day;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Paths Google Drive for desktop syncs; the off-Drive folder must be outside them. */
function insideGoogleDrive(folder: string) {
  return /\/Library\/CloudStorage\/Google|\/(Google Drive|My Drive|Shared drives)(\/|$)|\/GoogleDrive-/i.test(folder);
}

export class BackupModule {
  constructor(private readonly ctx: AppContext) {}

  /** Read from disk so another device's edit is seen at once (ADR 0005). */
  async settings(): Promise<BackupSettings> {
    const current = await this.readSetting();
    const folder = current?.frontmatter.off_drive_folder;
    return { ...(typeof folder === "string" && folder ? { offDriveFolder: folder } : {}), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  /** Saves the off-Drive folder: a full local path outside Google Drive; empty clears it. A guarded write (409 when stale). */
  async saveSettings(input: { offDriveFolder?: unknown }, expectedHash?: string): Promise<BackupSettings> {
    const { ctx } = this;
    const raw = input.offDriveFolder;
    if (raw !== undefined && raw !== null && typeof raw !== "string") throw new Error("Off-Drive backup folder must be text");
    const folder = typeof raw === "string" ? raw.trim() : "";
    if (folder && !path.isAbsolute(folder)) throw new Error("Enter the folder's full path, starting with /");
    if (folder && insideGoogleDrive(folder)) throw new Error("Choose a folder outside Google Drive, so a Drive problem cannot take both data and backups");
    const current = await this.readSetting();
    if (current && current.contentHash !== expectedHash) throw new ObjectConflictError("Backup settings changed on another device; reload and try again");
    if (!current && expectedHash) throw new ObjectConflictError("Backup settings were removed; reload and try again");
    const now = new Date().toISOString();
    const { off_drive_folder: _previous, ...rest } = (current?.frontmatter ?? {}) as ObjectEnvelope & { off_drive_folder?: unknown };
    const written = await ctx.objects.write({
      relativePath: backupSettingsPath,
      expectedHash: current?.contentHash,
      frontmatter: {
        ...rest,
        ...(current ? { revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: ctx.deviceId } : ctx.envelope(uuidV7(), "app-setting", "Backups", now)),
        setting_key: "backups",
        ...(folder ? { off_drive_folder: path.normalize(folder) } : {})
      } as ObjectEnvelope,
      body: current?.body ?? "# Backups\n\nA weekly copy of the latest backup goes to this folder outside Google Drive (four generations are kept).\n"
    });
    await ctx.rebuildIndex();
    return { ...(folder ? { offDriveFolder: path.normalize(folder) } : {}), contentHash: written.contentHash };
  }

  start(service: BackupService, options: AutoBackupOptions = {}): AutoBackups {
    const { canWrite = () => true, now = () => new Date(), checkMs = 60 * 60 * 1000, onError } = options;
    const queue = new OneAtATime();
    let pending = 0;
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
      const work = queue.run("backup", async () => {
        try {
          if (!canWrite() || !(await when())) return undefined;
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
        await backUp("stop").catch(() => undefined);
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

  private async readSetting() {
    try { return await this.ctx.objects.read(backupSettingsPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
}
