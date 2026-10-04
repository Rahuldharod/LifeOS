import { createHash } from "node:crypto";
import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { foldForSearch, markdownFileName, type AppContext } from "./context.js";
import { adoptDailyFocus } from "./focus.js";
import type { MeetingsModule } from "./meetings.js";
import { MeetingMaterialModule } from "./meeting-material.js";
import type { PatchModule } from "./patches.js";
import type { InboxDocument, InboxFile, InboxFolder, InboxStore } from "./ports.js";
import { internalDomainsOf, isExternalDomain, normalizeEmail, organizationFromDomain, personEmails } from "./people.js";
import { PersonMergeModule } from "./person-merge.js";
import { ReferenceResolver, type ReferenceField } from "./resolution.js";
import { contextLinkFields, inheritContextLinks, isStringList } from "./support.js";

/**
 * Adoption (ADR 0007): turns Agent-written Inbox Drafts in `_inbox/drafts/` into objects.
 *
 * One batch: read each draft → check the shared contract → check idempotency (draft_key + content
 * hash) → route by kind and origin to a handler that writes objects → file the draft in
 * `_inbox/processed/` or `_inbox/failed/` with a `.result.md` sidecar → one agent-run for the batch.
 * New draft kinds and origins plug in as entries in `routes`. Patch Drafts in `_inbox/patches/` are read by
 * `PatchModule` (patches.ts) in the same batch, after the drafts; requests will get their own reader.
 *
 * Crash safety (#32): each batch and each draft or patch handed to its handler is journalled as an operation
 * (`adopt-batch`, `adopt-draft`). Handlers take object IDs from `run.newId(role)`, which are derived from the
 * journal entry plus a stable role key (#59), so the next batch (startup included) replays an interrupted draft
 * onto the same IDs, finishes its audit, move and sidecar, and writes the missing agent-run: nothing is duplicated.
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
  /**
   * A UUIDv7 for each object (or Review Item operation ID) the draft creates. Always use this, not `uuidV7()`:
   * a replay after a crash gets the same IDs back, so it finds the same objects instead of duplicating them.
   * `role` names what the ID is for and must not depend on what the attempt found already written (#59): e.g.
   * `main`, `source:url:<url>`, `summary`, `proposal:<key>`, `merge:<pair>`; add `:operation` for an operation ID.
   */
  newId(role: string): string;
}

/** Options for `proposeExtracted` when another handler reuses it (#45): extra Review Item fields, its ID, or validation only. */
export interface ProposeOptions { extra?: Record<string, unknown>; role?: string; dryRun?: boolean }

/** Writes the objects for one draft and returns their IDs. Throw `DraftError` for anything the Agent must fix. */
export type DraftHandler = (draft: ParsedDraft, run: AdoptionRun) => Promise<string[]>;

/** A problem with the draft itself: the draft is filed in `_inbox/failed/`. Each issue reads "field: reason". */
export class DraftError extends Error {
  override name = "DraftError";
  constructor(readonly issues: string[]) { super(issues.join("; ")); }
}

