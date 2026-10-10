import type { LifeOSObject } from "@lifeos/domain";
import { ObjectConflictError, type AppContext } from "./context.js";
import { isRestricted, OneAtATime } from "./support.js";

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
      // #80: on first look the in-memory copy is just the file found at start. If it is newer than the store, it is an
      // unchecked write, so compare with the store: that waits for another device's version, or persists our own write.
      const aheadOfStore = firstLook && current && stored && current.frontmatter.revision > stored.frontmatter.revision;
      const last = stored && (aheadOfStore || this.awaitingVersion.has(id) || stored.frontmatter.revision >= known.frontmatter.revision) ? stored : known;
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
    const event = this.ctx.index.get(auditEventId);
    const metadata = event?.frontmatter.type === "audit-event" ? event.frontmatter.metadata as Record<string, unknown> | undefined : undefined;
    const versionPath = metadata?.version_path;
    if (typeof versionPath !== "string") throw new Error(`Not an external change with a kept version: ${auditEventId}`);
    return this.putBack(String(event!.frontmatter.object_id), versionPath, String(metadata!.relative_path), { audit_event_id: auditEventId }, now);
  }

  /**
   * #85: the history of one object, newest first: its kept version copies (ADR 0012) and the audit events about
   * them (edits made outside the app, restores). An external event whose copy was pruned since is marked `kept: false`.
   */
  async objectHistory(objectId: string): Promise<HistoryEntry[]> {
    const { ctx } = this;
    const current = ctx.index.get(objectId);
    const events = ctx.index.all().filter(({ frontmatter }) => frontmatter.type === "audit-event" && frontmatter.object_id === objectId && historyActions.has(String(frontmatter.action)));
    const files = await ctx.objects.listVersions?.(objectId) ?? [];
    const kept = new Set(files.map((file) => file.relativePath));
    const eventEntries: HistoryEntry[] = events.map(({ frontmatter }) => {
      const metadata = (frontmatter.metadata ?? {}) as Record<string, unknown>;
      const versionPath = typeof metadata.version_path === "string" ? metadata.version_path : undefined;
      const external = frontmatter.actor_type === "external";
      return {
        kind: "event", id: frontmatter.id, action: String(frontmatter.action), at: String(frontmatter.occurred_at ?? frontmatter.updated_at),
        device: String(metadata.observed_by_device ?? frontmatter.updated_by_device), external,
        ...(versionPath ? { versionPath } : {}), kept: versionPath ? kept.has(versionPath) : false, current: false
      };
    });
    // An external edit becomes the new baseline, kept under the hash of the edited file (`current_hash`).
    const externalEdits = events.filter(({ frontmatter }) => frontmatter.actor_type === "external")
      .map(({ frontmatter }) => ({ at: String(frontmatter.occurred_at), metadata: (frontmatter.metadata ?? {}) as Record<string, unknown> }))
      .filter(({ metadata }) => typeof metadata.current_hash === "string");
    const versionEntries: HistoryEntry[] = [];
    for (const [position, file] of files.entries()) {
      const copy = await ctx.objects.read(file.relativePath).catch(() => undefined);
      if (!copy) continue;
      const edit = externalEdits.find(({ metadata }) => String(metadata.current_hash).startsWith(file.hashPrefix));
      versionEntries.push({
        kind: "version", id: file.relativePath, title: copy.frontmatter.title, revision: file.revision,
        at: edit?.at ?? String(copy.frontmatter.updated_at), device: String(edit?.metadata.observed_by_device ?? copy.frontmatter.updated_by_device),
        external: Boolean(edit), versionPath: file.relativePath, kept: true,
        current: position === 0 && Boolean(current) && current!.frontmatter.revision === file.revision && current!.contentHash.startsWith(file.hashPrefix)
      });
    }
    // Newest first by time; versions keep the store's order among themselves (revision, then most recently saved).
    return [...versionEntries, ...eventEntries].map((entry, order) => ({ entry, order, time: Date.parse(entry.at) || 0 }))
      .sort((a, b) => b.time - a.time || a.order - b.order).map(({ entry }) => entry);
  }

  /**
   * #92: what the History panel loads when it opens: the history, the object's hash now (sent back with a restore,
   * so a save made in between is not overwritten) and whether it is restricted (a restore keeps that).
   */
  async historyPanel(objectId: string): Promise<HistoryPanel> {
    const current = this.ctx.index.get(objectId);
    return { entries: await this.objectHistory(objectId), ...(current ? { contentHash: current.contentHash } : {}), restricted: isRestricted(current) };
  }

  /**
   * #85: puts back one of the object's kept copies through a guarded write, audited as `object.restored-from-version`.
   * #92: guarded by `expectedHash`, the hash the History panel was opened with, so a save made since (on any device)
   * is never overwritten: the restore is refused and the user reloads.
   */
  async restoreKeptVersion(objectId: string, versionPath: string, expectedHash: string, now = new Date()) {
    const folder = `.lifeos/versions/${objectId}/`;
    if (!versionPath.startsWith(folder) || !/^\d+--[0-9a-f]+\.md$/.test(versionPath.slice(folder.length))) throw new Error(`Not a kept version of ${objectId}: ${versionPath}`);
    const current = this.ctx.index.get(objectId);
    if (!current) throw new Error(`Object not found: ${objectId}`);
    if (current.contentHash !== expectedHash) throw new ObjectConflictError(restoreConflictMessage);
    return this.putBack(objectId, versionPath, current.relativePath, {}, now, expectedHash);
  }

  /** Writes the copy at `versionPath` over the object (or creates it at `fallbackPath` if deleted), then audits it. */
  private async putBack(id: string, versionPath: string, fallbackPath: string, metadata: Record<string, unknown>, now: Date, expectedHash?: string) {
    const { ctx } = this;
    const kept = await ctx.objects.readIfPresent(versionPath);
    if (!kept) throw new Error(versionPrunedMessage);
    const current = ctx.index.get(id);
    const timestamp = now.toISOString();
    const restored = await ctx.objects.write({
      relativePath: current?.relativePath ?? fallbackPath,
      ...(current ? { expectedHash: expectedHash ?? current.contentHash } : {}),
      frontmatter: { ...keepCurrentState(kept.frontmatter, current?.frontmatter), revision: (current?.frontmatter.revision ?? kept.frontmatter.revision) + 1, updated_at: timestamp, updated_by_device: ctx.deviceId },
      body: kept.body
    });
    await ctx.writeAudit("object.restored-from-version", id, timestamp, { ...metadata, version_path: versionPath });
    await ctx.rebuildIndex();
    return restored;
  }

  /** Stores `object` as the last-known version. Audit events are append-only and are not versioned. */
  private async persist(object: LifeOSObject) {
    if (object.frontmatter.type !== "audit-event") await this.ctx.objects.keepVersion?.(object);
  }
}

