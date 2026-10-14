import { envelopeWriteProblem, lifecycleWriteProblem, uuidV7, type LifeOSObject, type ObjectEnvelope, type Origin } from "@lifeos/domain";
import type { AiProvider, CalendarConnector, IndexStore, ObjectStore } from "./ports.js";
import { OneAtATime, sameValue } from "./support.js";

/** Body for a meeting note created without user text (legacy callers and crash recovery of old operations). */
export const DEFAULT_NOTE_BODY = "# Notes\n\n";

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled";
}

export { foldForSearch } from "@lifeos/shared";

function timestampPrefix(timestamp: string, timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}-${part("hour")}${part("minute")}`;
}

export function markdownFileName(title: string, id: string, timestamp: string, timeZone = "UTC") {
  return `${timestampPrefix(timestamp, timeZone)}-${slugify(title)}--${id}.md`;
}

/**
 * What every feature module shares: the adapters, plus the helpers for building envelopes,
 * guarded writes, audit events and lookups. Keep cross-cutting write rules here, not in modules.
 */
/** Same name as the object store's conflict error, which the server maps to HTTP 409 (the application cannot import adapters). */
export class ObjectConflictError extends Error { override name = "ObjectConflictError"; }

export interface RebuildResult { objectCount: number; diagnostics: string[] }
/** Who an audit event is by. */
export type AuditActor = { type: "person" | "agent" | "system" | "external"; ref?: string };

export class AppContext {
  /** The object store with the application's write guards applied. Modules write only through this. */
  readonly objects: ObjectStore;
  /**
   * U4: the last version of each object this app wrote or observed; the baseline for spotting external edits.
   * In memory only: #69 checks it against the versions store (which survives restarts) the first time each object is seen.
   */
  readonly known = new Map<string, LifeOSObject>();
  /** Per ID: writes in flight and a counter bumped at each write's start and end, so detection can skip IDs the app is writing. */
  /**
   * #95 (ADR 0013): adoption batches and backups run one at a time in this one queue, so a backup never snapshots
   * an adoption half done (an object filed while its draft is still in `_inbox/drafts/` would duplicate on restore).
   */
  private readonly snapshotQueue = new OneAtATime();
  runExclusive<T>(work: () => Promise<T>): Promise<T> { return this.snapshotQueue.run("adoption-and-backups", work); }
  private readonly inFlight = new Map<string, number>();
  private readonly writeTicks = new Map<string, number>();

  constructor(
    store: ObjectStore,
    readonly index: IndexStore,
    readonly calendar: CalendarConnector | undefined,
    readonly ai: AiProvider | undefined,
    readonly deviceId: string
  ) {
    this.objects = {
      list: () => store.list(),
      scan: store.scan?.bind(store),
      read: (relativePath) => store.read(relativePath),
      readIfPresent: (relativePath) => store.readIfPresent(relativePath),
      write: async (input) => {
        const id = input.frontmatter.id;
        this.assertWritable(id);
        if (!input.expectedHash) {
          const replayed = await this.replayedCreate(input.relativePath, id, store);
          if (replayed) return replayed;
          this.assertNewId(id);
        }
        this.assertEnvelope(input.frontmatter);
        this.trackWrite(id, 1);
        try {
          const written = await store.write(input);
          this.known.set(id, written);
          return written;
        } finally { this.trackWrite(id, -1); }
      },
      // PB-030: a removal counts as an app write, so external-edit detection never reports it as deleted outside the app.
      remove: store.remove ? async (relativePath, expectedHash) => {
        const id = this.index.all().find((object) => object.relativePath === relativePath)?.frontmatter.id;
        if (id) { this.assertWritable(id); this.trackWrite(id, 1); }
        try {
          await store.remove!(relativePath, expectedHash);
          if (id) this.known.delete(id);
        } finally { if (id) this.trackWrite(id, -1); }
      } : undefined,
      removeVersions: store.removeVersions?.bind(store),
      keepVersion: store.keepVersion?.bind(store),
      latestVersion: store.latestVersion?.bind(store),
      latestVersionInfo: store.latestVersionInfo?.bind(store),
      versionAt: store.versionAt?.bind(store),
      listVersions: store.listVersions?.bind(store),
      prepareOperation: store.prepareOperation?.bind(store),
      completeOperation: store.completeOperation?.bind(store),
      incompleteOperations: store.incompleteOperations?.bind(store)
    };
  }

  /** U3: an ID claimed by several files cannot be written until the user resolves the duplicate. */
  assertWritable(id: string) {
    const paths = this.index.duplicatePaths?.(id);
    if (paths) throw new ObjectConflictError(`Duplicate object ID ${id} in ${paths.join(" and ")}; remove or re-ID one copy, then try again`);
  }

  /** #58: a create (no expected hash) must use an ID nothing in the index has, whatever its path. */
  assertNewId(id: string) {
    const existing = this.index.get(id);
    if (existing) throw new ObjectConflictError(`Duplicate object ID ${id}: already used by ${existing.relativePath}; nothing was written`);
  }

  /** Which IDs a crash replay may find already written by its own interrupted first attempt (see `replaying`). */
  private readonly replayScopes = new Set<(id: string) => boolean>();

  /**
   * Runs `work` as the replay of an interrupted operation whose creates use deterministic IDs: `ids` lists them,
   * or (#59) tells whether an ID is one of them. A create of one of these IDs at the path where it already exists
   * returns the file the first attempt wrote (writes are atomic, so it is complete) instead of being refused as a
   * duplicate. Nothing is ever rewritten.
   */
  async replaying<T>(ids: Iterable<string> | ((id: string) => boolean), work: () => Promise<T>): Promise<T> {
    const listed = typeof ids === "function" ? undefined : new Set(ids);
    const scope = typeof ids === "function" ? ids : (id: string) => listed!.has(id);
    this.replayScopes.add(scope);
    try { return await work(); }
    finally { this.replayScopes.delete(scope); }
  }

  private async replayedCreate(relativePath: string, id: string, store: ObjectStore) {
    if (![...this.replayScopes].some((scope) => scope(id))) return undefined;
    const existing = await store.read(relativePath).catch(() => undefined);
    if (existing?.frontmatter.id !== id) return undefined;
    this.known.set(id, existing);
    return existing;
  }

  private trackWrite(id: string, delta: 1 | -1) {
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + delta);
    this.writeTicks.set(id, (this.writeTicks.get(id) ?? 0) + 1);
  }

  /** Snapshot of app write activity; `busySince(snapshot)` names IDs written in flight at, or since, the snapshot. */
  writeActivity() {
    return { inFlight: new Set([...this.inFlight].filter(([, count]) => count > 0).map(([id]) => id)), ticks: new Map(this.writeTicks) };
  }

  busySince(snapshot: ReturnType<AppContext["writeActivity"]>, id: string) {
    return snapshot.inFlight.has(id) || (this.writeTicks.get(id) ?? 0) !== (snapshot.ticks.get(id) ?? 0);
  }

  /** #30: origin never changes, sensitivity is known, and new or changed Areas use the agreed vocabulary. #41: lifecycle moves are legal. */
  assertEnvelope(frontmatter: ObjectEnvelope) {
    const previous = this.index.get(frontmatter.id)?.frontmatter;
    const problem = envelopeWriteProblem(frontmatter, previous) ?? lifecycleWriteProblem(frontmatter, previous);
    if (problem) throw new Error(problem);
  }

  /** Called after every index rebuild; the Agent Index (#43) schedules its debounced regeneration here. */
  onRebuild?: () => void;

  private rebuildRunning?: Promise<RebuildResult>;
  private rebuildQueued?: Promise<RebuildResult>;

  /**
   * #55: scans run one at a time, so an older, slower scan can never swap in a stale index after a newer one.
   * A call made while a scan runs may have written after that scan read the disk, so it waits for one more
   * scan; every call made meanwhile shares that follow-up scan. Each caller's result therefore comes from a
   * scan that started after the call.
   */
  rebuildIndex(): Promise<RebuildResult> {
    if (!this.rebuildRunning) return this.startRebuild();
    return this.rebuildQueued ??= this.rebuildRunning.catch(() => undefined).then(() => {
      this.rebuildQueued = undefined;
      return this.startRebuild();
    });
  }

  private startRebuild() {
    const run = this.scanIntoIndex().finally(() => { if (this.rebuildRunning === run) this.rebuildRunning = undefined; });
    this.rebuildRunning = run;
    return run;
  }

  private async scanIntoIndex() {
    const scan = this.objects.scan ? await this.objects.scan() : { objects: await this.objects.list(), diagnostics: [] };
    const objects = scan.objects;
    this.index.rebuild(objects, scan.diagnostics);
    // A rescan does not move the baseline of an object already known: only external-change detection does.
    for (const object of this.index.all()) if (!this.known.has(object.frontmatter.id)) this.known.set(object.frontmatter.id, object);
    this.onRebuild?.();
    return { objectCount: objects.length, diagnostics: this.index.diagnostics() };
  }

  envelope(id: string, type: ObjectEnvelope["type"], title: string, timestamp: string, origin: Origin = "app"): ObjectEnvelope {
    return { id, type, schema_version: 1, revision: 1, title, created_at: timestamp, updated_at: timestamp, updated_by_device: this.deviceId, origin };
  }

  /** Saves a new revision of an existing object: merges `changes`, bumps the revision and stamps the device. */
  update(current: LifeOSObject, changes: Record<string, unknown>, options: { expectedHash: string | undefined; now: string; body?: string }) {
    return this.objects.write({
      relativePath: current.relativePath,
      expectedHash: options.expectedHash,
      frontmatter: { ...current.frontmatter, ...changes, revision: current.frontmatter.revision + 1, updated_at: options.now, updated_by_device: this.deviceId },
      body: options.body ?? current.body
    });
  }

  required(id: string, type?: ObjectEnvelope["type"]) {
    const object = this.index.get(id);
    if (!object || (type && object.frontmatter.type !== type)) throw new Error(`Object not found: ${id}`);
    return object;
  }

  /** `actor` defaults to the person on this device; external edits have no known actor, so no `actor_ref`. */
  async writeAudit(action: string, objectId: string, timestamp: string, metadata: Record<string, unknown>, actor: AuditActor = { type: "person", ref: this.deviceId }) {
    const id = uuidV7();
    await this.objects.write({ relativePath: `audit/${markdownFileName(action, id, timestamp)}`, frontmatter: { ...this.envelope(id, "audit-event", action, timestamp), occurred_at: timestamp, actor_type: actor.type, ...(actor.ref ? { actor_ref: actor.ref } : {}), action, object_id: objectId, metadata }, body: `# ${action}\n` });
  }

  /**
   * Audit events with one of `actions` whose metadata equals `match` on every key it gives (`sameValue`), optionally
   * only those about `objectId`. Reads the index, so it sees what the last rebuild saw.
   */
  findAudits(actions: string | readonly string[], match: Record<string, unknown> = {}, objectId?: string) {
    const wanted = typeof actions === "string" ? [actions] : actions;
    return this.index.all().filter((object) => {
      if (object.frontmatter.type !== "audit-event" || !wanted.includes(String(object.frontmatter.action))) return false;
      if (objectId !== undefined && object.frontmatter.object_id !== objectId) return false;
      const metadata = (object.frontmatter.metadata ?? {}) as Record<string, unknown>;
      return Object.entries(match).every(([key, value]) => sameValue(metadata[key], value));
    });
  }

  /**
   * ADR 0013: the one audit-once helper. Writes the audit unless one with the same action and object already exists
   * whose metadata equals this one on every `matchOn` key (none: any such audit counts). A replay after a crash finds
   * the audit its first attempt wrote (the index is rebuilt before replays) and writes nothing.
   */
  async writeAuditOnce<M extends Record<string, unknown>>(action: string, objectId: string, timestamp: string, metadata: M, options: { matchOn: ReadonlyArray<keyof M & string>; actor?: AuditActor }) {
    const match = Object.fromEntries(options.matchOn.map((key) => [key, metadata[key]]));
    if (!this.findAudits(action, match, objectId).length) await this.writeAudit(action, objectId, timestamp, metadata, options.actor);
  }

  /** The self person being created, shared until the index holds it, so concurrent callers do not each create one (#55). */
  private selfCreation?: Promise<LifeOSObject>;

  ensureSelfPerson(timestamp: string): Promise<LifeOSObject> {
    const existing = this.index.all().find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true);
    if (existing) { this.selfCreation = undefined; return Promise.resolve(existing); }
    return this.selfCreation ??= this.createSelfPerson(timestamp).catch((error: unknown) => { this.selfCreation = undefined; throw error; });
  }

  private async createSelfPerson(timestamp: string) {
    const id = uuidV7();
    const created = await this.objects.write({
      relativePath: `people/${markdownFileName("You", id, timestamp)}`,
      frontmatter: { ...this.envelope(id, "person", "You", timestamp), given_name: "You", is_self: true },
      body: "# You\n"
    });
    return created;
  }
}
