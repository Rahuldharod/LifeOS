import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectStore } from "@lifeos/application";
import { validateFrontmatter, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { parse, stringify } from "yaml";

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

function decode(content: string, relativePath: string): LifeOSObject {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`${relativePath}: missing YAML front matter`);
  const frontmatter = validateFrontmatter(parse(match[1] ?? ""));
  return { frontmatter, body: match[2] ?? "", relativePath, contentHash: hash(content) };
}

async function markdownFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".lifeos") continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await markdownFiles(root, full));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path.relative(root, full));
  }
  return found;
}

export class MarkdownObjectStore implements ObjectStore {
  private readonly root: string;
  private readonly operations: FilesystemOperationStore;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.operations = new FilesystemOperationStore(this.root);
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
    const files = await markdownFiles(this.root).catch((error: Error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const result: LifeOSObject[] = [];
    const diagnostics: string[] = [];
    for (const relativePath of files) {
      try {
        const object = await this.read(relativePath);
        result.push(object);
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
    if (input.expectedHash) {
      const current = await readFile(target, "utf8").catch(() => undefined);
      if (!current || hash(current) !== input.expectedHash) throw new ObjectConflictError(`Object changed since it was opened: ${input.relativePath}`);
      const versionPath = path.join(this.root, ".lifeos", "versions", input.frontmatter.id, `${String(input.frontmatter.revision - 1).padStart(6, "0")}--${hash(current).slice(0, 12)}.md`);
      await mkdir(path.dirname(versionPath), { recursive: true });
      await writeFile(versionPath, current, { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const next = `---\n${stringify(input.frontmatter).trimEnd()}\n---\n${input.body}`;
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(next, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    return decode(next, input.relativePath);
  }

  private safePath(relativePath: string) {
    const target = path.resolve(this.root, relativePath);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new Error("Path escapes the LifeOS data root");
    return target;
  }
}

export interface OperationRecord {
  id: string;
  kind: string;
  status: "prepared" | "completed";
  created_at: string;
  completed_at?: string;
  payload: Record<string, unknown>;
}

export class FilesystemOperationStore {
  private readonly directory: string;
  constructor(root: string) { this.directory = path.join(path.resolve(root), ".lifeos", "operations"); }

  async prepare(kind: string, payload: Record<string, unknown>, operationId: string = randomUUID()): Promise<OperationRecord> {
    const existing = await this.read(operationId);
    if (existing) return existing;
    const record: OperationRecord = { id: operationId, kind, status: "prepared", created_at: new Date().toISOString(), payload };
    await this.save(record);
    return record;
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
