import { createHash } from "node:crypto";
import { uuidV7, type LifeOSObject } from "@lifeos/domain";
import { markdownFileName, type AppContext } from "./context.js";
import type { InboxDocument, InboxFile, InboxStore } from "./ports.js";

/**
 * Adoption (ADR 0007): turns Agent-written Inbox Drafts in `_inbox/drafts/` into objects.
 *
 * One batch: read each draft → check the shared contract → check idempotency (draft_key + content
 * hash) → route by kind and origin to a handler that writes objects → file the draft in
 * `_inbox/processed/` or `_inbox/failed/` with a `.result.md` sidecar → one agent-run for the batch.
 * New draft kinds and origins plug in as entries in `routes`; patches and requests get their own readers.
 *
 * Crash safety (#32): each batch and each draft handed to a handler is journalled as an operation
 * (`adopt-batch`, `adopt-draft`). Handlers take object IDs from `run.newId()`, which are derived from
 * the journal entry, so the next batch (startup included) replays an interrupted draft onto the same
 * IDs, finishes its audit/move/sidecar, and writes the missing agent-run: nothing is duplicated.
 */

export const draftContractVersion = 1;
export const draftKinds = ["task", "decision", "open-point", "knowledge-note", "source", "person", "meeting-material", "daily-focus"] as const;
export type DraftKind = typeof draftKinds[number];
export const draftOrigins = ["user-dictated", "agent-extracted"] as const;
export type DraftOrigin = typeof draftOrigins[number];

/** A draft that passed the shared contract checks. Kind-specific fields stay in `fields` for the handler to validate. */
export interface ParsedDraft {
  file: InboxFile;
  contentHash: string;
  kind: DraftKind;
  draftKey: string;
  origin: DraftOrigin;
  title: string;
  /** `captured_at` normalised to UTC `Z`. */
  capturedAt: string;
  fields: Record<string, unknown>;
  /** The narrative (Markdown body). */
  body: string;
}

/** Batch-wide facts shared by every handler. `self()` is resolved once so a batch never creates two self persons. */
export interface AdoptionRun {
  id: string;
  now: string;
  self(): Promise<LifeOSObject>;
  /** A UUIDv7 for each object the draft creates. Always use this, not `uuidV7()`: a crash replay gets the same IDs back. */
  newId(): string;
}

/** Writes the objects for one draft and returns their IDs. Throw `DraftError` for anything the Agent must fix. */
export type DraftHandler = (draft: ParsedDraft, run: AdoptionRun) => Promise<string[]>;

/** A problem with the draft itself: the draft is filed in `_inbox/failed/`. Each issue reads "field: reason". */
export class DraftError extends Error {
  override name = "DraftError";
  constructor(readonly issues: string[]) { super(issues.join("; ")); }
}

export type DraftOutcome = "adopted" | "duplicate" | "failed" | "skipped";
export interface DraftResult {
  /** Where the draft was found, e.g. `_inbox/drafts/x.md`. */
  draft: string;
  outcome: DraftOutcome;
  objectIds: string[];
  /** Path-aware reason for failed and skipped drafts. */
  reason?: string;
  /** Where the draft was moved to; absent for skipped drafts, which stay in `_inbox/drafts/`. */
  filedAs?: string;
}
export interface AdoptionBatch {
  /** The batch's agent-run; absent when no draft was filed (nothing to adopt, or everything skipped). */
  agentRunId?: string;
  drafts: DraftResult[];
  /** True when a draft was skipped only because it may still be being written: trigger again in a few seconds. */
  retrySoon: boolean;
}
export interface InboxStatus {
  awaiting: number;
  failed: Array<{ path: string; reason: string }>;
}

export interface AutoAdoptionOptions {
  /** Quiet period after the last watcher event before a batch runs (default 2.5 s). */
  debounceMs?: number;
  /** Delay before looking again at drafts skipped as still being written (default 2.5 s). */
  retryMs?: number;
  /** Safety sweep for folders whose watcher events are unreliable, e.g. Drive-synced (default 60 s). */
  sweepMs?: number;
  /** Adoption writes objects, so it only runs while this device may write (holds the lease). */
  canWrite?: () => boolean;
  onBatch?: (batch: AdoptionBatch) => void;
  onError?: (error: unknown) => void;
}
export interface AutoAdoption {
  /** Call on every watcher event in `_inbox/drafts/`; bursts collapse into one batch. */
  notify(): void;
  /** Runs a batch now (startup); resolves undefined when this device may not write. */
  runNow(): Promise<AdoptionBatch | undefined>;
  stop(): void;
}

