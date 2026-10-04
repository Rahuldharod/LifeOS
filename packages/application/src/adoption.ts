import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { foldForSearch, markdownFileName, type AppContext } from "./context.js";
import { adoptDailyFocus } from "./focus.js";
import type { PatchModule } from "./patches.js";
import type { InboxDocument, InboxFile, InboxFolder, InboxStore } from "./ports.js";
import { internalDomainsOf, normalizeEmail, organizationFromDomain, personEmails } from "./people.js";
import { PersonMergeModule } from "./person-merge.js";
import { ReferenceResolver, type ReferenceField } from "./resolution.js";

/**
 * Adoption (ADR 0007): turns Agent-written Inbox Drafts in `_inbox/drafts/` into objects.
 *
 * One batch: read each draft → check the shared contract → check idempotency (draft_key + content
 * hash) → route by kind and origin to a handler that writes objects → file the draft in
 * `_inbox/processed/` or `_inbox/failed/` with a `.result.md` sidecar → one agent-run for the batch.
 * New draft kinds and origins plug in as entries in `routes`. Patch Drafts in `_inbox/patches/` are read by
 * `PatchModule` (patches.ts) in the same batch, after the drafts; requests will get their own reader.
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
}

/** Writes the objects for one draft and returns their IDs. Throw `DraftError` for anything the Agent must fix. */
export type DraftHandler = (draft: ParsedDraft, run: AdoptionRun) => Promise<string[]>;

/** A problem with the draft itself: the draft is filed in `_inbox/failed/`. Each issue reads "field: reason". */
export class DraftError extends Error {
  override name = "DraftError";
  constructor(readonly issues: string[]) { super(issues.join("; ")); }
}

export type DraftOutcome = "adopted" | "applied" | "duplicate" | "failed" | "skipped";
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
export interface FilingResult { draftKey: string; objectIds: string[]; errors?: string[]; outcome?: "adopted" | "applied" | "duplicate" }
/** Files one inbox document from its reader's folder into `processed/` or `failed/` with its sidecar. */
export type FileDocument = (document: InboxDocument, folder: "processed" | "failed", result: FilingResult) => Promise<DraftResult>;

export interface InboxStatus {
  awaiting: number;
  failed: Array<{ path: string; reason: string }>;
}

