import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { inboxFolders, type AgentIndexFile, type Operation, type AgentIndexWriter, type InboxDocument, type InboxFile, type InboxFolder, type InboxStore, type ObjectStore } from "@lifeos/application";
import { areaProblem, isArea, isUuidV7, validateFrontmatter, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { parse, stringify } from "yaml";

export { dataRootMarker, dataRootProblem, exitUnlessDataRoot, resolveBackupRoot, resolveDataRoot } from "./data-root.js";

/** Codes of file systems (some synced or network ones) that refuse hard links. */
const hardLinkRefused = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV", "EOPNOTSUPP"]);

/**
 * ADR 0013: publishes the finished file `temporary` as `target` only if nothing is there yet; false when something is.
 * A hard link does this atomically and, unlike rename, never replaces a file. Where hard links are refused it checks,
 * then renames: not atomic, but only this app creates these paths. On true the temporary file is gone; on false it stays.
 */
export async function createExclusive(temporary: string, target: string): Promise<boolean> {
  try {
    await link(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return false;
    if (!hardLinkRefused.has(code)) throw error;
    if (await access(target).then(() => true, () => false)) return false;
    await rename(temporary, target);
    return true;
  }
  await rm(temporary, { force: true });
  return true;
}

export class ObjectConflictError extends Error {
  override name = "ObjectConflictError";
}

export interface SessionRecord {
  device_id: string;
  started_at: string;
  last_activity_at: string;
  lease_expires_at: string;
}

export interface SessionStatus {
  currentDeviceId: string;
  activeDeviceId: string;
  startedAt: string;
  lastActivityAt: string;
  leaseExpiresAt: string;
  writeAllowed: boolean;
  warning?: string;
}

function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/** A file in the data root that is not a valid object. The message is the System Health diagnostic (U2). */
export class InvalidObjectFileError extends Error {
  override name = "InvalidObjectFileError";
}

/** "field: reason" for each schema issue, so the user can see what to fix. */
function schemaReasons(error: unknown) {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  if (!Array.isArray(issues)) return error instanceof Error ? error.message : "invalid front matter";
  return issues.map((issue) => `${issue.path.map(String).join(".") || "front matter"}: ${issue.message}`).join("; ");
}

function decode(content: string, relativePath: string): LifeOSObject {
  if (!content.trim()) throw new InvalidObjectFileError(`${relativePath}: empty file`);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new InvalidObjectFileError(`${relativePath}: missing YAML front matter`);
  let raw: unknown;
  try { raw = parse(match[1] ?? ""); }
  catch (error) { throw new InvalidObjectFileError(`${relativePath}: invalid YAML front matter (${(error instanceof Error ? error.message : String(error)).split("\n")[0]})`); }
  const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? ` (id ${(raw as { id: string }).id})` : "";
  let frontmatter: ObjectEnvelope;
  try { frontmatter = validateFrontmatter(raw); }
  catch (error) { throw new InvalidObjectFileError(`${relativePath}${id}: invalid front matter (${schemaReasons(error)})`); }
  return { frontmatter, body: match[2] ?? "", relativePath, contentHash: hash(content) };
}

function serialize(frontmatter: ObjectEnvelope, body: string) {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

function unreadableReason(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" ? "permission denied" : error instanceof Error ? error.message : String(error);
}

const nonObjectFolders = new Set(["_inbox", "_agent"]);

async function markdownFiles(root: string, diagnostics: string[], current = root): Promise<string[]> {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); }
  catch (error) {
    if (current === root) throw error;
    diagnostics.push(`${path.relative(root, current)}/: unreadable folder (${unreadableReason(error)})`);
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".lifeos") continue;
    // Agent drafts and the derived Agent Index are not objects (ADR 0007).
    if (current === root && nonObjectFolders.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(root, diagnostics, full));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path.relative(root, full));
  }
  return found;
}

export interface MarkdownObjectStoreOptions {
  /** ADR 0012: version copies kept per object in `.lifeos/versions/` (default 10, at least 2). */
  versionsToKeep?: number;
}

interface VersionFile { relativePath: string; revision: number; hashPrefix: string; savedAt: number }

export class MarkdownObjectStore implements ObjectStore {
  private readonly root: string;
  private readonly operations: FilesystemOperationStore;
  private readonly versionsToKeep: number;