/** Drafts modified more recently than this may still be being written (or synced) and wait for the next trigger. */
export const partialFileGraceMs = 2000;
const adoptedAction = "draft.adopted";
const resultName = (name: string) => `${name.replace(/\.md$/, "")}.result.md`;
const isResult = (file: InboxFile) => file.name.endsWith(".result.md");
type FiledResult = { draftKey: string; objectIds: string[]; errors?: string[]; outcome?: "adopted" | "duplicate"; original?: { result?: string; agentRunId?: string } };
type Ledger = Map<string, { contentHash: string; objectIds: string[]; agentRunIds: Set<string> }>;
type Operation = { id: string; kind: string; payload: Record<string, unknown> };
/** How many replayable IDs recovery checks per draft; far more objects than any single draft creates. */
const replayWindow = 64;

/** UUIDv7 `index` of the journalled draft `seed`: the same inputs always give the same ID. */
function replayableId(seed: string, index: number, now: string) {
  const bytes = createHash("sha256").update(`${seed}:${index}`).digest().subarray(0, 16);
  let timestamp = BigInt(Date.parse(now));
  for (let position = 5; position >= 0; position -= 1) { bytes[position] = Number(timestamp & 0xffn); timestamp >>= 8n; }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const stringList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

// Any ISO 8601 date or date-time; a time must carry `Z` or an offset so the instant is unambiguous.
const isoInstant = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?))?$/i;
function toUtc(value: unknown) {
  const raw = value instanceof Date ? value.toISOString() : text(value);
  const match = raw.match(isoInstant);
  if (!match) return undefined;
  const [, date, time, zone] = match;
  const offset = !zone || /^z$/i.test(zone) ? "Z" : zone.length === 3 ? `${zone}:00` : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(time ? `${date}T${time.replace(",", ".")}${offset}` : `${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
const isCalendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** Zod issues (from the object store's validation) as "field: reason"; anything else is not the draft's fault. */
function validationIssues(error: unknown) {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  return error instanceof DraftError ? error.issues : Array.isArray(issues) ? issues.map((issue) => `${issue.path.map(String).join(".") || "front matter"}: ${issue.message}`) : undefined;
}

export class AdoptionModule {
  /** Handlers keyed `kind:origin`. Missing combinations fail with "not supported yet" so nothing is guessed. */
  private readonly routes: Partial<Record<`${DraftKind}:${DraftOrigin}`, DraftHandler>> = {
    "task:user-dictated": (draft, run) => this.adoptDictatedTask(draft, run)
  };
  /** Unparsable drafts by name → content hash: the first sighting may be a partial sync, so it is skipped once. */
  private readonly unparsableSeen = new Map<string, string>();
  /** Batches run one at a time, so startup, the watcher and "Adopt now" can never adopt one draft twice. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: AppContext, private readonly inbox?: InboxStore) {}

  adoptDrafts(options: { now?: Date } = {}): Promise<AdoptionBatch> {
    return this.enqueue(() => this.runBatch(options.now ?? new Date()));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** #32: adopts automatically after watcher events (debounced), retries drafts still being written, and sweeps periodically. */
  startAutoAdoption(options: AutoAdoptionOptions = {}): AutoAdoption {
    const { debounceMs = 2500, retryMs = 2500, sweepMs = 60_000, canWrite = () => true, onBatch, onError } = options;
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    // At most one trigger batch waits in the queue: further events before it starts are already covered by it.
    let waiting: Promise<AdoptionBatch | undefined> | undefined;
    const schedule = (delay: number) => { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => { timer = undefined; void runNow(); }, delay); timer.unref?.(); };
    const runNow = () => waiting ??= this.enqueue(async () => {
      waiting = undefined;
      // Checked when the batch starts, not when it was queued: the lease may have moved, or the app stopped, meanwhile.
      return stopped || !canWrite() ? undefined : this.runBatch(new Date());
    }).then((batch) => {
      if (batch) onBatch?.(batch);
      // Drafts still being written were skipped; look again once the 2-second grace period has passed.
      if (batch?.retrySoon) schedule(retryMs);
      return batch;
    }, (error: unknown) => { onError?.(error); return undefined; });
    const sweep = setInterval(() => { if (!timer) void runNow(); }, sweepMs);
    sweep.unref?.();
    return {
      notify: () => schedule(debounceMs),
      runNow,
      stop: () => { stopped = true; clearTimeout(timer); clearInterval(sweep); }
    };
  }

  async inboxStatus(): Promise<InboxStatus> {
    if (!this.inbox) return { awaiting: 0, failed: [] };
    const [drafts, failed] = await Promise.all([this.inbox.list("drafts"), this.inbox.list("failed")]);
    const names = new Set(failed.map((file) => file.name));
    const reasons = await Promise.all(failed.filter((file) => !isResult(file)).map(async (file) => {
      const sidecar = names.has(resultName(file.name)) ? await this.inbox!.read("failed", resultName(file.name)).catch(() => undefined) : undefined;
      const errors = sidecar?.frontmatter?.errors;
      return { path: file.relativePath, reason: Array.isArray(errors) && errors.length ? errors.map(String).join("; ") : `no readable ${resultName(file.name)} sidecar` };
    }));
    return { awaiting: drafts.length, failed: reasons };
  }

  /** System Health lines for failed drafts: they stay listed until the user removes or fixes them. */
  async diagnostics() {
    return (await this.inboxStatus()).failed.map((entry) => `${entry.path}: draft not adopted (${entry.reason})`);
  }

  private async runBatch(now: Date): Promise<AdoptionBatch> {
    const { inbox, ctx } = this;
    if (!inbox) return { drafts: [], retrySoon: false };
    await inbox.ensureFolders();
    await ctx.rebuildIndex();
    const recovered = await this.recover();
    const timestamp = now.toISOString();
    const run = this.run(uuidV7(), timestamp);
    const ledger = this.ledger();
    const results: DraftResult[] = [];
    let journalled = false;
    let retrySoon = false;

    for (const file of await inbox.list("drafts")) {
      if (recovered.handled.has(file.name)) continue;
      if (now.getTime() - file.modifiedAt < partialFileGraceMs) { retrySoon = true; results.push({ draft: file.relativePath, outcome: "skipped", objectIds: [], reason: `${file.relativePath}: modified less than 2 seconds ago; will retry` }); continue; }
      const document = await inbox.read("drafts", file.name);
      if (document.error && this.unparsableSeen.get(file.name) !== document.contentHash) {
        this.unparsableSeen.set(file.name, document.contentHash);
        retrySoon = true;
        results.push({ draft: file.relativePath, outcome: "skipped", objectIds: [], reason: `${file.relativePath}: ${document.error}; will retry once in case it is still syncing` });
        continue;
      }
      this.unparsableSeen.delete(file.name);
      // The batch is journalled before its first draft is filed, so a crash before the agent-run is finished on restart.
      if (!journalled) { await ctx.objects.prepareOperation?.("adopt-batch", { run_id: run.id, now: timestamp }, run.id); journalled = true; }
      results.push(await this.adoptOne(document, run, ledger));
    }

    const filed = results.filter((result) => result.outcome !== "skipped");
    if (filed.length) await this.recordRun(run, filed);
    if (journalled) await ctx.objects.completeOperation?.(run.id);
    if (filed.length || recovered.results.length) await ctx.rebuildIndex();
    return { ...(filed.length ? { agentRunId: run.id } : {}), drafts: [...recovered.results, ...results], retrySoon };
  }

  private run(id: string, now: string): AdoptionRun {
    let self: Promise<LifeOSObject> | undefined;
    return { id, now, self: () => self ??= this.ctx.ensureSelfPerson(now), newId: () => uuidV7() };
  }

  /** One agent-run per batch; a recovered batch also lists objects its drafts created before the crash. */
  private async recordRun(run: AdoptionRun, filed: DraftResult[], recovered = false) {
    const audited = this.ctx.index.all().filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === adoptedAction && (object.frontmatter.metadata as Record<string, unknown> | undefined)?.agent_run_id === run.id).map((object) => String(object.frontmatter.object_id));
    const created = [...new Set([...audited, ...filed.flatMap((result) => result.outcome === "adopted" ? result.objectIds : [])])];
    const count = (outcome: DraftOutcome) => filed.filter((result) => result.outcome === outcome).length;
    const summary = `${count("adopted")} adopted, ${count("duplicate")} duplicate, ${count("failed")} failed`;
    await this.ctx.objects.write({
      relativePath: `agent-runs/${markdownFileName("Inbox adoption", run.id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(run.id, "agent-run", "Inbox adoption", run.now), operation: "inbox-adoption", provider: "lifeos", model: "rules", prompt_version: `draft-contract-${draftContractVersion}`, status: "succeeded", started_at: run.now, completed_at: new Date().toISOString(), output_summary: recovered ? `completed after an interruption (${summary} on recovery)` : summary, related_object_ids: created },
      body: "# Inbox adoption\n"
    });
  }

  /**
   * Finishes batches interrupted by a crash (or a write error): replays each journalled draft onto its
   * journalled IDs, or completes its audit and sidecar if it was already moved, then writes any missing agent-run.
   */
  private async recover(): Promise<{ results: DraftResult[]; handled: Set<string> }> {
    const pending = (await this.ctx.objects.incompleteOperations?.() ?? []).filter((operation) => operation.kind === "adopt-draft" || operation.kind === "adopt-batch");
    const handled = new Set<string>();
    if (!pending.length) return { results: [], handled };
    const runs = new Map<string, { run: AdoptionRun; filed: DraftResult[] }>();
    const runOf = (operation: Operation) => {
      const id = String(operation.payload.run_id);
      const entry = runs.get(id) ?? { run: this.run(id, String(operation.payload.now)), filed: [] };
      runs.set(id, entry);
      return entry;
    };
    const results: DraftResult[] = [];
    for (const operation of pending.filter((candidate) => candidate.kind === "adopt-draft")) {
      handled.add(String(operation.payload.draft));
      const entry = runOf(operation);
      const result = await this.recoverDraft(operation, entry.run);
      if (!result) continue;
      results.push(result);
      if (result.outcome !== "skipped") entry.filed.push(result);
    }
    for (const operation of pending.filter((candidate) => candidate.kind === "adopt-batch")) runOf(operation);
    await this.ctx.rebuildIndex();
    for (const [id, { run, filed }] of runs) {
      if (!this.ctx.index.get(id) && (filed.length || this.ledgerHasRun(id))) await this.recordRun(run, filed, true);
      await this.ctx.objects.completeOperation?.(id);
    }
    await this.ctx.rebuildIndex();
    return { results, handled };
  }

  private ledgerHasRun(runId: string) {
    return [...this.ledger().values()].some((entry) => entry.agentRunIds.has(runId));
  }

  private async recoverDraft(operation: Operation, run: AdoptionRun): Promise<DraftResult | undefined> {
    const inbox = this.inbox!;
    const name = String(operation.payload.draft);
    const contentHash = String(operation.payload.content_hash);
    const draftKey = String(operation.payload.draft_key);
    const draft = (await inbox.list("drafts")).find((file) => file.name === name);
    const document = draft ? await inbox.read("drafts", name) : undefined;
    // Still in drafts, unchanged: replay it onto the same IDs.
    if (document?.contentHash === contentHash) return this.adoptOne(document, run, this.ledger(), operation);

    // Already moved (or gone, or changed since): record what was created so a re-send is recognised.
    const objectIds = Array.from({ length: replayWindow }, (_, index) => replayableId(operation.id, index, run.now)).filter((id) => this.ctx.index.get(id));
    await this.auditOnce(objectIds, { draftKey, contentHash, draftPath: `_inbox/drafts/${name}`, origin: operation.payload.origin }, run, this.ledger());
    let result: DraftResult | undefined;
    const processed = await inbox.list("processed");
    const names = new Set(processed.map((file) => file.name));
    for (const file of processed.filter((candidate) => !isResult(candidate) && !names.has(resultName(candidate.name)))) {
      const moved = await inbox.read("processed", file.name);
      if (moved.contentHash !== contentHash) continue;
      result = await this.writeResult(moved, `_inbox/drafts/${name}`, file, "processed", { draftKey, objectIds, outcome: "adopted" }, run);
      break;
    }
    await this.ctx.objects.completeOperation?.(operation.id);
    return result;
  }

  /** One `draft.adopted` audit per created object; on a replay, objects already audited before the crash are left alone. */
  private async auditOnce(objectIds: string[], draft: { draftKey: string; contentHash: string; draftPath: string; origin: unknown }, run: AdoptionRun, ledger: Ledger) {
    const audited = new Set(ledger.get(draft.draftKey)?.objectIds ?? []);
    for (const id of objectIds) if (!audited.has(id)) await this.ctx.writeAudit(adoptedAction, id, run.now, { draft_key: draft.draftKey, content_hash: draft.contentHash, draft_path: draft.draftPath, agent_run_id: run.id, origin: draft.origin });
  }

  /** `replay`: the journal entry of an interrupted attempt at this same draft; its IDs are reused and the ledger check is skipped (the ledger entry is its own). */
  private async adoptOne(document: InboxDocument, run: AdoptionRun, ledger: Ledger, replay?: Operation): Promise<DraftResult> {
    const fields = document.frontmatter ?? {};
    const draftKey = text(fields.draft_key);
    const prefix = `${document.relativePath}${draftKey ? ` (draft_key ${draftKey})` : ""}`;
    const fail = async (issues: string[]) => {
      const result = await this.file(document, "failed", { draftKey, objectIds: [], errors: [`${prefix}: ${issues.join("; ")}`] }, run);
      if (replay) await this.ctx.objects.completeOperation?.(replay.id);
      return result;
    };

    if (document.error) return fail([document.error]);
    const parsed = this.parse(document);
    if (!parsed.draft) return fail(parsed.issues);
    const draft = parsed.draft;

    const previous = replay ? undefined : ledger.get(draft.draftKey);
    if (previous && previous.contentHash === draft.contentHash) return this.file(document, "processed", { draftKey, objectIds: previous.objectIds, outcome: "duplicate", original: await this.originalResult(draft, previous.agentRunIds) }, run);
    if (previous) return fail([`draft_key: idempotency conflict: draft_key ${draft.draftKey} was already adopted from different content (object ${previous.objectIds.join(", ")}); use a new draft_key, or a Patch Draft to change it`]);

    const handler = this.routes[`${draft.kind}:${draft.origin}`];
    if (!handler) return fail([`kind: ${draft.kind} drafts with origin ${draft.origin} are not supported yet`]);
    const operation: Operation = replay ?? { id: uuidV7(), kind: "adopt-draft", payload: { run_id: run.id, now: run.now, draft: document.name, draft_key: draft.draftKey, content_hash: draft.contentHash, origin: draft.origin } };
    if (!replay) await this.ctx.objects.prepareOperation?.(operation.kind, operation.payload, operation.id);
    const complete = () => this.ctx.objects.completeOperation?.(operation.id);
    let next = 0;
    let objectIds: string[];
    try { objectIds = await handler(draft, { ...run, newId: () => replayableId(operation.id, next++, run.now) }); }
    catch (error) {
      const issues = validationIssues(error);
      if (issues) { await complete(); return fail(issues); }
      // Not the draft's fault (disk, lease, duplicate-ID block): the journal entry stays, so the next trigger replays it onto the same IDs.
      return { draft: document.relativePath, outcome: "skipped", objectIds: [], reason: `${prefix}: ${error instanceof Error ? error.message : String(error)}; will retry` };
    }
    await this.auditOnce(objectIds, { draftKey: draft.draftKey, contentHash: draft.contentHash, draftPath: document.relativePath, origin: draft.origin }, run, replay ? ledger : new Map());
    ledger.set(draft.draftKey, { contentHash: draft.contentHash, objectIds, agentRunIds: new Set([run.id]) });
    const result = await this.file(document, "processed", { draftKey, objectIds, outcome: "adopted" }, run);
    await complete();
    return result;
  }

  /** Where the first adoption of this draft_key + content was recorded: its sidecar if still present, and its agent-run. */
  private async originalResult(draft: ParsedDraft, agentRunIds: Set<string>) {
    const [agentRunId] = agentRunIds;
    const original: { result?: string; agentRunId?: string } = agentRunId ? { agentRunId } : {};
    for (const file of (await this.inbox!.list("processed")).filter(isResult)) {
      const sidecar = (await this.inbox!.read("processed", file.name).catch(() => undefined))?.frontmatter;
      if (sidecar?.outcome === "adopted" && sidecar.draft_key === draft.draftKey && sidecar.content_hash === draft.contentHash) { original.result = file.relativePath; break; }
    }
    return original;
  }

  /** The shared contract v1 checks; returns every issue at once so the Agent can fix them in one go. */
  private parse(document: InboxDocument): { draft?: ParsedDraft; issues: string[] } {
    const fields = document.frontmatter ?? {};
    const version = fields.lifeos_draft;
    if (version === undefined) return { issues: ["lifeos_draft: missing; a draft must start with lifeos_draft: 1"] };
    if (version !== draftContractVersion) return { issues: [`lifeos_draft: unsupported contract version ${String(version)} (this LifeOS reads version ${draftContractVersion})`] };
    const issues: string[] = [];
    const kind = text(fields.kind);
    if (!kind) issues.push("kind: missing");
    else if (!(draftKinds as readonly string[]).includes(kind)) issues.push(`kind: unknown kind "${kind}" (expected one of ${draftKinds.join(", ")})`);
    const draftKey = text(fields.draft_key);
    if (!draftKey) issues.push("draft_key: missing; choose any unique string so re-sends are recognised");
    const origin = text(fields.origin);
    if (!(draftOrigins as readonly string[]).includes(origin)) issues.push(origin ? `origin: unknown origin "${origin}" (expected ${draftOrigins.join(" or ")})` : "origin: missing");
    const title = text(fields.title);
    if (!title) issues.push("title: missing");
    const capturedAt = toUtc(fields.captured_at);
    if (fields.captured_at === undefined) issues.push("captured_at: missing");
    else if (!capturedAt) issues.push(`captured_at: not an ISO 8601 date-time with Z or an offset ("${String(fields.captured_at)}")`);
    if (issues.length) return { issues };
    return { issues, draft: { file: document, contentHash: document.contentHash, kind: kind as DraftKind, draftKey, origin: origin as DraftOrigin, title, capturedAt: capturedAt!, fields, body: document.body } };
  }

  /** Moves the draft to its outcome folder and writes the `.result.md` sidecar the Agent reads to confirm what happened. */
  private async file(document: InboxDocument, folder: "processed" | "failed", result: FiledResult, run: AdoptionRun): Promise<DraftResult> {
    const filed = await this.inbox!.move("drafts", document.name, folder);
    return this.writeResult(document, document.relativePath, filed, folder, result, run);
  }

  private async writeResult(document: InboxDocument, draftPath: string, filed: InboxFile, folder: "processed" | "failed", result: FiledResult, run: AdoptionRun): Promise<DraftResult> {
    const outcome = result.outcome ?? "failed";
    const original = result.original;
    const pointer = original?.result ? ` The original result is ${original.result}.` : original?.agentRunId ? ` It was adopted by agent-run ${original.agentRunId}.` : "";
    const heading = outcome === "adopted" ? `# Adopted\n\nCreated ${result.objectIds.join(", ")}.\n` : outcome === "duplicate" ? `# Already adopted\n\nThis draft was adopted before as ${result.objectIds.join(", ")}; nothing new was created.${pointer}\n` : `# Not adopted\n\n${result.errors!.map((error) => `- ${error}`).join("\n")}\n\nFix the draft and send it again; this file is kept and never deleted automatically.\n`;
    await this.inbox!.writeDocument(folder, resultName(filed.name), {
      lifeos_result: draftContractVersion, outcome, draft: draftPath, filed_as: filed.relativePath,
      ...(result.draftKey ? { draft_key: result.draftKey } : {}), content_hash: document.contentHash,
      object_ids: result.objectIds, errors: result.errors ?? [], processed_at: run.now, agent_run_id: run.id,
      ...(original?.result ? { original_result: original.result } : {}), ...(original?.agentRunId ? { original_agent_run_id: original.agentRunId } : {})
    }, heading);
    return { draft: draftPath, outcome, objectIds: result.objectIds, filedAs: filed.relativePath, ...(result.errors ? { reason: result.errors.join("; ") } : {}) };
  }

  /** draft_key → what it produced, from `draft.adopted` audit events (authoritative, so it survives restarts and lost sidecars). */
  private ledger(): Ledger {
    const ledger: Ledger = new Map();
    for (const object of this.ctx.index.all()) {
      const { frontmatter } = object;
      if (frontmatter.type !== "audit-event" || frontmatter.action !== adoptedAction) continue;
      const metadata = frontmatter.metadata as Record<string, unknown> | undefined;
      if (typeof metadata?.draft_key !== "string" || typeof metadata.content_hash !== "string" || typeof frontmatter.object_id !== "string") continue;
      const entry = ledger.get(metadata.draft_key) ?? { contentHash: metadata.content_hash, objectIds: [], agentRunIds: new Set<string>() };
      entry.objectIds.push(frontmatter.object_id);
      if (typeof metadata.agent_run_id === "string") entry.agentRunIds.add(metadata.agent_run_id);
      ledger.set(metadata.draft_key, entry);
    }
    return ledger;
  }

  /** `task` + `user-dictated`: an Inbox task owned by self, created without review (PRD story 2). */
  private async adoptDictatedTask(draft: ParsedDraft, run: AdoptionRun) {
    const { fields } = draft;
    const issues: string[] = [];
    const extra: Record<string, unknown> = {};
    const status = text(fields.status) || "Inbox";
    const statuses = ["Inbox", "Next", "Waiting", "Done", "Cancelled"];
    if (!statuses.includes(status)) issues.push(`status: unknown status "${status}" (expected one of ${statuses.join(", ")})`);
    if (status === "Done") extra.completed_at = draft.capturedAt;
    if (status === "Cancelled") extra.cancelled_at = draft.capturedAt;
    if (fields.priority !== undefined) {
      const priority = text(fields.priority).toLowerCase();
      const match = ["High", "Medium", "Low"].find((candidate) => candidate.toLowerCase() === priority);
      if (match) extra.priority = match; else issues.push(`priority: unknown priority "${text(fields.priority)}" (expected High, Medium or Low)`);
    }
    if (fields.due_on !== undefined && fields.due_at !== undefined) issues.push("due_on: use due_on or due_at, not both");
    else if (fields.due_on !== undefined) {
      const dueOn = text(fields.due_on);
      if (isCalendarDate(dueOn)) extra.due_on = dueOn; else issues.push(`due_on: not a calendar date YYYY-MM-DD ("${dueOn}")`);
    } else if (fields.due_at !== undefined) {
      const dueAt = text(fields.due_at).includes("T") ? toUtc(fields.due_at) : undefined;
      if (dueAt) { extra.due_at = dueAt; extra.due_timezone = text(fields.due_timezone) || "UTC"; } else issues.push(`due_at: not an ISO 8601 date-time with Z or an offset ("${text(fields.due_at)}")`);
    }
    if (fields.expected_output !== undefined) {
      if (typeof fields.expected_output === "string") extra.expected_output = fields.expected_output.trim(); else issues.push("expected_output: must be text");
    }
    // Envelope extras pass through; their values are validated by the envelope rules when the object is written.
    for (const key of ["area", "sensitivity"]) if (fields[key] !== undefined) extra[key] = fields[key];
    for (const key of ["subjects", "tags"]) if (fields[key] !== undefined) { if (stringList(fields[key])) extra[key] = fields[key]; else issues.push(`${key}: must be a list of text`); }
    if (issues.length) throw new DraftError(issues);

    const owner = await run.self();
    const id = run.newId();
    const narrative = draft.body.trim();
    await this.ctx.objects.write({
      relativePath: `tasks/${markdownFileName(draft.title, id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(id, "task", draft.title, run.now, draft.origin), status, owner_person_id: owner.frontmatter.id, captured_at: draft.capturedAt, source_ids: [], ...extra },
      body: `# ${draft.title}\n${narrative ? `\n${narrative}\n` : ""}`
    });
    return [id];
  }
}