/** Drafts modified more recently than this may still be being written (or synced) and wait for the next trigger. */
export const partialFileGraceMs = 2000;
const adoptedAction = "draft.adopted";
const resultName = (name: string) => `${name.replace(/\.md$/, "")}.result.md`;
const isResult = (file: InboxFile) => file.name.endsWith(".result.md");
export const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const stringList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

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
export const isCalendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

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
const contextLinkFields = ["primary_client_id", "primary_product_id", "primary_project_id"];

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
    "person:user-dictated": (draft, run) => this.adoptPerson(draft, run),
    "person:agent-extracted": (draft, run) => this.adoptPerson(draft, run),
    // #46: the morning brief is written straight to a daily-focus object (ADR 0011), whatever the origin.
    "daily-focus:agent-extracted": (draft, run) => adoptDailyFocus(this.ctx, draft, run),
    "daily-focus:user-dictated": (draft, run) => adoptDailyFocus(this.ctx, draft, run)
  };
  private personMerges?: PersonMergeModule;
  /** Unparsable drafts by name → content hash: the first sighting may be a partial sync, so it is skipped once. */
  private readonly unparsableSeen = new Map<string, string>();
  /** Batches run one at a time, so startup, the watcher and "Adopt now" can never adopt one draft twice. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly resolver: ReferenceResolver;

  constructor(private readonly ctx: AppContext, private readonly inbox?: InboxStore, private readonly patches?: PatchModule) { this.resolver = new ReferenceResolver(ctx); }

  adoptDrafts(options: { now?: Date } = {}): Promise<AdoptionBatch> {
    const next = this.queue.then(() => this.runBatch(options.now ?? new Date()));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async inboxStatus(): Promise<InboxStatus> {
    if (!this.inbox) return { awaiting: 0, failed: [] };
    const [drafts, patches, failed] = await Promise.all([this.inbox.list("drafts"), this.inbox.list("patches"), this.inbox.list("failed")]);
    const names = new Set(failed.map((file) => file.name));
    const reasons = await Promise.all(failed.filter((file) => !isResult(file)).map(async (file) => {
      const sidecar = names.has(resultName(file.name)) ? await this.inbox!.read("failed", resultName(file.name)).catch(() => undefined) : undefined;
      const errors = sidecar?.frontmatter?.errors;
      return { path: file.relativePath, reason: Array.isArray(errors) && errors.length ? errors.map(String).join("; ") : `no readable ${resultName(file.name)} sidecar` };
    }));
    return { awaiting: drafts.length + patches.length, failed: reasons };
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
    const timestamp = now.toISOString();
    let self: Promise<LifeOSObject> | undefined;
    const run: AdoptionRun = { id: uuidV7(), now: timestamp, self: () => self ??= ctx.ensureSelfPerson(timestamp) };
    const ledger = this.ledger();
    const results: DraftResult[] = [];
    let retrySoon = false;

    // Drafts first, so a patch can target an object created by a draft in the same batch.
    for (const folder of ["drafts", "patches"] as const) {
      let read = (document: InboxDocument) => this.adoptOne(document, run, ledger);
      if (folder === "patches") {
        if (!this.patches) break;
        await ctx.rebuildIndex();
        read = this.patches.reader(run, (document, outcome, result) => this.file("patches", document, outcome, result, run));
      }
      for (const file of await inbox.list(folder)) {
        if (now.getTime() - file.modifiedAt < partialFileGraceMs) { retrySoon = true; results.push({ draft: file.relativePath, outcome: "skipped", objectIds: [], reason: `${file.relativePath}: modified less than 2 seconds ago; will retry` }); continue; }
        const document = await inbox.read(folder, file.name);
        if (document.error && this.unparsableSeen.get(file.relativePath) !== document.contentHash) {
          this.unparsableSeen.set(file.relativePath, document.contentHash);
          retrySoon = true;
          results.push({ draft: file.relativePath, outcome: "skipped", objectIds: [], reason: `${file.relativePath}: ${document.error}; will retry once in case it is still syncing` });
          continue;
        }
        this.unparsableSeen.delete(file.relativePath);
        results.push(await read(document));
      }
    }

    const filed = results.filter((result) => result.outcome !== "skipped");
    if (!filed.length) return { drafts: results, retrySoon };
    const created = [...new Set(filed.flatMap((result) => result.outcome === "adopted" || result.outcome === "applied" ? result.objectIds : []))];
    const count = (outcome: DraftOutcome) => filed.filter((result) => result.outcome === outcome).length;
    await ctx.objects.write({
      relativePath: `agent-runs/${markdownFileName("Inbox adoption", run.id, timestamp)}`,
      frontmatter: { ...ctx.envelope(run.id, "agent-run", "Inbox adoption", timestamp), operation: "inbox-adoption", provider: "lifeos", model: "rules", prompt_version: `draft-contract-${draftContractVersion}`, status: "succeeded", started_at: timestamp, completed_at: new Date().toISOString(), output_summary: `${count("adopted")} adopted, ${count("applied") ? `${count("applied")} applied, ` : ""}${count("duplicate")} duplicate, ${count("failed")} failed`, related_object_ids: created },
      body: "# Inbox adoption\n"
    });
    await ctx.rebuildIndex();
    return { agentRunId: run.id, drafts: results, retrySoon };
  }

  private async adoptOne(document: InboxDocument, run: AdoptionRun, ledger: Map<string, { contentHash: string; objectIds: string[] }>): Promise<DraftResult> {
    const fields = document.frontmatter ?? {};
    const draftKey = text(fields.draft_key);
    const prefix = `${document.relativePath}${draftKey ? ` (draft_key ${draftKey})` : ""}`;
    const fail = (issues: string[]) => this.file("drafts", document, "failed", { draftKey, objectIds: [], errors: [`${prefix}: ${issues.join("; ")}`] }, run);

    if (document.error) return fail([document.error]);
    const parsed = this.parse(document);
    if (!parsed.draft) return fail(parsed.issues);
    const draft = parsed.draft;

    const previous = ledger.get(draft.draftKey);
    if (previous && previous.contentHash === draft.contentHash) return this.file("drafts", document, "processed", { draftKey, objectIds: previous.objectIds, outcome: "duplicate" }, run);
    if (previous) return fail([`draft_key: draft_key ${draft.draftKey} was already adopted from different content (object ${previous.objectIds.join(", ")}); use a new draft_key, or a Patch Draft to change it`]);

    const handler = this.routes[`${draft.kind}:${draft.origin}`];
    if (!handler) return fail([`kind: ${draft.kind} drafts with origin ${draft.origin} are not supported yet`]);
    let objectIds: string[];
    try { objectIds = await handler(draft, run); }
    catch (error) {
      const issues = validationIssues(error);
      if (issues) return fail(issues);
      // Not the draft's fault (disk, lease, duplicate-ID block): leave it in drafts for the next trigger.
      return { draft: document.relativePath, outcome: "skipped", objectIds: [], reason: `${prefix}: ${error instanceof Error ? error.message : String(error)}; will retry` };
    }
    for (const id of objectIds) await this.ctx.writeAudit(adoptedAction, id, run.now, { draft_key: draft.draftKey, content_hash: draft.contentHash, draft_path: document.relativePath, agent_run_id: run.id, origin: draft.origin });
    ledger.set(draft.draftKey, { contentHash: draft.contentHash, objectIds });
    return this.file("drafts", document, "processed", { draftKey, objectIds, outcome: "adopted" }, run);
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
    const outcome = result.outcome ?? "failed";
    const filed = await this.inbox!.move(from, document.name, folder);
    const ids = result.objectIds.join(", ");
    const heading = outcome === "adopted" ? `# Adopted\n\nCreated ${ids}.\n` : outcome === "applied" ? `# Applied\n\nChanged ${ids}. The change can be undone in LifeOS.\n` : outcome === "duplicate" ? from === "patches" ? `# Already applied\n\nThis patch was applied before to ${ids}; nothing was changed again.\n` : `# Already adopted\n\nThis draft was adopted before as ${ids}; nothing new was created.\n` : `# Not ${from === "patches" ? "applied" : "adopted"}\n\n${result.errors!.map((error) => `- ${error}`).join("\n")}\n\nFix the draft and send it again; this file is kept and never deleted automatically.\n`;
    await this.inbox!.writeDocument(folder, resultName(filed.name), {
      lifeos_result: draftContractVersion, outcome, draft: document.relativePath, filed_as: filed.relativePath,
      ...(result.draftKey ? { draft_key: result.draftKey } : {}), content_hash: document.contentHash,
      object_ids: result.objectIds, errors: result.errors ?? [], processed_at: run.now, agent_run_id: run.id
    }, heading);
    return { draft: document.relativePath, outcome, objectIds: result.objectIds, filedAs: filed.relativePath, ...(result.errors ? { reason: result.errors.join("; ") } : {}) };
  }

  /** draft_key → what it produced, from `draft.adopted` audit events (authoritative, so it survives restarts and lost sidecars). */
  private ledger() {
    const ledger = new Map<string, { contentHash: string; objectIds: string[] }>();
    for (const object of this.ctx.index.all()) {
      const { frontmatter } = object;
      if (frontmatter.type !== "audit-event" || frontmatter.action !== adoptedAction) continue;
      const metadata = frontmatter.metadata as Record<string, unknown> | undefined;
      if (typeof metadata?.draft_key !== "string" || typeof metadata.content_hash !== "string" || typeof frontmatter.object_id !== "string") continue;
      const entry = ledger.get(metadata.draft_key) ?? { contentHash: metadata.content_hash, objectIds: [] };
      entry.objectIds.push(frontmatter.object_id);
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
    for (const key of ["subjects", "tags"]) if (fields[key] !== undefined) { if (stringList(fields[key])) out[key] = fields[key]; else issues.push(`${key}: must be a list of text`); }
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
    const inherited = Object.fromEntries(contextLinkFields.filter((key) => typeof meeting?.frontmatter[key] === "string").map((key) => [key, meeting!.frontmatter[key]]));
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
    const id = uuidV7();
    const narrative = draft.body.trim();
    const created = await this.ctx.objects.write({
      relativePath: `${folder}/${markdownFileName(draft.title, id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(id, draft.kind as "task" | "decision" | "open-point", draft.title, run.now, draft.origin), source_ids: [], ...links, ...owner, ...fields, ...decision },
      body: `# ${draft.title}\n${narrative ? `\n${narrative}\n` : ""}`
    });
    return [id, ...await this.resolver.raiseLinkReviews(created.frontmatter, unresolved, { now: run.now, origin: draft.origin, agentRunId: run.id })];
  }

  /**
   * `agent-extracted` task, decision or open point: a pending create-type Review Item, never the object itself
   * (PRD story 3). Proposed fields keep the Agent's wording and language verbatim; nothing is translated.
   */
  private async proposeExtracted(draft: ParsedDraft, run: AdoptionRun) {
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
    if (issues.length) throw new DraftError(issues);

    const id = uuidV7();
    const sourceIds = [...new Set(Object.values(evidence).flat().flatMap((entry) => entry.source_id ? [entry.source_id] : []))];
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
        // U7: generated here, at adoption, never taken from the draft.
        operation_id: uuidV7()
      },
      body: proposalBody(draft.title, narrative)
    });
    return [id];
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

  /** An exact match only (ID, folded title, or URL); none or several matches stay unresolved rather than guessed. */
  private resolveSource(reference: string) {
    const byId = this.ctx.index.get(reference);
    if (byId && !byId.frontmatter.deleted_at) return byId.frontmatter.id;
    const folded = foldForSearch(reference);
    const matches = this.ctx.index.all().filter((object) => !object.frontmatter.deleted_at && ["source", "meeting", "meeting-note", "knowledge-note"].includes(object.frontmatter.type)
      && (foldForSearch(object.frontmatter.title) === folded || object.frontmatter.url === reference));
    return matches.length === 1 ? matches[0]!.frontmatter.id : undefined;
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
    else if (domain) extra.is_external = !internalDomainsOf(this.ctx.index).includes(domain);
    if (domain && extra.organization_name === undefined) { const organization = organizationFromDomain(domain); if (organization) extra.organization_name = organization; }
    for (const key of ["area", "sensitivity"]) if (fields[key] !== undefined) extra[key] = fields[key];
    for (const key of ["subjects", "tags", "aliases"]) if (fields[key] !== undefined) { if (stringList(fields[key])) extra[key] = fields[key]; else issues.push(`${key}: must be a list of text`); }
    if (issues.length) throw new DraftError(issues);

    // People by email first (PRD): a known address means this person already exists.
    const known = this.ctx.index.all().find((object) => object.frontmatter.type === "person" && !object.frontmatter.deleted_at && personEmails(object).some((email) => emails.includes(email)));
    if (known) return [known.frontmatter.id];
    const id = uuidV7();
    const narrative = draft.body.trim();
    await this.ctx.objects.write({
      relativePath: `people/${markdownFileName(draft.title, id, run.now)}`,
      frontmatter: { ...this.ctx.envelope(id, "person", draft.title, run.now, draft.origin), ...extra, ...(emails.length ? { identifiers: emails.map((value) => ({ kind: "email", value })) } : {}), review_state: "unreviewed", captured_at: draft.capturedAt },
      body: `# ${draft.title}\n${narrative ? `\n${narrative}\n` : ""}`
    });
    this.personMerges ??= new PersonMergeModule(this.ctx);
    return [id, ...await this.personMerges.suggest({ now: run.now, personIds: [id] })];
  }
}
