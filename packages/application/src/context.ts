import { envelopeWriteProblem, uuidV7, type LifeOSObject, type ObjectEnvelope, type Origin } from "@lifeos/domain";
import type { AiProvider, CalendarConnector, IndexStore, ObjectStore } from "./ports.js";

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
      write: (input) => {
        this.assertWritable(input.frontmatter.id);
        this.assertEnvelope(input.frontmatter);
        return store.write(input);
      },
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

  /** #30: origin never changes, sensitivity is known, and new or changed Areas use the agreed vocabulary. */
  assertEnvelope(frontmatter: ObjectEnvelope) {
    const problem = envelopeWriteProblem(frontmatter, this.index.get(frontmatter.id)?.frontmatter);
    if (problem) throw new Error(problem);
  }

  async rebuildIndex() {
    const scan = this.objects.scan ? await this.objects.scan() : { objects: await this.objects.list(), diagnostics: [] };
    const objects = scan.objects;
    this.index.rebuild(objects, scan.diagnostics);
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

  async writeAudit(action: string, objectId: string, timestamp: string, metadata: Record<string, unknown>) {
    const id = uuidV7();
    await this.objects.write({ relativePath: `audit/${markdownFileName(action, id, timestamp)}`, frontmatter: { ...this.envelope(id, "audit-event", action, timestamp), occurred_at: timestamp, actor_type: "person", actor_ref: this.deviceId, action, object_id: objectId, metadata }, body: `# ${action}\n` });
  }

  async ensureSelfPerson(timestamp: string) {
    const existing = this.index.all().find((object) => object.frontmatter.type === "person" && object.frontmatter.is_self === true);
    if (existing) return existing;
    const id = uuidV7();
    const created = await this.objects.write({
      relativePath: `people/${markdownFileName("You", id, timestamp)}`,
      frontmatter: { ...this.envelope(id, "person", "You", timestamp), given_name: "You", is_self: true },
      body: "# You\n"
    });
    return created;
  }
}