  constructor(root: string, options: MarkdownObjectStoreOptions = {}) {
    this.root = path.resolve(root);
    this.operations = new FilesystemOperationStore(this.root);
    // Two at least: an external edit keeps the prior copy (named in its audit event) and the edited one (the new baseline).
    this.versionsToKeep = Math.max(2, Math.floor(options.versionsToKeep ?? 10));
  }

  prepareOperation(kind: string, payload: Record<string, unknown>, operationId: string) { return this.operations.prepare(kind, payload, operationId); }
  async completeOperation(operationId: string) {
    const record = (await this.operations.incomplete()).find((candidate) => candidate.id === operationId);
    if (record) await this.operations.complete(record);
  }
  incompleteOperations() { return this.operations.incomplete(); }

  async list() {
    return (await this.scan()).objects;
  }

  async scan() {
    const diagnostics: string[] = [];
    const files = await markdownFiles(this.root, diagnostics).catch((error: Error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const result: LifeOSObject[] = [];
    for (const relativePath of files) {
      let content: string;
      try { content = await readFile(this.safePath(relativePath), "utf8"); }
      catch (error) { diagnostics.push(`${relativePath}: unreadable (${unreadableReason(error)})`); continue; }
      try {
        const object = decode(content, relativePath);
        result.push(object);
        if (!isUuidV7(object.frontmatter.id)) diagnostics.push(`${relativePath} (id ${object.frontmatter.id}): ID is not a UUIDv7; new objects must use UUIDv7`);
        // #30: a legacy Area still loads; it is only flagged so the user can pick an agreed one.
        if (object.frontmatter.area !== undefined && !isArea(object.frontmatter.area)) diagnostics.push(`${relativePath} (id ${object.frontmatter.id}): legacy ${areaProblem(object.frontmatter.area)}; choose one when you next edit it`);
        diagnostics.push(...await this.imageDiagnostics(object));
      }
      catch (error) { diagnostics.push(error instanceof Error ? error.message : `${relativePath}: unreadable object`); }
    }
    return { objects: result, diagnostics };
  }

  private async imageDiagnostics(object: LifeOSObject) {
    const diagnostics: string[] = [];
    const matches = object.body.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g);
    for (const match of matches) {
      const source = (match[1] ?? match[2] ?? "").split("#")[0]!;
      if (!source || /^(?:https?:|data:|\/)/i.test(source)) continue;
      let decoded = source;
      try { decoded = decodeURIComponent(source); } catch { /* unresolved paths are reported below */ }
      const target = path.resolve(path.dirname(this.safePath(object.relativePath)), decoded);
      const managedAssets = path.join(this.root, "assets");
      if (!target.startsWith(`${managedAssets}${path.sep}`)) continue;
      const exists = await access(target).then(() => true).catch(() => false);
      if (!exists) diagnostics.push(`${object.relativePath}: missing managed image ${source}`);
    }
    return diagnostics;
  }

  async read(relativePath: string) {
    const content = await readFile(this.safePath(relativePath), "utf8");
    return decode(content, relativePath);
  }

  async write(input: { relativePath: string; frontmatter: ObjectEnvelope; body: string; expectedHash?: string }) {
    validateFrontmatter(input.frontmatter);
    const target = this.safePath(input.relativePath);
    const current = await readFile(target, "utf8").catch(() => undefined);
    if (current === undefined && !isUuidV7(input.frontmatter.id)) throw new Error(`${input.relativePath}: object ID ${input.frontmatter.id} is not a UUIDv7; new objects must use UUIDv7 IDs`);
    if (input.expectedHash) {
      if (!current || hash(current) !== input.expectedHash) throw new ObjectConflictError(`Object changed since it was opened: ${input.relativePath}`);
      // A guarded save must also follow the revision on disk, as the design requires (hash and revision).
      const onDisk = decode(current, input.relativePath).frontmatter.revision;
      if (onDisk !== input.frontmatter.revision - 1) throw new ObjectConflictError(`Object changed since it was opened: ${input.relativePath} (revision ${onDisk} on disk, expected ${input.frontmatter.revision - 1})`);
      await this.saveVersion(input.frontmatter.id, input.frontmatter.revision - 1, current);
    } else {
      // #58: a create (no expected hash) never overwrites a file, nor reuses an ID a sibling file name already carries.
      if (current !== undefined) throw new ObjectConflictError(`Cannot create ${input.relativePath}: a file already exists there`);
      // #73: audit events skip the scan. Their flat folder grows forever, their IDs are fresh UUIDv7s, and the
      // index check plus the no-overwrite publish still apply.
      const claimed = input.frontmatter.type === "audit-event" ? undefined : await this.siblingWithId(target, input.frontmatter.id);
      if (claimed) throw new ObjectConflictError(`Duplicate object ID ${input.frontmatter.id}: already used by ${claimed}; nothing was written`);
    }
    const next = serialize(input.frontmatter, input.body);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(next, "utf8");
      await handle.sync();
      await handle.close();
      if (input.expectedHash) await rename(temporary, target);
      else await this.publishNew(temporary, target, input.relativePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    // #69: keep what was written as the last-known version, so edits made while the app is closed are caught at the next start.
    // It is the same file the next guarded write would save as its prior version. Audit events are append-only and skipped.
    if (input.frontmatter.type !== "audit-event") await this.saveVersion(input.frontmatter.id, input.frontmatter.revision, next);
    return decode(next, input.relativePath);
  }

  /** Another file in the target's folder named for `id` (ADR 0002: `…--<id>.md`), as a data-root relative path. */
  private async siblingWithId(target: string, id: string) {
    const names = await readdir(path.dirname(target)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const name = names.find((candidate) => candidate.endsWith(`--${id}.md`) && candidate !== path.basename(target));
    return name ? path.relative(this.root, path.join(path.dirname(target), name)).split(path.sep).join("/") : undefined;
  }

  /** Moves a finished temporary file to a path that must not exist yet (ADR 0013: `createExclusive`). */
  private async publishNew(temporary: string, target: string, relativePath: string) {
    if (!await createExclusive(temporary, target)) throw new ObjectConflictError(`Cannot create ${relativePath}: a file already exists there`);
  }

  /**
   * U4: keeps a last-known copy that is no longer on disk (changed or deleted outside the app).
   * The copy is re-serialised from the parsed object, in the app's own write format, but named for the hash of the
   * file it came from, so a later start can tell "unchanged" from the name alone (ADR 0012). A copy that is already
   * a stored version keeps its name and is only marked as the most recently saved.
   */
  keepVersion(object: LifeOSObject) {
    const stored = this.versionFolder(object.frontmatter.id);
    const name = object.relativePath.startsWith(`${stored}/`) ? path.posix.basename(object.relativePath) : undefined;
    const nameHash = name && /^\d+--[0-9a-f]+\.md$/.test(name) ? name.slice(name.indexOf("--") + 2, -3) : object.contentHash;
    return this.saveVersion(object.frontmatter.id, object.frontmatter.revision, serialize(object.frontmatter, object.body), nameHash);
  }

  /**
   * #72: the newest stored version of `id` (highest revision, then most recently saved) from file names alone: its
   * revision and the first 12 hex digits of the hash of the file it copies. Files are only stat'd to break a tie.
   */
  async latestVersionInfo(id: string) {
    const newest = (await this.versionFiles(id)).at(0);
    return newest ? { relativePath: newest.relativePath, revision: newest.revision, hashPrefix: newest.hashPrefix } : undefined;
  }

  async latestVersion(id: string) {
    const newest = await this.latestVersionInfo(id);
    return newest ? this.read(newest.relativePath) : undefined;
  }

  /** #85: the kept copies of `id`, newest first (highest revision, then most recently saved), without reading them. */
  async listVersions(id: string) {
    return (await this.versionFiles(id, true)).map(({ relativePath, revision, hashPrefix }) => ({ relativePath, revision, hashPrefix }));
  }

  async versionAt(id: string, instant: string) {
    const wanted = Date.parse(instant);
    // Oldest saved first within a revision, so the first copy found for the highest revision is the app's own save.
    const files = (await this.versionFiles(id, true)).sort((a, b) => b.revision - a.revision || a.savedAt - b.savedAt);
    for (const file of files) {
      const copy = await this.read(file.relativePath).catch(() => undefined);
      if (copy && Date.parse(String(copy.frontmatter.updated_at)) <= wanted) return copy;
    }
    return undefined;
  }

  private versionFolder(id: string) { return path.posix.join(".lifeos", "versions", id); }

  /** The versions of `id`, newest first. Modification times are read only for revisions with more than one copy. */
  private async versionFiles(id: string, timed = false): Promise<VersionFile[]> {
    const folder = this.versionFolder(id);
    const names = await readdir(this.safePath(folder)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const files = names.filter((name) => /^\d+--[0-9a-f]+\.md$/.test(name)).map((name) => ({
      relativePath: path.posix.join(folder, name),
      revision: Number(name.split("--")[0]),
      hashPrefix: name.slice(name.indexOf("--") + 2, -3)
    }));
    const copies = new Map<number, number>();
    for (const file of files) copies.set(file.revision, (copies.get(file.revision) ?? 0) + 1);
    const withTimes = await Promise.all(files.map(async (file) => ({
      ...file,
      savedAt: timed || copies.get(file.revision)! > 1 ? await stat(this.safePath(file.relativePath)).then((info) => info.mtimeMs, () => 0) : 0
    })));
    return withTimes.sort((a, b) => b.revision - a.revision || b.savedAt - a.savedAt);
  }

  /**
   * Saves `content` as `.lifeos/versions/<id>/<revision>--<hash>.md` (idempotent) and returns that relative path.
   * #72: the copy is marked as saved strictly after every other copy (so "most recently saved" is reliable within
   * one clock tick), then the folder is pruned to the last `versionsToKeep` copies. The newest copy (the external-edit
   * baseline) and the copy just saved are never pruned.
   */
  private async saveVersion(id: string, revision: number, content: string, nameHash = hash(content)) {
    const relativePath = path.posix.join(this.versionFolder(id), `${String(revision).padStart(6, "0")}--${nameHash.slice(0, 12)}.md`);
    const versionPath = this.safePath(relativePath);
    await mkdir(path.dirname(versionPath), { recursive: true });
    await this.publishVersion(versionPath, content);
    const others = (await this.versionFiles(id, true)).filter((file) => file.relativePath !== relativePath);
    const savedAt = Math.max(Date.now(), ...others.map((file) => file.savedAt + 1));
    await utimes(versionPath, savedAt / 1000, savedAt / 1000);
    const ordered = [...others, { relativePath, revision, hashPrefix: "", savedAt }].sort((a, b) => b.revision - a.revision || b.savedAt - a.savedAt);
    const keep = new Set([ordered[0]!.relativePath, relativePath]);
    for (const file of ordered) {
      if (keep.size >= this.versionsToKeep) break;
      keep.add(file.relativePath);
    }
    await Promise.all(ordered.filter((file) => !keep.has(file.relativePath)).map((file) => rm(this.safePath(file.relativePath), { force: true })));
    return relativePath;
  }

  /**
   * #79: writes the copy to a temporary file, syncs it, then publishes it with `createExclusive`, so a crash never
   * leaves a partial copy under a version name (temporary names are never listed as versions). A copy already there
   * with other content (a partial one left by a non-atomic write before #79) is replaced in one rename.
   */
  private async publishVersion(versionPath: string, content: string) {
    const temporary = `${versionPath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      if (await createExclusive(temporary, versionPath)) return;
      if (await readFile(versionPath, "utf8").catch(() => undefined) !== content) await rename(temporary, versionPath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private safePath(relativePath: string) {
    const target = path.resolve(this.root, relativePath);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new Error("Path escapes the LifeOS data root");
    return target;
  }
}

/** Filesystem access to `_inbox/` (drafts, outcomes and sidecars) and `_agent/`. Splits front matter but never validates it. */
export class FilesystemInboxStore implements InboxStore {
  private readonly root: string;

  constructor(root: string) { this.root = path.resolve(root); }

  async ensureFolders() {
    await Promise.all([...inboxFolders.map((folder) => mkdir(path.join(this.root, "_inbox", folder), { recursive: true })), mkdir(path.join(this.root, "_agent"), { recursive: true })]);
  }

  async list(folder: InboxFolder) {
    const entries = await readdir(this.folder(folder), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
    return Promise.all(names.map((name) => this.file(folder, name)));
  }

  async read(folder: InboxFolder, name: string): Promise<InboxDocument> {
    const file = await this.file(folder, name);
    const content = await readFile(this.target(folder, name), "utf8");
    const base = { ...file, content, contentHash: hash(content) };
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { ...base, body: content, error: content.trim() ? "missing YAML front matter" : "empty file" };
    let raw: unknown;
    try { raw = parse(match[1] ?? ""); }
    catch (error) { return { ...base, body: match[2] ?? "", error: `unreadable YAML front matter (${(error instanceof Error ? error.message : String(error)).split("\n")[0]})` }; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...base, body: match[2] ?? "", error: "front matter is not a set of fields" };
    return { ...base, frontmatter: raw as Record<string, unknown>, body: match[2] ?? "" };
  }

  async move(from: InboxFolder, name: string, to: InboxFolder) {
    await mkdir(this.folder(to), { recursive: true });
    const extension = path.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let candidate = name;
    // Adoption runs one batch at a time, so check-then-rename cannot race with another LifeOS writer.
    for (let suffix = 2; await access(this.target(to, candidate)).then(() => true, () => false); suffix += 1) candidate = `${stem}-${suffix}${extension}`;
    await rename(this.target(from, name), this.target(to, candidate));
    return this.file(to, candidate);
  }

  async writeDocument(folder: InboxFolder, name: string, frontmatter: Record<string, unknown>, body: string) {
    const target = this.target(folder, name);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    return this.file(folder, name);
  }

  private async file(folder: InboxFolder, name: string): Promise<InboxFile> {
    const info = await stat(this.target(folder, name));
    return { name, relativePath: `_inbox/${folder}/${name}`, modifiedAt: info.mtimeMs };
  }

  private folder(folder: InboxFolder) {
    if (!inboxFolders.includes(folder)) throw new Error(`Unknown inbox folder: ${folder}`);
    return path.join(this.root, "_inbox", folder);
  }

  private target(folder: InboxFolder, name: string) {
    if (!name || name !== path.basename(name) || name.startsWith(".")) throw new Error(`Invalid inbox file name: ${name}`);
    return path.join(this.folder(folder), name);
  }
}

/**
 * Writes the derived Agent Index into `_agent/` (ADR 0009). Each file is written atomically (temp file,
 * then rename) so an Agent never reads half a file. Recreates `_agent/` if it was deleted, but never the
 * data root itself: a missing root means the vault moved, and writing there would be wrong.
 */
export class FilesystemAgentIndexWriter implements AgentIndexWriter {
  private readonly folder: string;

  constructor(root: string) { this.folder = path.join(path.resolve(root), "_agent"); }

  async write(files: AgentIndexFile[]) {
    await mkdir(this.folder).catch((error: NodeJS.ErrnoException) => error.code === "EEXIST" ? undefined : Promise.reject(error));
    for (const file of files) {
      if (!file.name || file.name !== path.basename(file.name) || file.name.startsWith(".") || !file.name.endsWith(".md")) throw new Error(`Invalid Agent Index file name: ${file.name}`);
      const target = path.join(this.folder, file.name);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, file.content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target).catch(async (error) => { await rm(temporary, { force: true }); throw error; });
    }
  }
}

/** An operations-journal file (ADR 0013): the application's `Operation` plus its status and times. */
export interface OperationRecord extends Operation {
  status: "prepared" | "completed";
  created_at: string;
  completed_at?: string;
}

export class FilesystemOperationStore {
  private readonly directory: string;
  constructor(root: string) { this.directory = path.join(path.resolve(root), ".lifeos", "operations"); }

  /**
   * #62: creates the operation file exclusively (fails if it exists), so of two concurrent prepares of one
   * operation exactly one payload wins and the other caller gets the winner's record back.
   */
  async prepare(kind: string, payload: Record<string, unknown>, operationId: string = randomUUID()): Promise<OperationRecord> {
    const existing = await this.read(operationId);
    if (existing) return existing;
    const record: OperationRecord = { id: operationId, kind, status: "prepared", created_at: new Date().toISOString(), payload };
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${operationId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    let created: boolean;
    try { created = await createExclusive(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    return created ? record : await this.read(operationId) ?? record;
  }

  async complete(record: OperationRecord) {
    const completed = { ...record, status: "completed" as const, completed_at: new Date().toISOString() };
    await this.save(completed);
    return completed;
  }

  async incomplete() {
    const entries = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const records = await Promise.all(entries.filter((name) => name.endsWith(".json")).map((name) => this.read(name.slice(0, -5))));
    return records.filter((record): record is OperationRecord => Boolean(record && record.status === "prepared"));
  }

  private async read(id: string): Promise<OperationRecord | undefined> {
    const content = await readFile(path.join(this.directory, `${id}.json`), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    return content ? JSON.parse(content) as OperationRecord : undefined;
  }

  private async save(record: OperationRecord) {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${record.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  }
}

export class FilesystemSessionStore {
  private readonly sessionPath: string;
  private record?: SessionRecord;
  private writeAllowed = true;
  private warning?: string;

  constructor(root: string, private readonly deviceId: string, private readonly leaseDurationMs = 5 * 60_000) {
    this.sessionPath = path.join(path.resolve(root), ".lifeos", "session.md");
  }

  async start() {
    await this.cleanupTemporaryFiles();
    const existing = await this.readRecord();
    const now = Date.now();
    if (existing && existing.device_id !== this.deviceId && Date.parse(existing.lease_expires_at) > now) {
      this.record = existing;
      this.writeAllowed = false;
      this.warning = `Device ${existing.device_id} has an active lease until ${existing.lease_expires_at}`;
      return this.status();
    }
    await this.claim();
    return this.status();
  }

  async takeOver() {
    await this.claim();
    return this.status();
  }

  async refresh() {
    const existing = await this.readRecord();
    if (existing && existing.device_id !== this.deviceId && Date.parse(existing.lease_expires_at) > Date.now()) {
      this.record = existing;
      this.writeAllowed = false;
      this.warning = `Device ${existing.device_id} has an active lease until ${existing.lease_expires_at}`;
    } else if (!existing || existing.device_id === this.deviceId || Date.parse(existing.lease_expires_at) <= Date.now()) {
      this.writeAllowed = true;
      this.warning = undefined;
      if (existing) this.record = existing;
    }
    return this.status();
  }

  async touch() {
    await this.refresh();
    if (!this.writeAllowed) return this.status();
    const now = new Date();
    const startedAt = this.record?.device_id === this.deviceId ? this.record.started_at : now.toISOString();
    this.record = {
      device_id: this.deviceId,
      started_at: startedAt,
      last_activity_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + this.leaseDurationMs).toISOString()
    };
    await this.writeRecord(this.record);
    return this.status();
  }

  async close() {
    if (!this.writeAllowed || this.record?.device_id !== this.deviceId) return;
    const now = new Date().toISOString();
    this.record = { ...this.record, last_activity_at: now, lease_expires_at: now };
    await this.writeRecord(this.record);
  }

  status(): SessionStatus {
    const record = this.record ?? {
      device_id: this.deviceId,
      started_at: new Date(0).toISOString(),
      last_activity_at: new Date(0).toISOString(),
      lease_expires_at: new Date(0).toISOString()
    };
    return {
      currentDeviceId: this.deviceId,
      activeDeviceId: record.device_id,
      startedAt: record.started_at,
      lastActivityAt: record.last_activity_at,
      leaseExpiresAt: record.lease_expires_at,
      writeAllowed: this.writeAllowed,
      warning: this.warning
    };
  }

  private async claim() {
    this.writeAllowed = true;
    this.warning = undefined;
    const now = new Date();
    this.record = {
      device_id: this.deviceId,
      started_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + this.leaseDurationMs).toISOString()
    };
    await this.writeRecord(this.record);
  }

  private async readRecord(): Promise<SessionRecord | undefined> {
    const content = await readFile(this.sessionPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!content) return undefined;
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return undefined;
    const value = parse(match[1] ?? "") as Partial<SessionRecord>;
    return typeof value.device_id === "string" && typeof value.started_at === "string" && typeof value.last_activity_at === "string" && typeof value.lease_expires_at === "string"
      ? value as SessionRecord : undefined;
  }

  private async writeRecord(record: SessionRecord) {
    await mkdir(path.dirname(this.sessionPath), { recursive: true });
    const content = `---\n${stringify(record).trimEnd()}\n---\nAdvisory LifeOS device lease. Revision and content-hash checks remain authoritative.\n`;
    const temporary = `${this.sessionPath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, this.sessionPath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async cleanupTemporaryFiles() {
    const directory = path.dirname(this.sessionPath);
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(entries
      .filter((name) => name.startsWith("session.md.") && name.endsWith(".tmp"))
      .map((name) => rm(path.join(directory, name), { force: true })));
  }
}
