import type { LifeOSObject } from "@lifeos/domain";
import type { AppContext } from "./context.js";
import { OneAtATime } from "./support.js";

export interface ExternalChange {
  objectId: string;
  change: "changed" | "deleted" | "unreadable";
  relativePath: string;
  /** Where the last-known copy was kept; restore it with a guarded write. Absent if the store keeps no versions. */
  versionPath?: string;
}

/**
 * U4, U5: when the watcher reports file activity, finds objects changed, deleted or made unreadable
 * outside the app (Obsidian, Drive, an agent), keeps the last-known copy in the versions store and
 * writes an `external` audit event, so the user can see and undo the change.
 */
export class HistoryModule {
  private readonly queue = new OneAtATime();

  constructor(private readonly ctx: AppContext) {}

  /** Runs one detection at a time, so overlapping watcher callbacks cannot record the same change twice. */
  recordExternalChanges(): Promise<ExternalChange[]> {
    return this.queue.run("detect", () => this.detect());
  }

  /** IDs already checked against the versions store in this session (the store is the baseline that survives a restart). */
  private readonly checked = new Set<string>();
  /** #72: IDs holding another device's newer revision whose version file has not synced yet; checked again every pass. */
  private readonly awaitingVersion = new Set<string>();

  private async detect() {
    const { ctx } = this;
    const activity = ctx.writeActivity();
    await ctx.rebuildIndex();
    const now = new Date().toISOString();
    const recorded: ExternalChange[] = [];
    for (const [id, known] of [...ctx.known]) {
      // The app's own writes, in flight or just finished, are not external; their watcher event triggers another pass.
      if (ctx.busySince(activity, id) || ctx.index.duplicatePaths?.(id)) continue;
      const current = ctx.index.get(id);
      const firstLook = !this.checked.has(id);
      this.checked.add(id);
      if (!firstLook && current && sameContent(current, known) && !this.awaitingVersion.has(id)) { ctx.known.set(id, current); continue; }
      const relativePath = current?.relativePath ?? known.relativePath;
      // #72: the newest version's file name carries its revision and the hash of the file it copies. When the file on
      // disk has that revision and hash, nothing changed and no version file is read (the cheap check at every start).
      const info = await ctx.objects.latestVersionInfo?.(id);
      if (current && info && info.revision === current.frontmatter.revision && info.revision >= known.frontmatter.revision && current.contentHash.startsWith(info.hashPrefix)) {
        ctx.known.set(id, current);
        this.awaitingVersion.delete(id);
        continue;
      }
      // #69: the newest stored version is the baseline when it is at least as new as the in-memory one. That covers
      // a restart (edits made while the app was closed) and another device's LifeOS write, which syncs its version too.
      const stored = info ? await ctx.objects.read(info.relativePath).catch(() => undefined) : await ctx.objects.latestVersion?.(id);
      if (firstLook && !stored) await this.persist(known);
      // While waiting for another device's version, the in-memory copy is that unchecked file: compare with the store.
      const last = stored && (this.awaitingVersion.has(id) || stored.frontmatter.revision >= known.frontmatter.revision) ? stored : known;
      if (current) {
        ctx.known.set(id, current);
        if (sameContent(current, last)) { this.awaitingVersion.delete(id); continue; }
        if (current.frontmatter.revision > last.frontmatter.revision) {
          // A newer revision with no stored version yet. Stamped by this device: a LifeOS write whose version was not
          // saved (the app stopped in between), so it becomes the baseline. Stamped by another device: its version has
          // not synced yet. #72: wait for it instead of trusting the file, which may carry an Obsidian edit on top.
          if (current.frontmatter.updated_by_device === ctx.deviceId) await this.persist(current);
          else this.awaitingVersion.add(id);
          continue;
        }
      } else ctx.known.delete(id);
      this.awaitingVersion.delete(id);
      const change = current ? "changed" : ctx.index.diagnostics().some((entry) => entry.startsWith(`${relativePath}:`)) ? "unreadable" : "deleted";
      const versionPath = await ctx.objects.keepVersion?.(last);
      await ctx.writeAudit(change === "unreadable" ? "object.made-unreadable-externally" : `object.${change}-externally`, id, now, {
        relative_path: relativePath,
        previous_hash: last.contentHash,
        ...(current ? { current_hash: current.contentHash } : {}),
        ...(versionPath ? { version_path: versionPath } : {}),
        observed_by_device: ctx.deviceId
      }, { type: "external" });
      // The edited content is the new baseline, so the next start does not report it again.
      if (current) await this.persist(current);
      recorded.push({ objectId: id, change, relativePath, ...(versionPath ? { versionPath } : {}) });
    }
    if (recorded.length) await ctx.rebuildIndex();
    return recorded;
  }

  /**
   * #79: puts back the copy an external-change audit event kept, through a guarded write (or a create when the
   * file was deleted), audited as `object.restored-from-version`. Only the last copies are kept (ADR 0012), so a
   * copy pruned since is refused with a plain message and nothing changes.
   */
  async restoreVersion(auditEventId: string, now = new Date()) {
    const { ctx } = this;
    const event = ctx.index.get(auditEventId);
    const versionPath = event?.frontmatter.type === "audit-event" ? (event.frontmatter.metadata as Record<string, unknown> | undefined)?.version_path : undefined;
    if (typeof versionPath !== "string") throw new Error(`Not an external change with a kept version: ${auditEventId}`);
    const kept = await ctx.objects.read(versionPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(versionPrunedMessage);
      throw error;
    });
    const id = String(event!.frontmatter.object_id);
    const current = ctx.index.get(id);
    const timestamp = now.toISOString();
    const restored = await ctx.objects.write({
      relativePath: current?.relativePath ?? String((event!.frontmatter.metadata as Record<string, unknown>).relative_path),
      ...(current ? { expectedHash: current.contentHash } : {}),
      frontmatter: { ...kept.frontmatter, revision: (current?.frontmatter.revision ?? kept.frontmatter.revision) + 1, updated_at: timestamp, updated_by_device: ctx.deviceId },
      body: kept.body
    });
    await ctx.writeAudit("object.restored-from-version", id, timestamp, { audit_event_id: auditEventId, version_path: versionPath });
    await ctx.rebuildIndex();
    return restored;
  }

  /** Stores `object` as the last-known version. Audit events are append-only and are not versioned. */
  private async persist(object: LifeOSObject) {
    if (object.frontmatter.type !== "audit-event") await this.ctx.objects.keepVersion?.(object);
  }
}

/** #79: shown when an audit names a version copy that retention (ADR 0012) has since deleted. */
export const versionPrunedMessage = "This version is no longer kept (only the last 10 are)";

/** Same front matter values and body. Key order and YAML formatting are not changes (#69). */
function sameContent(a: LifeOSObject, b: LifeOSObject) {
  return a.body === b.body && canonical(a.frontmatter) === canonical(b.frontmatter);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