/** `review`: a Patch Draft became an `update` Review Item (#37); its ID is in `objectIds`. */
export type DraftOutcome = "adopted" | "applied" | "review" | "duplicate" | "failed" | "skipped";
export interface DraftResult {
  /** Where the draft was found, e.g. `_inbox/drafts/x.md` or `_inbox/patches/x.md`. */
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
/** What `file()` records in the `.result.md` sidecar; no `outcome` means failed (then `errors` is required). */
export interface FilingResult { draftKey: string; objectIds: string[]; errors?: string[]; outcome?: "adopted" | "applied" | "review" | "duplicate"; original?: { result?: string; agentRunId?: string } }
/** Files one inbox document from its reader's folder into `processed/` or `failed/` with its sidecar. */
export type FileDocument = (document: InboxDocument, folder: "processed" | "failed", result: FilingResult) => Promise<DraftResult>;

export interface InboxStatus {
  /** Inbox Drafts plus Patch Drafts waiting to be adopted. */
  awaiting: number;
  /** The split of `awaiting` (#48), so labels can say "3 drafts and 1 patch" rather than call patches drafts. */
  drafts: number;
  patches: number;
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
  /** Call on every watcher event in `_inbox/drafts/` or `_inbox/patches/`; bursts collapse into one batch. */
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
type Ledger = Map<string, { contentHash: string; objectIds: string[]; agentRunIds: Set<string> }>;
type Operation = { id: string; kind: string; payload: Record<string, unknown> };
type Reader = (document: InboxDocument) => Promise<DraftResult>;
/**
 * The UUIDv7 for `role` in the journalled operation `seed` (#59): the same inputs always give the same ID.
 * Layout: the 48-bit timestamp of `now`, then 26 bits derived from the operation alone (its tag), then 48 bits
 * derived from operation + role. The tag lets recovery find every object an operation wrote whatever its roles.
 */
function replayableId(seed: string, role: string, now: string) {
  const bytes = Buffer.alloc(16);
  let timestamp = BigInt(Date.parse(now));
  for (let position = 5; position >= 0; position -= 1) { bytes[position] = Number(timestamp & 0xffn); timestamp >>= 8n; }
  const tag = createHash("sha256").update(`operation:${seed}`).digest();
  bytes[6] = 0x70 | (tag[0]! & 0x0f);
  bytes[7] = tag[1]!;
  bytes[8] = 0x80 | (tag[2]! & 0x3f);
  bytes[9] = tag[3]!;
  createHash("sha256").update(`${seed}\n${role}`).digest().copy(bytes, 10, 0, 6);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether `id` is one of the replayable IDs of operation `seed`, whatever its role: the replay window. */
function replayScope(seed: string, now: string) {
  const prefix = replayableId(seed, "", now).slice(0, 23);
  return (id: string) => id.startsWith(prefix);
}
export const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

// Any ISO 8601 date or date-time; a time must carry `Z` or an offset so the instant is unambiguous.
const isoInstant = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?))?$/i;
export function toUtc(value: unknown) {
  const raw = value instanceof Date ? value.toISOString() : text(value);
  const match = raw.match(isoInstant);
  if (!match) return undefined;
  const [, date, time, zone] = match;
  const offset = !zone || /^z$/i.test(zone) ? "Z" : zone.length === 3 ? `${zone}:00` : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(time ? `${date}T${time.replace(",", ".")}${offset}` : `${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
/** A web link in canonical form (lower-case scheme and host, as `URL` writes it), or undefined for anything else. */
export function webUrl(value: unknown) {
  try { const url = new URL(text(value)); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
const looksLikeUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
export const isCalendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** The Review Item body for a proposal: its title, then the Agent's narrative as written. */
export function proposalBody(title: string, narrative?: unknown) {
  const body = typeof narrative === "string" ? narrative.trim() : "";
  return `# Proposal\n\n${title}\n${body ? `\n${body}\n` : ""}`;
}

/** Which by-name references (#33) each kind can carry; others are refused rather than silently dropped. */
const kindReferences: Record<string, ReferenceField[]> = {
  task: ["project", "client", "product", "people", "owner", "waiting_for", "meeting"],
  decision: ["project", "client", "product", "people", "meeting"],
  "open-point": ["project", "client", "product", "people", "owner", "meeting"]
};

/** Zod issues (from the object store's validation) as "field: reason"; anything else is not the draft's fault. */
export function validationIssues(error: unknown) {
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  return error instanceof DraftError ? error.issues : Array.isArray(issues) ? issues.map((issue) => `${issue.path.map(String).join(".") || "front matter"}: ${issue.message}`) : undefined;
}

export class AdoptionModule {
  /** Handlers keyed `kind:origin`. Missing combinations fail with "not supported yet" so nothing is guessed. */
  private readonly routes: Partial<Record<`${DraftKind}:${DraftOrigin}`, DraftHandler>> = {
    "task:user-dictated": (draft, run) => this.adoptDictated(draft, run),
    "decision:user-dictated": (draft, run) => this.adoptDictated(draft, run),
    "open-point:user-dictated": (draft, run) => this.adoptDictated(draft, run),
    "task:agent-extracted": (draft, run) => this.proposeExtracted(draft, run),
    "decision:agent-extracted": (draft, run) => this.proposeExtracted(draft, run),
    "open-point:agent-extracted": (draft, run) => this.proposeExtracted(draft, run),
    "knowledge-note:user-dictated": (draft, run) => this.adoptKnowledge(draft, run),
    "knowledge-note:agent-extracted": async (draft, run) => { await this.ctx.rebuildIndex(); return this.proposeExtracted(draft, run); },
    "source:user-dictated": (draft, run) => this.adoptSource(draft, run),
    "source:agent-extracted": (draft, run) => this.adoptSource(draft, run),
    "person:user-dictated": (draft, run) => this.adoptPerson(draft, run),
    "person:agent-extracted": (draft, run) => this.adoptPerson(draft, run),
    // #46: the morning brief is written straight to a daily-focus object (ADR 0011), whatever the origin.
    "daily-focus:agent-extracted": (draft, run) => adoptDailyFocus(this.ctx, draft, run),
    "daily-focus:user-dictated": (draft, run) => adoptDailyFocus(this.ctx, draft, run),
    "meeting-material:agent-extracted": (draft, run) => this.material.adopt(draft, run)
  };
  private personMerges?: PersonMergeModule;
  /** Unparsable drafts by name → content hash: the first sighting may be a partial sync, so it is skipped once. */
  private readonly unparsableSeen = new Map<string, string>();
  /** Batches run one at a time, so startup, the watcher and "Adopt now" can never adopt one draft twice. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly resolver: ReferenceResolver;
  /** #45: `meeting-material` drafts; its proposals go through `proposeExtracted` like any extracted draft. */
  private readonly material: MeetingMaterialModule;

  constructor(private readonly ctx: AppContext, private readonly inbox?: InboxStore, private readonly patches?: PatchModule, meetings?: MeetingsModule) {
    this.resolver = new ReferenceResolver(ctx);
    this.material = new MeetingMaterialModule(ctx, this.resolver, (draft, run, options) => this.proposeExtracted(draft, run, options), meetings);
  }

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
    if (!this.inbox) return { awaiting: 0, drafts: 0, patches: 0, failed: [] };
    const [drafts, patches, failed] = await Promise.all([this.inbox.list("drafts"), this.inbox.list("patches"), this.inbox.list("failed")]);
    const names = new Set(failed.map((file) => file.name));
    const reasons = await Promise.all(failed.filter((file) => !isResult(file)).map(async (file) => {
      const sidecar = names.has(resultName(file.name)) ? await this.inbox!.read("failed", resultName(file.name)).catch(() => undefined) : undefined;
      const errors = sidecar?.frontmatter?.errors;
      return { path: file.relativePath, reason: Array.isArray(errors) && errors.length ? errors.map(String).join("; ") : `no readable ${resultName(file.name)} sidecar` };
    }));
    return { awaiting: drafts.length + patches.length, drafts: drafts.length, patches: patches.length, failed: reasons };
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

    // Drafts first, so a patch can target an object created by a draft in the same batch.
    for (const folder of ["drafts", "patches"] as const) {
      let read: Reader = (document) => this.adoptOne(document, run, ledger);
      if (folder === "patches") {
        if (!this.patches) break;
        await ctx.rebuildIndex();
        read = this.journalledPatch(run);
      }
      for (const file of await inbox.list(folder)) {
        if (recovered.handled.has(file.relativePath)) continue;
        if (now.getTime() - file.modifiedAt < partialFileGraceMs) { retrySoon = true; results.push({ draft: file.relativePath, outcome: "skipped", objectIds: [], reason: `${file.relativePath}: modified less than 2 seconds ago; will retry` }); continue; }
        const document = await inbox.read(folder, file.name);
        if (document.error && this.unparsableSeen.get(file.relativePath) !== document.contentHash) {
          this.unparsableSeen.set(file.relativePath, document.contentHash);
          retrySoon = true;
          results.push({ draft: file.relativePath, outcome: "skipped", objectIds: [], reason: `${file.relativePath}: ${document.error}; will retry once in case it is still syncing` });
          continue;
        }
        this.unparsableSeen.delete(file.relativePath);
        // The batch is journalled before its first draft is filed, so a crash before the agent-run is finished on restart.
        if (!journalled) { await ctx.objects.prepareOperation?.("adopt-batch", { run_id: run.id, now: timestamp }, run.id); journalled = true; }
        results.push(await read(document));
      }
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

  /** The run as one journalled operation sees it: its IDs are replayable, keyed by role (#59). */
  private replayableRun(run: AdoptionRun, operationId: string): AdoptionRun {
    return { ...run, newId: (role) => replayableId(operationId, role, run.now) };
  }

  private patchReader(run: AdoptionRun): Reader {
    return this.patches!.reader(run, (document, outcome, result) => this.file("patches", document, outcome, result, run));
  }

  /**
   * Patches are journalled around their reader so recovery can finish filing one that was applied. Patches create
   * no objects (only a guarded update and its `patch.applied` audit, which is their idempotency ledger), so a replay
   * simply re-runs the reader: an already audited patch is then recognised and filed instead of applied twice.
   */
  private journalledPatch(run: AdoptionRun, replay?: Operation): Reader {
    return async (document) => {
      const operation: Operation = replay ?? { id: uuidV7(), kind: "adopt-draft", payload: { run_id: run.id, now: run.now, folder: "patches", draft: document.name, draft_key: text(document.frontmatter?.draft_key), content_hash: document.contentHash } };
      if (!replay) await this.ctx.objects.prepareOperation?.(operation.kind, operation.payload, operation.id);
      // A patch that raises an update Review Item gets replayable IDs too, so a crash never doubles the item.
      const read = () => this.patchReader(this.replayableRun(run, operation.id))(document);
      const result = await (replay ? this.ctx.replaying(replayScope(operation.id, run.now), read) : read());
      if (result.outcome !== "skipped") await this.ctx.objects.completeOperation?.(operation.id);
      return result;
    };
  }

  /** One agent-run per batch; a recovered batch also lists objects its drafts created before the crash. */
  private async recordRun(run: AdoptionRun, filed: DraftResult[], recovered = false) {
    const audited = this.ctx.index.all().filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === adoptedAction && (object.frontmatter.metadata as Record<string, unknown> | undefined)?.agent_run_id === run.id).map((object) => String(object.frontmatter.object_id));
    const created = [...new Set([...audited, ...filed.flatMap((result) => result.outcome === "adopted" || result.outcome === "applied" || result.outcome === "review" ? result.objectIds : [])])];
    const count = (outcome: DraftOutcome) => filed.filter((result) => result.outcome === outcome).length;
    const summary = `${count("adopted")} adopted, ${count("applied") ? `${count("applied")} applied, ` : ""}${count("review") ? `${count("review")} to review, ` : ""}${count("duplicate")} duplicate, ${count("failed")} failed`;
    await this.ctx.objects.write({
      relativePath: `agent-runs/${markdownFileName("Inbox adoption", run.id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(run.id, "agent-run", "Inbox adoption", run.now), operation: "inbox-adoption", provider: "lifeos", model: "rules", prompt_version: `draft-contract-${draftContractVersion}`, status: "succeeded", started_at: run.now, completed_at: new Date().toISOString(), output_summary: recovered ? `completed after an interruption (${summary} on recovery)` : summary, related_object_ids: created },
      body: "# Inbox adoption\n"
    });
  }

  /**
   * Finishes batches interrupted by a crash (or a write error): replays each journalled draft or patch still in
   * its folder (drafts onto their journalled IDs), or completes the audit and sidecar of one already moved,
   * then writes any missing agent-run.
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
      handled.add(`_inbox/${String(operation.payload.folder ?? "drafts")}/${String(operation.payload.draft)}`);
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
    const from = operation.payload.folder === "patches" ? "patches" as const : "drafts" as const;
    if (from === "patches" && !this.patches) return undefined;
    const name = String(operation.payload.draft);
    const contentHash = String(operation.payload.content_hash);
    const draftKey = String(operation.payload.draft_key);
    const draftPath = `_inbox/${from}/${name}`;
    const waiting = (await inbox.list(from)).find((file) => file.name === name);
    const document = waiting ? await inbox.read(from, name) : undefined;
    // The patch's own ledger: a `patch.applied` audit for this key and content means the change itself was made.
    const patched = from === "patches" ? this.ctx.index.all().filter((object) => {
      const metadata = object.frontmatter.metadata as Record<string, unknown> | undefined;
      return object.frontmatter.type === "audit-event" && object.frontmatter.action === "patch.applied" && metadata?.draft_key === draftKey && metadata.content_hash === contentHash;
    }).map((object) => String(object.frontmatter.object_id)) : [];
    // Still in its folder, unchanged: replay it (a draft onto the same IDs), or just file a patch that was applied.
    if (document?.contentHash === contentHash) {
      if (from === "drafts") return this.adoptOne(document, run, this.ledger(), operation);
      if (!patched.length) { await this.ctx.rebuildIndex(); return this.journalledPatch(run, operation)(document); }
      const result = await this.file("patches", document, "processed", { draftKey, objectIds: patched, outcome: "applied" }, run);
      await this.ctx.objects.completeOperation?.(operation.id);
      return result;
    }

    // Already moved (or gone, or changed since): record what was created so a re-send is recognised.
    let objectIds: string[];
    if (from === "patches") objectIds = patched;
    else {
      objectIds = this.writtenBy(operation.id, run.now);
      await this.auditOnce(objectIds, { draftKey, contentHash, draftPath, origin: operation.payload.origin }, run, this.ledger());
    }
    let result: DraftResult | undefined;
    for (const folder of ["processed", "failed"] as const) {
      const files = await inbox.list(folder);
      const names = new Set(files.map((file) => file.name));
      for (const file of files.filter((candidate) => !isResult(candidate) && !names.has(resultName(candidate.name)))) {
        const moved = await inbox.read(folder, file.name);
        if (moved.contentHash !== contentHash) continue;
        const filing: FilingResult = folder === "failed" ? { draftKey, objectIds: [], errors: [`${draftPath}: adoption was interrupted before the reason was recorded; send it again to see why it was refused`] } : { draftKey, objectIds, outcome: from === "patches" ? "applied" : "adopted" };
        result = await this.writeResult(from, moved, draftPath, file, folder, filing, run);
        break;
      }
      if (result) break;
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
      const result = await this.file("drafts", document, "failed", { draftKey, objectIds: [], errors: [`${prefix}: ${issues.join("; ")}`] }, run);
      if (replay) await this.ctx.objects.completeOperation?.(replay.id);
      return result;
    };

    if (document.error) return fail([document.error]);
    const parsed = this.parse(document);
    if (!parsed.draft) return fail(parsed.issues);
    const draft = parsed.draft;

    const previous = replay ? undefined : ledger.get(draft.draftKey);
    if (previous && previous.contentHash === draft.contentHash) return this.file("drafts", document, "processed", { draftKey, objectIds: previous.objectIds, outcome: "duplicate", original: await this.originalResult(draft, previous.agentRunIds) }, run);
    if (previous) return fail([`draft_key: idempotency conflict: draft_key ${draft.draftKey} was already adopted from different content (object ${previous.objectIds.join(", ")}); use a new draft_key, or a Patch Draft to change it`]);

    const handler = this.routes[`${draft.kind}:${draft.origin}`];
    if (!handler) return fail([`kind: ${draft.kind} drafts with origin ${draft.origin} are not supported yet`]);
    const operation: Operation = replay ?? { id: uuidV7(), kind: "adopt-draft", payload: { run_id: run.id, now: run.now, folder: "drafts", draft: document.name, draft_key: draft.draftKey, content_hash: draft.contentHash, origin: draft.origin } };
    if (!replay) await this.ctx.objects.prepareOperation?.(operation.kind, operation.payload, operation.id);
    const complete = () => this.ctx.objects.completeOperation?.(operation.id);
    let objectIds: string[];
    // A replay may meet objects its interrupted first attempt already wrote: those are reused, never rewritten (#58).
    const create = () => handler(draft, this.replayableRun(run, operation.id));
    try { objectIds = await (replay ? this.ctx.replaying(replayScope(operation.id, run.now), create) : create()); }
    catch (error) {
      const issues = validationIssues(error);
      if (issues) { await complete(); return fail(issues); }
      // Not the draft's fault (disk, lease, duplicate-ID block): the journal entry stays, so the next trigger replays it onto the same IDs.
      return { draft: document.relativePath, outcome: "skipped", objectIds: [], reason: `${prefix}: ${error instanceof Error ? error.message : String(error)}; will retry` };
    }
    // A replayed handler may skip re-creating what the first attempt already wrote (e.g. a merge suggestion
    // for a pair already proposed); anything written under this draft's IDs still belongs to it.
    if (replay) { await this.ctx.rebuildIndex(); objectIds = [...new Set([...objectIds, ...this.writtenBy(operation.id, run.now)])]; }
    await this.auditOnce(objectIds, { draftKey: draft.draftKey, contentHash: draft.contentHash, draftPath: document.relativePath, origin: draft.origin }, run, replay ? ledger : new Map());
    ledger.set(draft.draftKey, { contentHash: draft.contentHash, objectIds, agentRunIds: new Set([run.id]) });
    const result = await this.file("drafts", document, "processed", { draftKey, objectIds, outcome: "adopted" }, run);
    await complete();
    return result;
  }

  /** Every object the journalled operation wrote, in any attempt: its replay window (#59). Audits are not its objects. */
  private writtenBy(operationId: string, now: string) {
    const scope = replayScope(operationId, now);
    return this.ctx.index.all().filter((object) => object.frontmatter.type !== "audit-event" && scope(object.frontmatter.id)).map((object) => object.frontmatter.id);
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
    // U7: only the application generates Review Item operation IDs, so a draft can never pre-empt or replay one.
    if (fields.operation_id !== undefined) issues.push("operation_id: drafts must not carry an operation_id; LifeOS generates it at adoption");
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
  private async file(from: InboxFolder, document: InboxDocument, folder: "processed" | "failed", result: FilingResult, run: AdoptionRun): Promise<DraftResult> {
    const filed = await this.inbox!.move(from, document.name, folder);
    return this.writeResult(from, document, document.relativePath, filed, folder, result, run);
  }

  private async writeResult(from: InboxFolder, document: InboxDocument, draftPath: string, filed: InboxFile, folder: "processed" | "failed", result: FilingResult, run: AdoptionRun): Promise<DraftResult> {
    const outcome = result.outcome ?? "failed";
    const ids = result.objectIds.join(", ");
    const original = result.original;
    const pointer = original?.result ? ` The original result is ${original.result}.` : original?.agentRunId ? ` It was adopted by agent-run ${original.agentRunId}.` : "";
    const heading = outcome === "adopted" ? `# Adopted\n\nCreated ${ids}.\n` : outcome === "applied" ? `# Applied\n\nChanged ${ids}. The change can be undone in LifeOS.\n` : outcome === "review" ? `# Waiting for review\n\nThis change needs a second look, so LifeOS raised Review Item ${ids}. Nothing changes until it is accepted in LifeOS.\n` : outcome === "duplicate" ? from === "patches" ? `# Already received\n\nThis patch was handled before (${ids}); nothing was changed again.\n` : `# Already adopted\n\nThis draft was adopted before as ${ids}; nothing new was created.${pointer}\n` : `# Not ${from === "patches" ? "applied" : "adopted"}\n\n${result.errors!.map((error) => `- ${error}`).join("\n")}\n\nFix the draft and send it again; this file is kept and never deleted automatically.\n`;
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

  /**
   * Kind-specific fields shared by dictated objects and extracted proposals, validated into their stored form.
   * Envelope extras pass through; their values are validated by the envelope rules when the object is written.
   */
  private kindFields(draft: ParsedDraft) {
    const { fields } = draft;
    const issues: string[] = [];
    const out: Record<string, unknown> = { captured_at: draft.capturedAt };
    if (draft.kind === "task") {
      const status = text(fields.status) || "Inbox";
      const statuses = ["Inbox", "Next", "Waiting", "Done", "Cancelled"];
      if (!statuses.includes(status)) issues.push(`status: unknown status "${status}" (expected one of ${statuses.join(", ")})`);
      out.status = status;
      if (status === "Done") out.completed_at = draft.capturedAt;
      if (status === "Cancelled") out.cancelled_at = draft.capturedAt;
      if (fields.priority !== undefined) {
        const priority = text(fields.priority).toLowerCase();
        const match = ["High", "Medium", "Low"].find((candidate) => candidate.toLowerCase() === priority);
        if (match) out.priority = match; else issues.push(`priority: unknown priority "${text(fields.priority)}" (expected High, Medium or Low)`);
      }
      if (fields.due_on !== undefined && fields.due_at !== undefined) issues.push("due_on: use due_on or due_at, not both");
      else if (fields.due_on !== undefined) {
        const dueOn = text(fields.due_on);
        if (isCalendarDate(dueOn)) out.due_on = dueOn; else issues.push(`due_on: not a calendar date YYYY-MM-DD ("${dueOn}")`);
      } else if (fields.due_at !== undefined) {
        const dueAt = text(fields.due_at).includes("T") ? toUtc(fields.due_at) : undefined;
        if (dueAt) { out.due_at = dueAt; out.due_timezone = text(fields.due_timezone) || "UTC"; } else issues.push(`due_at: not an ISO 8601 date-time with Z or an offset ("${text(fields.due_at)}")`);
      }
      if (fields.expected_output !== undefined) {
        if (typeof fields.expected_output === "string") out.expected_output = fields.expected_output.trim(); else issues.push("expected_output: must be text");
      }
    }
    if (draft.kind === "decision") {
      // `decision_text` is kept only when given, so a proposal whose title is edited is decided under the edited title.
      if (fields.decision_text !== undefined) { if (text(fields.decision_text)) out.decision_text = text(fields.decision_text); else issues.push("decision_text: must be non-empty text"); }
      if (fields.decided_at === undefined) out.decided_at = draft.capturedAt;
      else { const decidedAt = toUtc(fields.decided_at); if (decidedAt) out.decided_at = decidedAt; else issues.push(`decided_at: not an ISO 8601 date-time with Z or an offset ("${text(fields.decided_at)}")`); }
    }
    if (draft.kind === "open-point") out.status = "open";
    for (const key of ["area", "sensitivity"]) if (fields[key] !== undefined) out[key] = fields[key];
    for (const key of ["subjects", "tags"]) if (fields[key] !== undefined) { if (isStringList(fields[key])) out[key] = fields[key]; else issues.push(`${key}: must be a list of text`); }
    if (Array.isArray(out.subjects)) out.subjects = this.resolver.normaliseSubjects(out.subjects as string[]);

    // References by name or ID (#33). Fields the kind cannot carry are refused, never dropped silently.
    const allowed = kindReferences[draft.kind] ?? [];
    for (const field of ["project", "client", "product", "people", "owner", "waiting_for", "meeting"] as ReferenceField[]) {
      if (fields[field] !== undefined && !allowed.includes(field)) issues.push(`${field}: not used on a ${draft.kind}`);
    }
    const references = this.resolver.resolveDraft(Object.fromEntries(allowed.map((field) => [field, fields[field]])));
    issues.push(...references.issues);
    if (draft.kind === "task" && fields.waiting_for !== undefined && out.status !== "Waiting") issues.push(`waiting_for: needs status Waiting (got ${String(out.status)})`);
    // Context not named explicitly is inherited from the referenced meeting.
    const meeting = typeof references.links.source_meeting_id === "string" ? this.ctx.index.get(references.links.source_meeting_id) : undefined;
    const inherited = inheritContextLinks(meeting);
    return { issues, fields: out, links: { ...inherited, ...references.links } as Record<string, unknown>, unresolved: references.unresolved };
  }

  /**
   * `user-dictated` task, decision or open point: created directly with the resolved links, owned by self unless
   * named (PRD story 2). Unresolved references never block it; each becomes a `link-resolution` Review Item.
   */
  private async adoptDictated(draft: ParsedDraft, run: AdoptionRun) {
    const { issues, fields, links, unresolved } = this.kindFields(draft);
    if (issues.length) throw new DraftError(issues);
    const folder = ({ task: "tasks", decision: "decisions", "open-point": "open-points" } as Record<string, string>)[draft.kind]!;
    const owner = draft.kind === "decision" ? {} : { owner_person_id: typeof links.owner_person_id === "string" ? links.owner_person_id : (await run.self()).frontmatter.id };
    // A new decision is always active (#41 lifecycle rule).
    const decision = draft.kind === "decision" ? { status: "active", decision_text: fields.decision_text ?? draft.title } : {};
    const id = run.newId("main");
    const narrative = draft.body.trim();
    const created = await this.ctx.objects.write({
      relativePath: `${folder}/${markdownFileName(draft.title, id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(id, draft.kind as "task" | "decision" | "open-point", draft.title, run.now, draft.origin), source_ids: [], ...links, ...owner, ...fields, ...decision },
      body: `# ${draft.title}\n${narrative ? `\n${narrative}\n` : ""}`
    });
    return [id, ...await this.resolver.raiseLinkReviews(created.frontmatter, unresolved, { now: run.now, origin: draft.origin, agentRunId: run.id, newId: (role) => run.newId(`main/${role}`) })];
  }

  /**
   * `agent-extracted` task, decision or open point: a pending create-type Review Item, never the object itself
   * (PRD story 3). Proposed fields keep the Agent's wording and language verbatim; nothing is translated.
   */
  private async proposeExtracted(draft: ParsedDraft, run: AdoptionRun, options: ProposeOptions = {}) {
    const { fields: raw } = draft;
    const { issues, fields, links, unresolved } = this.kindFields(draft);
    const confidence = ["High", "Medium", "Low"].find((candidate) => candidate.toLowerCase() === text(raw.confidence).toLowerCase());
    if (raw.confidence === undefined) issues.push("confidence: missing; an extracted draft must say how sure the Agent is (High, Medium or Low)");
    else if (!confidence) issues.push(`confidence: unknown confidence "${text(raw.confidence)}" (expected High, Medium or Low)`);
    const narrative = draft.body.trim();
    // Resolved references (#33): people links are proposed fields the user can change; context links and the
    // meeting sit on the Review Item itself, where acceptance already reads them.
    const reviewLinks = Object.fromEntries(Object.entries(links).filter(([key]) => [...contextLinkFields, "source_meeting_id"].includes(key)));
    const personLinks = Object.fromEntries(Object.entries(links).filter(([key]) => !(key in reviewLinks)));
    const proposed: Record<string, unknown> = { title: draft.title, ...fields, ...personLinks, ...(narrative ? { body: narrative } : {}) };
    const evidence = this.evidence(raw.evidence, proposed, issues);
    const evidenceIds = Object.values(evidence).flat().flatMap((entry) => entry.source_id ? [entry.source_id] : []);
    // #35: a knowledge note must keep at least one source, so its proposal needs one before it can be accepted.
    const named = draft.kind === "knowledge-note" ? this.namedSources(raw.sources, issues) : undefined;
    if (named && !named.ids.length && !named.urls.length && !evidenceIds.length) issues.push("sources: an extracted knowledge note needs at least one source (ID, title or URL)");
    if (issues.length) throw new DraftError(issues);
    if (options.dryRun) return [];

    const role = options.role ?? "main";
    const created = named ? await this.linkSources(named.urls, draft, run, fields, role) : [];
    const id = run.newId(role);
    const sourceIds = [...new Set([...named?.ids ?? [], ...created, ...evidenceIds])];
    await this.ctx.objects.write({
      relativePath: `review-items/${markdownFileName(draft.title, id, run.now)}`,
      frontmatter: {
        ...this.ctx.envelope(id, "review-item", draft.title, run.now, "agent-extracted"),
        ...(fields.sensitivity !== undefined ? { sensitivity: fields.sensitivity as ObjectEnvelope["sensitivity"] } : {}),
        review_type: "create", target_object_type: draft.kind, proposed_fields: proposed, field_evidence: evidence, confidence_label: confidence!,
        status: "pending", agent_run_id: run.id, draft_key: draft.draftKey, captured_at: draft.capturedAt, source_ids: sourceIds, ...reviewLinks,
        // Names that matched nothing or several objects stay visible here; the user picks the link while editing
        // the proposal, so no separate link-resolution item is raised for an object that does not exist yet.
        ...(unresolved.length ? { unresolved_references: unresolved } : {}),
        ...options.extra,
        // U7: generated here, at adoption, never taken from the draft.
        operation_id: run.newId(`${role}:operation`)
      },
      body: proposalBody(draft.title, narrative)
    });
    return [id, ...created];
  }

  /**
   * `evidence:` is a list of `{ field?, source, locator?, quote? }`; `field` defaults to `title` (the proposal as a whole).
   * `source` is an object ID, or the exact title or URL of a source, meeting or note. A reference that matches nothing,
   * or more than one object, is kept as `source_ref` only and shown as unresolved: it never blocks the proposal.
   */
  private evidence(value: unknown, proposed: Record<string, unknown>, issues: string[]) {
    const evidence: Record<string, Array<{ source_ref: string; source_id?: string; locator?: string; quote?: string }>> = {};
    if (value === undefined) return evidence;
    if (!Array.isArray(value)) { issues.push("evidence: must be a list of { field, source, locator, quote } entries"); return evidence; }
    // Fields an Agent may cite: everything proposed, plus the by-name references a draft can carry.
    const citable = new Set([...Object.keys(proposed), "project", "client", "product", "people", "owner", "waiting_for", "meeting"]);
    value.forEach((item: unknown, index) => {
      const at = `evidence[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) { issues.push(`${at}: must be a { field, source, locator, quote } entry`); return; }
      const entry = item as Record<string, unknown>;
      const field = entry.field === undefined ? "title" : text(entry.field);
      const source = text(entry.source);
      const before = issues.length;
      if (!citable.has(field)) issues.push(`${at}.field: "${field}" is not a proposed field (expected one of ${[...citable].join(", ")})`);
      if (!source) issues.push(`${at}.source: missing; name the source by ID, title or URL`);
      for (const key of ["locator", "quote"]) if (entry[key] !== undefined && typeof entry[key] !== "string" && typeof entry[key] !== "number") issues.push(`${at}.${key}: must be text`);
      if (issues.length > before) return;
      const sourceId = this.resolveSource(source);
      (evidence[field] ??= []).push({ source_ref: source, ...(sourceId ? { source_id: sourceId } : {}), ...(entry.locator !== undefined ? { locator: text(entry.locator) } : {}), ...(entry.quote !== undefined ? { quote: text(entry.quote) } : {}) });
    });
    return evidence;
  }

  /** An exact match only (ID, folded title, URL, or a source's external ID); none or several matches stay unresolved rather than guessed. */
  private resolveSource(reference: string) {
    const byId = this.ctx.index.get(reference);
    if (byId && !byId.frontmatter.deleted_at) return byId.frontmatter.id;
    const folded = foldForSearch(reference);
    const matches = this.ctx.index.all().filter((object) => !object.frontmatter.deleted_at && ["source", "meeting", "meeting-note", "knowledge-note"].includes(object.frontmatter.type)
      && (foldForSearch(object.frontmatter.title) === folded || object.frontmatter.url === reference || (!!webUrl(reference) && webUrl(object.frontmatter.url) === webUrl(reference))) || (object.frontmatter.type === "source" && object.frontmatter.external_id === reference));
    return matches.length === 1 ? matches[0]!.frontmatter.id : undefined;
  }

  /**
   * `source` (either origin, #35): pasted text (the body) and/or a web link (`url`), with an optional `occurred_at`.
   * A live Source with the same URL is reused rather than duplicated; it only gains what it did not have yet.
   */
  private async adoptSource(draft: ParsedDraft, run: AdoptionRun) {
    const { fields: raw } = draft;
    const { issues, fields } = this.kindFields(draft);
    const url = raw.url === undefined ? undefined : webUrl(raw.url);
    if (raw.url !== undefined && !url) issues.push(`url: not a web link starting with http:// or https:// ("${text(raw.url)}")`);
    const occurredAt = raw.occurred_at === undefined ? undefined : toUtc(raw.occurred_at);
    if (raw.occurred_at !== undefined && !occurredAt) issues.push(`occurred_at: not an ISO 8601 date-time with Z or an offset ("${text(raw.occurred_at)}")`);
    const pasted = draft.body.trim();
    if (raw.url === undefined && !pasted) issues.push("url: a source needs a url or pasted text in the body");
    if (issues.length) throw new DraftError(issues);
    await this.ctx.rebuildIndex(); // sees Sources written earlier in this batch
    const existing = url ? this.sourceByUrl(url) : undefined;
    if (!existing) return [await this.writeSource({ title: draft.title, url, pasted, occurredAt }, draft, run, fields, "main")];
    // Reuse: fill in only what is missing (text, occurred_at), through a guarded write; never overwrite what is stored.
    const fragments = existing.frontmatter.fragments;
    const hasText = Array.isArray(fragments) && fragments.some((fragment) => text((fragment as { text?: unknown }).text));
    const changes: Record<string, unknown> = {};
    if (pasted && !hasText) changes.fragments = [{ id: "fragment-1", text: pasted, locator: { kind: "full-text" } }];
    if (occurredAt && existing.frontmatter.occurred_at === undefined) changes.occurred_at = occurredAt;
    if (Object.keys(changes).length) await this.ctx.update(existing, changes, { expectedHash: existing.contentHash, now: run.now, ...(changes.fragments ? { body: `${existing.body.trimEnd()}\n\n${pasted}\n` } : {}) });
    return [existing.frontmatter.id];
  }

  /**
   * `user-dictated` knowledge note (#35): created directly and linked to its `sources:` (ID, exact title or URL).
   * URLs not stored yet become web-link Sources; an idea naming no source keeps its own text as a pasted-text Source.
   */
  private async adoptKnowledge(draft: ParsedDraft, run: AdoptionRun) {
    await this.ctx.rebuildIndex(); // sees Sources written earlier in this batch
    const { issues, fields } = this.kindFields(draft);
    const named = this.namedSources(draft.fields.sources, issues);
    const narrative = draft.body.trim();
    const fromBody = !named.ids.length && !named.urls.length;
    if (fromBody && !narrative && !issues.some((issue) => issue.startsWith("sources"))) issues.push("sources: name at least one source (ID, title or URL), or write the idea in the body");
    if (issues.length) throw new DraftError(issues);
    const created = await this.linkSources(named.urls, draft, run, fields, "main");
    if (fromBody) created.push(await this.writeSource({ title: draft.title, pasted: narrative }, draft, run, fields, "main/source:body"));
    const id = run.newId("main");
    await this.ctx.objects.write({
      relativePath: `knowledge/${markdownFileName(draft.title, id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(id, "knowledge-note", draft.title, run.now, draft.origin), ...fields, source_ids: [...new Set([...named.ids, ...created])], related_object_ids: [] },
      body: `# ${draft.title}\n${narrative ? `\n${narrative}\n` : ""}`
    });
    return [id, ...created];
  }

  /** `sources:` (one reference or a list) split into stored Source IDs and URLs still to create. Ambiguity is never guessed. */
  private namedSources(value: unknown, issues: string[]) {
    const ids: string[] = [];
    const urls: string[] = [];
    if (value === undefined) return { ids, urls };
    (Array.isArray(value) ? value : [value]).forEach((item: unknown, index) => {
      const at = Array.isArray(value) ? `sources[${index}]` : "sources";
      const reference = typeof item === "string" || typeof item === "number" ? text(item) : "";
      if (!reference) { issues.push(`${at}: must be a source ID, title or URL`); return; }
      if (looksLikeUrl(reference)) {
        const url = webUrl(reference);
        if (!url) { issues.push(`${at}: not a web link starting with http:// or https:// ("${reference}")`); return; }
        const existing = this.sourceByUrl(url);
        if (existing) ids.push(existing.frontmatter.id); else if (!urls.includes(url)) urls.push(url);
        return;
      }
      const live = (object: LifeOSObject) => object.frontmatter.type === "source" && !object.frontmatter.deleted_at;
      const byId = this.ctx.index.get(reference);
      const matches = byId ? [byId].filter(live) : this.ctx.index.all().filter((object) => live(object) && foldForSearch(object.frontmatter.title) === foldForSearch(reference));
      if (matches.length === 1) ids.push(matches[0]!.frontmatter.id);
      else if (byId) issues.push(`${at}: ${reference} is a ${byId.frontmatter.deleted_at ? "deleted " : ""}${byId.frontmatter.type}, not a live source`);
      else if (matches.length) issues.push(`${at}: "${reference}" matches ${matches.length} sources; use the source ID`);
      else issues.push(`${at}: no source matches "${reference}"; send a source draft first, or use its ID or URL`);
    });
    return { ids: [...new Set(ids)], urls };
  }

  /** Creates a web-link Source per new URL, titled by the URL until the user renames it; each URL is its own ID role. */
  private async linkSources(urls: string[], draft: ParsedDraft, run: AdoptionRun, fields: Record<string, unknown>, role: string) {
    const created: string[] = [];
    for (const url of urls) created.push(await this.writeSource({ title: url, url }, draft, run, fields, `${role}/source:url:${url}`));
    return created;
  }

  /** Writes one Source in the draft's origin. Area and sensitivity follow the draft, so a restricted idea's Source stays restricted. */
  private async writeSource(source: { title: string; url?: string; pasted?: string; occurredAt?: string }, draft: ParsedDraft, run: AdoptionRun, fields: Record<string, unknown>, role: string) {
    const id = run.newId(role);
    const carried = Object.fromEntries(["area", "sensitivity", ...(draft.kind === "source" ? ["subjects", "tags"] : [])].filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
    await this.ctx.objects.write({
      relativePath: `sources/${markdownFileName(source.title, id, run.now)}`,
      frontmatter: {
        ...this.ctx.envelope(id, "source", source.title, run.now, draft.origin), ...carried,
        source_type: source.url ? "web-link" : "pasted-text", ...(source.url ? { url: source.url } : {}),
        captured_at: draft.capturedAt, ...(source.occurredAt ? { occurred_at: source.occurredAt } : {}), ingestion_status: "captured",
        ...(source.pasted ? { fragments: [{ id: "fragment-1", text: source.pasted, locator: { kind: "full-text" } }] } : {})
      },
      body: `# ${source.title}\n${source.url ? `\n<${source.url}>\n` : ""}${source.pasted ? `\n${source.pasted}\n` : ""}`
    });
    return id;
  }

  /** The live Source stored under this URL (compared in canonical form), if any. */
  private sourceByUrl(url: string) {
    return this.ctx.index.all().find((object) => object.frontmatter.type === "source" && !object.frontmatter.deleted_at && webUrl(object.frontmatter.url) === url);
  }

  /**
   * `person` (either origin, #40): an `unreviewed` Person, plus `person-merge` Review Items for likely
   * duplicates. Never merged automatically. A draft whose email already belongs to a person adopts as that person.
   */
  private async adoptPerson(draft: ParsedDraft, run: AdoptionRun) {
    const { fields } = draft;
    const issues: string[] = [];
    const extra: Record<string, unknown> = {};
    const rawEmails = fields.emails === undefined ? [] : Array.isArray(fields.emails) ? fields.emails : [fields.emails];
    if (fields.email !== undefined) rawEmails.unshift(fields.email);
    const emails: string[] = [];
    for (const raw of rawEmails) {
      const email = normalizeEmail(raw);
      if (!email) issues.push(`${fields.email === raw ? "email" : "emails"}: not an email address ("${String(raw)}")`);
      else if (!emails.includes(email)) emails.push(email);
    }
    const [given, ...family] = draft.title.split(/\s+/);
    for (const key of ["given_name", "family_name", "organization_name", "job_title"]) {
      if (fields[key] === undefined) continue;
      if (typeof fields[key] === "string" && fields[key].trim()) extra[key] = fields[key].trim(); else issues.push(`${key}: must be text`);
    }
    extra.given_name ??= given;
    if (family.length && fields.family_name === undefined && fields.given_name === undefined) extra.family_name = family.join(" ");
    const domain = emails[0]?.split("@")[1];
    if (fields.is_external !== undefined) { if (typeof fields.is_external === "boolean") extra.is_external = fields.is_external; else issues.push("is_external: must be true or false"); }
    else if (domain) extra.is_external = isExternalDomain(internalDomainsOf(this.ctx.index), domain);
    if (domain && extra.organization_name === undefined) { const organization = organizationFromDomain(domain); if (organization) extra.organization_name = organization; }
    for (const key of ["area", "sensitivity"]) if (fields[key] !== undefined) extra[key] = fields[key];
    for (const key of ["subjects", "tags", "aliases"]) if (fields[key] !== undefined) { if (isStringList(fields[key])) extra[key] = fields[key]; else issues.push(`${key}: must be a list of text`); }
    if (issues.length) throw new DraftError(issues);

    // People by email first (PRD): a known address means this person already exists, unless it is the person
    // this draft's own interrupted first attempt wrote (#59): then the replay goes on to the merge suggestions.
    const id = run.newId("main");
    const known = this.ctx.index.all().find((object) => object.frontmatter.type === "person" && !object.frontmatter.deleted_at && personEmails(object).some((email) => emails.includes(email)));
    if (known && known.frontmatter.id !== id) return [known.frontmatter.id];
    const narrative = draft.body.trim();
    if (!known) await this.ctx.objects.write({
      relativePath: `people/${markdownFileName(draft.title, id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(id, "person", draft.title, run.now, draft.origin), ...extra, ...(emails.length ? { identifiers: emails.map((value) => ({ kind: "email", value })) } : {}), review_state: "unreviewed", captured_at: draft.capturedAt },
      body: `# ${draft.title}\n${narrative ? `\n${narrative}\n` : ""}`
    });
    this.personMerges ??= new PersonMergeModule(this.ctx);
    return [id, ...await this.personMerges.suggest({ now: run.now, personIds: [id], newId: (role) => run.newId(`main/${role}`) })];
  }
}
