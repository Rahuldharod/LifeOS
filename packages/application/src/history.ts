import type { LifeOSObject } from "@lifeos/domain";
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

  /** IDs already checked against the versions store in this session (the store is the baseline that survives a restart). */
  private readonly checked = new Set<string>();

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
      if (!firstLook && current && sameContent(current, known)) { ctx.known.set(id, current); continue; }
      const relativePath = current?.relativePath ?? known.relativePath;
      // #69: the newest stored version is the baseline when it is at least as new as the in-memory one. That covers
      // a restart (edits made while the app was closed) and another device's LifeOS write, which syncs its version too.
      const stored = await ctx.objects.latestVersion?.(id);
      if (firstLook && !stored) await this.persist(known);
      const last = stored && stored.frontmatter.revision >= known.frontmatter.revision ? { ...stored, relativePath } : known;
      if (current) {
        ctx.known.set(id, current);
        if (sameContent(current, last)) continue;
        // A newer revision whose version has not synced yet (or the app stopped between write and version): a LifeOS
        // write, not an edit. It becomes the stored baseline, so an edit on top of it is caught later.
        if (current.frontmatter.revision > last.frontmatter.revision) { await this.persist(current); continue; }
      } else ctx.known.delete(id);
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

  /** Stores `object` as the last-known version. Audit events are append-only and are not versioned. */
  private async persist(object: LifeOSObject) {
    if (object.frontmatter.type !== "audit-event") await this.ctx.objects.keepVersion?.(object);
  }
}

/** Same front matter values and body. Key order and YAML formatting are not changes (#69). */
function sameContent(a: LifeOSObject, b: LifeOSObject) {
  return a.body === b.body && canonical(a.frontmatter) === canonical(b.frontmatter);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
