import { envelopeWriteProblem, lifecycleWriteProblem, uuidV7, type LifeOSObject, type ObjectEnvelope, type Origin } from "@lifeos/domain";
import type { AiProvider, CalendarConnector, IndexStore, ObjectStore } from "./ports.js";

/** Body for a meeting note created without user text (legacy callers and crash recovery of old operations). */
export const DEFAULT_NOTE_BODY = "# Notes\n\n";
/** Every address of the user. All of them resolve to the single self person (PRD story 73). */
export const DEFAULT_SELF_EMAILS = ["rahul.dharod@eagleeye.com", "rahul.dharod@untienots.com", "baloo.rahul@gmail.com"];

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled";
}

/** Lowercase and strip accents so "reunion" finds "Réunion". */
export function foldForSearch(value: string) {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

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

export class AppContext {
  /** The object store with the application's write guards applied. Modules write only through this. */
  readonly objects: ObjectStore;
  /** U4: the last version of each object this app wrote or observed; the baseline for spotting external edits. */
  readonly known = new Map<string, LifeOSObject>();
  /** Per ID: writes in flight and a counter bumped at each write's start and end, so detection can skip IDs the app is writing. */
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
      write: async (input) => {
        const id = input.frontmatter.id;
        this.assertWritable(id);
        this.assertEnvelope(input.frontmatter);
        this.trackWrite(id, 1);
        try {
          const written = await store.write(input);
          this.known.set(id, written);
          return written;
        } finally { this.trackWrite(id, -1); }
      },
      keepVersion: store.keepVersion?.bind(store),
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

  async rebuildIndex() {
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
  async writeAudit(action: string, objectId: string, timestamp: string, metadata: Record<string, unknown>, actor: { type: "person" | "agent" | "system" | "external"; ref?: string } = { type: "person", ref: this.deviceId }) {
    const id = uuidV7();
    await this.objects.write({ relativePath: `audit/${markdownFileName(action, id, timestamp)}`, frontmatter: { ...this.envelope(id, "audit-event", action, timestamp), occurred_at: timestamp, actor_type: actor.type, ...(actor.ref ? { actor_ref: actor.ref } : {}), action, object_id: objectId, metadata }, body: `# ${action}\n` });
  }

  async ensureSelfPerson(timestamp: string) {
    const existing = this.index.all().find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true);
    if (existing) return existing;
    const id = uuidV7();
    const created = await this.objects.write({
      relativePath: `people/${markdownFileName("You", id, timestamp)}`,
      frontmatter: { ...this.envelope(id, "person", "You", timestamp), given_name: "You", is_self: true, identifiers: DEFAULT_SELF_EMAILS.map((value) => ({ kind: "email", value })) },
      body: "# You\n"
    });
    return created;
  }
}