/** #85: one row of an object's history: a kept version copy, or an audit event about the object. */
export interface HistoryEntry {
  kind: "version" | "event";
  /** The version's path, or the audit event's ID. */
  id: string;
  /** ISO 8601 UTC: when the copy was saved (or the outside edit was seen), or when the event happened. */
  at: string;
  device: string;
  /** Made outside LifeOS (Obsidian, an agent, another app). */
  external: boolean;
  versionPath?: string;
  /** False when the copy was pruned (ADR 0012) and can no longer be restored. */
  kept: boolean;
  /** The version matches the file on disk now. */
  current: boolean;
  title?: string;
  revision?: number;
  action?: string;
}

/** #92: GET /api/v1/objects/:id/history. `contentHash` is absent when the object no longer exists. */
export interface HistoryPanel {
  entries: HistoryEntry[];
  contentHash?: string;
  restricted: boolean;
}

const historyActions = new Set(["object.changed-externally", "object.deleted-externally", "object.made-unreadable-externally", "object.restored-from-version"]);

/** #79: shown when an audit names a version copy that retention (ADR 0012) has since deleted. */
export const versionPrunedMessage = "This version is no longer kept (only the last 10 are)";

/** #92: shown when the object changed after its History panel was opened; nothing is restored. */
export const restoreConflictMessage = "This was changed since you opened its history, so nothing was restored. Reload to see the latest version, then try again.";

/**
 * #92: restoring content never changes the object's sensitivity (ADR 0010) or a person's review state: the current
 * values win over the kept copy's, and a field the current object does not have is dropped from the copy. With no
 * current object (the file was deleted), the copy is put back as kept.
 */
const preservedFields = ["sensitivity", "review_state"] as const;
function keepCurrentState(kept: LifeOSObject["frontmatter"], current: LifeOSObject["frontmatter"] | undefined) {
  if (!current) return kept;
  const result: Record<string, unknown> = { ...kept };
  for (const field of preservedFields) {
    if (current[field] === undefined) delete result[field];
    else result[field] = current[field];
  }
  return result as LifeOSObject["frontmatter"];
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
