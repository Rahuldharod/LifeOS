import type { AppContext } from "./context.js";

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
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: AppContext) {}

  /** Runs one detection at a time, so overlapping watcher callbacks cannot record the same change twice. */
  recordExternalChanges(): Promise<ExternalChange[]> {
    const run = this.queue.then(() => this.detect());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async detect() {
    const { ctx } = this;
    const activity = ctx.writeActivity();
    await ctx.rebuildIndex();
    const now = new Date().toISOString();
    const recorded: ExternalChange[] = [];
    for (const [id, last] of [...ctx.known]) {
      // The app's own writes, in flight or just finished, are not external; their watcher event triggers another pass.
      if (ctx.busySince(activity, id) || ctx.index.duplicatePaths?.(id)) continue;
      const current = ctx.index.get(id);
      if (current) {
        ctx.known.set(id, current);
        if (current.contentHash === last.contentHash) continue;
        // Another device's LifeOS write arriving through sync: it bumped the revision and kept its own prior version.
        if (current.frontmatter.revision > last.frontmatter.revision && current.frontmatter.updated_by_device !== ctx.deviceId) continue;
      } else ctx.known.delete(id);
      const change = current ? "changed" : ctx.index.diagnostics().some((entry) => entry.startsWith(`${last.relativePath}:`)) ? "unreadable" : "deleted";
      const versionPath = await ctx.objects.keepVersion?.(last);
      await ctx.writeAudit(change === "unreadable" ? "object.made-unreadable-externally" : `object.${change}-externally`, id, now, {
        relative_path: current?.relativePath ?? last.relativePath,
        previous_hash: last.contentHash,
        ...(current ? { current_hash: current.contentHash } : {}),
        ...(versionPath ? { version_path: versionPath } : {}),
        observed_by_device: ctx.deviceId
      }, { type: "external" });
      recorded.push({ objectId: id, change, relativePath: current?.relativePath ?? last.relativePath, ...(versionPath ? { versionPath } : {}) });
    }
    if (recorded.length) await ctx.rebuildIndex();
    return recorded;
  }
}
