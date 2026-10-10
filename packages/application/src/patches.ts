import { createHash } from "node:crypto";
import { envelopeWriteProblem, lifecycleWriteProblem, objectTypes, validateFrontmatter, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DraftError, draftOrigins, isCalendarDate, text, toUtc, validationIssues, type AdoptionRun, type DraftOrigin, type DraftResult, type FileDocument } from "./adoption.js";
import { foldForSearch, ObjectConflictError, type AppContext } from "./context.js";
import { decisionFields } from "./decisions.js";
import { operationKinds, type InboxDocument, type Operation } from "./ports.js";
import { ReferenceResolver, referenceFields, type ReferenceField } from "./resolution.js";
import { proposeReviewItem } from "./review-items.js";
import { isLive, replayRoles, sameValue, validTimeZone } from "./support.js";

/**
 * Patch Drafts (ADR 0007, PRD "Patch drafts"): an Agent asks for a change to an existing object by
 * dropping a file in `_inbox/patches/`. Adoption reads them in the same batch as drafts, after them.
 *
 * One patch: check the contract → idempotency (draft_key + content hash, from `patch.applied` audit
 * events) → resolve the target → decide whether it may apply on its own → journal the before/after (#61) →
 * one guarded write → a `patch.applied` audit event holding those values → filed with the `.result.md` sidecar.
 * A replay after a crash between the write and the audit finds the journal and audits instead of re-applying,
 * but only when the target really holds the journalled change (#71); otherwise the patch is planned again.
 * Startup recovery (`recoverJournal`) closes journals left open by a crash the same way.
 * `undoPatch` puts the before values back through another guarded write, audited as `patch.undone`.
 *
 * #37: anything that may not apply on its own (meaning-changing fields, decisions, agent-extracted
 * patches, or a field edited after the patch was captured) becomes an `update` Review Item instead,
 * audited as `patch.review-raised`. Accepting it (review.ts) applies the fields with the revision check.
 */

export const patchContractVersion = 1;
/** Task fields a user-dictated patch may change without review. `waiting_for` needs the task to end up Waiting. */
export const autoAppliedTaskFields = ["status", "due_on", "due_at", "due_timezone", "priority", "waiting_for"] as const;
const appliedAction = "patch.applied";
const undoneAction = "patch.undone";
const reviewRaisedAction = "patch.review-raised";
/** Fields a patch may never set: the envelope, and supersede links (`superseded_by` sets them within the lifecycle rules). */
const protectedFields = ["id", "type", "schema_version", "revision", "created_at", "updated_at", "updated_by_device", "origin", "deleted_at", "archived_at", "supersedes_decision_id", "superseded_by_decision_id"];
const statuses = ["Inbox", "Next", "Waiting", "Done", "Cancelled"];

/** A patch that passed the contract checks. `set` values are still raw: they are checked against the target. */
export interface ParsedPatch {
  file: InboxDocument;
  contentHash: string;
  draftKey: string;
  origin: DraftOrigin;
  /** `captured_at` normalised to UTC `Z`. */
  capturedAt: string;
  target: { id?: string; title?: string; type?: ObjectEnvelope["type"] };
  set: Record<string, unknown>;
  appendNote?: string;
}

/** One applied patch, for the Inbox panel's "Undo" list. Absent values read `null`. */
export interface AppliedPatch {
  auditEventId: string;
  objectId: string;
  title: string;
  type: string;
  draftKey: string;
  appliedAt: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  appendedNote?: string;
  undone: boolean;
}

/** One field of an `update` Review Item: its value when the item was raised and the value proposed. `null` = absent. */
export interface UpdateChange { field: string; current: unknown; proposed: unknown }
/** `proposed_fields` of an `update` Review Item raised from a patch. `base_*` is the target version the change was checked against. */
export interface UpdateProposal {
  changes: UpdateChange[];
  append_note?: string;
  reasons: string[];
  base_revision: number;
  base_hash: string;
  draft_key: string;
  captured_at: string;
}

// Audit values use `null` for "absent" (YAML cannot hold `undefined`); writes use `undefined`, which removes the field.
const stored = (value: unknown) => value === undefined ? null : value;
const written = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? undefined]));
/** What an auto-applied patch is about to write (#61), journalled before the write so a replay can finish it. */
interface PatchJournal { target_id: string; base_hash: string; before: Record<string, unknown>; after: Record<string, unknown>; appended_text?: string; base_note_count?: number }
/** The journal as stored: the planned change plus what its `patch.applied` audit needs, so startup recovery can write it (#71). */
type StoredPatchJournal = PatchJournal & { draft_key: string; content_hash: string; draft_path?: string; agent_run_id?: string; origin?: string; captured_at?: string; append_note?: string; now?: string };
/**
 * One journal entry per plan of a patch (draft_key + content + the target version it was planned on), so concurrent
 * attempts share one entry (#62) and a re-plan after a closed journal opens a fresh one (a closed ID is never reopened).
 */
const patchJournalId = (patch: ParsedPatch, baseHash: string) => `apply-patch-${createHash("sha256").update(`${patch.draftKey}\n${patch.contentHash}\n${baseHash}`).digest("hex").slice(0, 32)}`;
/**
 * #71: whether the target really holds a journalled change: a newer version whose fields equal the after-values and whose
 * body holds the appended text once more than the base did (#81: anywhere, so text the user added below the note since
 * does not hide it). Anything else means the write never happened (a crash between the journal and the write) or was
 * overwritten since, so no `patch.applied` may be recorded for it.
 */
const holdsChange = (target: LifeOSObject, journal: PatchJournal) => journal.target_id === target.frontmatter.id && journal.base_hash !== target.contentHash
  && Object.entries(record(journal.after)).every(([key, value]) => sameValue(target.frontmatter[key], value))
  && (!journal.appended_text || occurrences(target.body, journal.appended_text) > (journal.base_note_count ?? 0));
const occurrences = (body: string, part: string) => body.split(part).length - 1;
const metadataOf = (object: LifeOSObject) => (object.frontmatter.metadata ?? {}) as Record<string, unknown>;
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;

export class PatchModule {
  private readonly resolver: ReferenceResolver;
  constructor(private readonly ctx: AppContext) { this.resolver = new ReferenceResolver(ctx); }

  /** Returns the batch's reader for `_inbox/patches/`; `file` moves a patch to processed/failed with its sidecar. */
  reader(run: AdoptionRun, file: FileDocument) {
    const ledger = this.ledger();
    return async (document: InboxDocument): Promise<DraftResult> => {
      const draftKey = text(document.frontmatter?.draft_key);
      const prefix = `${document.relativePath}${draftKey ? ` (draft_key ${draftKey})` : ""}`;
      const fail = (issues: string[]) => file(document, "failed", { draftKey, objectIds: [], errors: [`${prefix}: ${issues.join("; ")}`] });

      if (document.error) return fail([document.error]);
      const parsed = this.parse(document);
      if (!parsed.patch) return fail(parsed.issues);
      const patch = parsed.patch;

      const previous = ledger.get(patch.draftKey);
      if (previous && previous.contentHash === patch.contentHash) {
        await this.closeJournals(patch);
        return file(document, "processed", { draftKey, objectIds: [previous.objectId], outcome: "duplicate" });
      }
      if (previous) return fail([`draft_key: draft_key ${patch.draftKey} was already applied from different content (object ${previous.objectId}); use a new draft_key`]);

      let objectId: string, outcome: "applied" | "review";
      try { ({ objectId, outcome } = await this.apply(patch, run)); }
      catch (error) {
        const issues = validationIssues(error);
        if (issues) return fail(issues);
        // Not the patch's fault (disk, lease, target changed mid-write): leave it in patches for the next trigger.
        return { draft: document.relativePath, outcome: "skipped", objectIds: [], reason: `${prefix}: ${error instanceof Error ? error.message : String(error)}; will retry` };
      }
      ledger.set(patch.draftKey, { contentHash: patch.contentHash, objectId });
      // The next patch in the batch may target the same object: it needs the new content hash.
      await this.ctx.rebuildIndex();
      return file(document, "processed", { draftKey, objectIds: [objectId], outcome });
    };
  }

  /** Applied patches, newest first, with whether each was undone. */
  appliedPatches(): AppliedPatch[] {
    const events = this.ctx.index.all().filter((object) => object.frontmatter.type === "audit-event");
    const undone = new Set(events.filter((event) => event.frontmatter.action === undoneAction).map((event) => metadataOf(event).patch_audit_id));
    return events.filter((event) => event.frontmatter.action === appliedAction).map((event) => {
      const metadata = metadataOf(event);
      const objectId = String(event.frontmatter.object_id);
      const target = this.ctx.index.get(objectId);
      return {
        auditEventId: event.frontmatter.id, objectId, title: target?.frontmatter.title ?? objectId, type: target?.frontmatter.type ?? "unknown",
        draftKey: String(metadata.draft_key ?? ""), appliedAt: String(event.frontmatter.occurred_at ?? event.frontmatter.created_at),
        before: record(metadata.before), after: record(metadata.after),
        ...(typeof metadata.append_note === "string" ? { appendedNote: metadata.append_note } : {}),
        undone: undone.has(event.frontmatter.id)
      };
    }).sort((left, right) => right.appliedAt.localeCompare(left.appliedAt) || right.auditEventId.localeCompare(left.auditEventId));
  }

  /**
   * Restores the before values of an applied patch through a guarded write. Refuses (409) when a patched
   * field or the appended note changed since, so undo never overwrites a newer edit. Undoing twice is a no-op.
   */
  async undoPatch(auditEventId: string, now = new Date()) {
    const { ctx } = this;
    const event = ctx.index.get(auditEventId);
    if (!event || event.frontmatter.type !== "audit-event" || event.frontmatter.action !== appliedAction) throw new Error(`Not an applied patch: ${auditEventId}`);
    const metadata = metadataOf(event);
    const target = ctx.required(String(event.frontmatter.object_id));
    const alreadyUndone = ctx.findAudits(undoneAction, { patch_audit_id: auditEventId }).length > 0;
    if (alreadyUndone) return target;

    const before = record(metadata.before);
    const after = record(metadata.after);
    const appended = typeof metadata.appended_text === "string" ? metadata.appended_text : undefined;
    const changed = Object.keys(after).filter((key) => !sameValue(target.frontmatter[key], after[key]));
    if (appended && !target.body.endsWith(appended)) changed.push("the appended note");
    if (changed.length) throw new ObjectConflictError(`Cannot undo: ${changed.join(", ")} changed since the patch was applied; undo would overwrite the newer edit, so change it by hand instead`);

    const timestamp = now.toISOString();
    const updated = await ctx.update(target, written(before), { expectedHash: target.contentHash, now: timestamp, ...(appended ? { body: target.body.slice(0, -appended.length) } : {}) });
    await ctx.writeAudit(undoneAction, target.frontmatter.id, timestamp, { patch_audit_id: auditEventId, draft_key: metadata.draft_key, before: after, after: before, ...(appended ? { removed_text: appended } : {}) });
    await ctx.rebuildIndex();
    return updated;
  }

  /** The patch contract v1 checks; returns every issue at once so the Agent can fix them in one go. */
  private parse(document: InboxDocument): { patch?: ParsedPatch; issues: string[] } {
    const fields = document.frontmatter ?? {};
    const version = fields.lifeos_patch;
    if (version === undefined) return { issues: ["lifeos_patch: missing; a patch must start with lifeos_patch: 1"] };
    if (version !== patchContractVersion) return { issues: [`lifeos_patch: unsupported contract version ${String(version)} (this LifeOS reads version ${patchContractVersion})`] };
    const issues: string[] = [];
    const draftKey = text(fields.draft_key);
    if (!draftKey) issues.push("draft_key: missing; choose any unique string so re-sends are recognised");
    const origin = text(fields.origin);
    if (!(draftOrigins as readonly string[]).includes(origin)) issues.push(origin ? `origin: unknown origin "${origin}" (expected ${draftOrigins.join(" or ")})` : "origin: missing");
    const capturedAt = toUtc(fields.captured_at);
    if (fields.captured_at === undefined) issues.push("captured_at: missing");
    else if (!capturedAt) issues.push(`captured_at: not an ISO 8601 date-time with Z or an offset ("${String(fields.captured_at)}")`);
    const id = text(fields.id) || undefined;
    const title = text(fields.title) || undefined;
    const type = text(fields.type) || undefined;
    if (type && !(objectTypes as readonly string[]).includes(type)) issues.push(`type: unknown type "${type}"`);
    if (!id && !(title && type)) issues.push("id: missing; give the target's id, or its exact title and type");
    if (fields.set !== undefined && (!fields.set || typeof fields.set !== "object" || Array.isArray(fields.set))) issues.push("set: must be a set of field: value pairs");
    const set = record(fields.set);
    if (fields.append_note !== undefined && (typeof fields.append_note !== "string" || !fields.append_note.trim())) issues.push("append_note: must be non-empty text");
    const appendNote = typeof fields.append_note === "string" && fields.append_note.trim() ? fields.append_note.trim() : undefined;
    if (!Object.keys(set).length && !appendNote && !issues.some((issue) => issue.startsWith("set:") || issue.startsWith("append_note:"))) issues.push("set: nothing to change; give set and/or append_note");
    if (issues.length) return { issues };
    return { issues, patch: { file: document, contentHash: document.contentHash, draftKey, origin: origin as DraftOrigin, capturedAt: capturedAt!, target: { id, title, type: type as ObjectEnvelope["type"] | undefined }, set, ...(appendNote ? { appendNote } : {}) } };
  }

  /** Applies one patch with a guarded write and audits it, or raises an `update` Review Item; returns the ID to report. */
  private async apply(patch: ParsedPatch, run: AdoptionRun): Promise<{ objectId: string; outcome: "applied" | "review" }> {
    const target = this.target(patch);
    // #61: an earlier attempt journalled this exact change and then wrote it, but crashed before its audit:
    // audit the journalled values instead of applying again (no second note, and Undo gets the true before).
    // #71: only when the target really holds that change; otherwise the write never happened, so plan again.
    const journals = await this.openJournals(patch);
    const finished = journals.find((journal) => holdsChange(target, journal.payload));
    if (finished) return this.audit(patch, target, finished.payload, run);
    await this.closeJournals(patch);
    const reasons = this.reviewReasons(patch, target);
    const changes = this.changes(patch, target);
    const keys = Object.keys(changes).filter((key) => !sameValue(target.frontmatter[key], changes[key]));
    const before = Object.fromEntries(keys.map((key) => [key, stored(target.frontmatter[key])]));
    const after = Object.fromEntries(keys.map((key) => [key, stored(changes[key])]));
    // Conflict rule (PRD): the target was edited after the patch was captured, on a field the patch changes.
    const conflicts = await this.changedSince(target, patch.capturedAt, keys);
    if (conflicts.length) reasons.push(`conflict: ${conflicts.join(", ")} changed after this patch was captured (${patch.capturedAt}); review it so the newer edit is not overwritten`);
    if (reasons.length && (keys.length || patch.appendNote)) return { objectId: await this.raiseReview(patch, target, before, after, reasons, run), outcome: "review" };

    // The exact text appended, so undo can remove precisely that and nothing the user wrote after it.
    const appended = patch.appendNote ? appendedText(target.body, patch.appendNote) : undefined;
    const planned: PatchJournal = { target_id: target.frontmatter.id, base_hash: target.contentHash, before, after, ...(appended ? { appended_text: appended, base_note_count: occurrences(target.body, appended) } : {}) };
    // A patch that changes nothing ("mark it done" when it already is) writes no revision, but is still audited so a re-send is recognised.
    if (keys.length || appended) {
      // Journal the true before/after first, so a crash between the write and its audit is finished, not re-applied.
      const journalId = patchJournalId(patch, target.contentHash);
      const journal: StoredPatchJournal = { ...planned, ...this.auditFields(patch, run), now: run.now, ...(appended ? { append_note: patch.appendNote } : {}) };
      await this.ctx.objects.prepareOperation?.(operationKinds.applyPatch, { ...journal }, journalId);
      try { await this.ctx.update(target, written(after), { expectedHash: target.contentHash, now: run.now, ...(appended ? { body: target.body + appended } : {}) }); }
      catch (error) {
        // Not written (a guarded write is all or nothing): drop the journal so a retry starts from the target as it then is.
        await this.ctx.objects.completeOperation?.(journalId);
        throw error;
      }
    }
    return this.audit(patch, target, planned, run);
  }

  /** The `patch.applied` audit (the patch's idempotency ledger and Undo record), then closes the patch's journal. */
  private async audit(patch: ParsedPatch, target: LifeOSObject, values: PatchJournal, run: AdoptionRun) {
    await this.ctx.writeAuditOnce(appliedAction, target.frontmatter.id, run.now, {
      ...this.auditFields(patch, run), before: values.before, after: values.after, ...(values.appended_text ? { append_note: patch.appendNote, appended_text: values.appended_text } : {})
    }, { matchOn: ["draft_key", "content_hash"] });
    await this.closeJournals(patch);
    return { objectId: target.frontmatter.id, outcome: "applied" as const };
  }

  private auditFields(patch: ParsedPatch, run: AdoptionRun) {
    return { draft_key: patch.draftKey, content_hash: patch.contentHash, draft_path: patch.file.relativePath, agent_run_id: run.id, origin: patch.origin, captured_at: patch.capturedAt };
  }

  /** The patch's journal entries a crash left open (normally none, at most one per target version it was planned on). */
  private async openJournals(patch: { draftKey: string; contentHash: string }) {
    const operations = await this.ctx.objects.incompleteOperations?.() ?? [];
    return operations.filter((operation) => operation.kind === operationKinds.applyPatch && operation.payload.draft_key === patch.draftKey && operation.payload.content_hash === patch.contentHash)
      .map((operation) => ({ id: operation.id, payload: operation.payload as unknown as StoredPatchJournal }));
  }

  private async closeJournals(patch: { draftKey: string; contentHash: string }) {
    for (const journal of await this.openJournals(patch)) await this.ctx.objects.completeOperation?.(journal.id);
  }

  /**
   * Startup recovery of an `apply-patch` journal (#71). Already audited (or raised for review): closed. Target holds the
   * change: its `patch.applied` audit is written from the journal, then closed. Target does not hold it: the write never
   * happened, so it is closed and the patch, if still waiting, is planned again by adoption. Target missing: throws, so
   * the entry stays open and is listed in System Health.
   */
  async recoverJournal(operation: Operation) {
    const journal = operation.payload as unknown as StoredPatchJournal;
    const { ctx } = this;
    // The patch's ledger: already audited, or raised for review (#61), so the target need not be checked.
    if (!ctx.findAudits([appliedAction, reviewRaisedAction], { draft_key: journal.draft_key, content_hash: journal.content_hash }).length) {
      const target = ctx.index.get(String(journal.target_id));
      if (!target || ctx.index.duplicatePaths?.(target.frontmatter.id)) throw new Error(`the patch's target ${String(journal.target_id)} is ${target ? "a duplicate object ID" : "missing"}, so whether patch ${journal.draft_key} was applied cannot be checked; restore the target or close the entry by hand`);
      if (holdsChange(target, journal)) {
        const { target_id: _target, base_hash: _base, base_note_count: _count, before, after, appended_text, now, append_note, ...fields } = journal;
        await ctx.writeAuditOnce(appliedAction, target.frontmatter.id, now ?? new Date().toISOString(), { ...fields, before, after, ...(appended_text ? { append_note, appended_text } : {}) }, { matchOn: ["draft_key", "content_hash"] });
        await ctx.rebuildIndex();
      }
    }
    await ctx.objects.completeOperation?.(operation.id);
  }

  /**
   * Which of `keys` were changed after `capturedAt`, from two sources:
   * - the target's audit events since then. Another patch's change counts from when it was captured, so dictation
   *   order wins over adoption order. An edit whose fields are unknown (unaudited write) counts as touching every field.
   * - #81: the target's content against its base, the version the app saved as of `capturedAt` (ADR 0012). A field whose
   *   value differs from the base, other than by a patch dictated before this one, was changed since, even when no audit
   *   says so (an Obsidian edit not yet detected, made before or after another audited edit). Never overwrite blind.
   * With no base kept (created after the capture, or pruned), only the audit events decide.
   */
  private async changedSince(target: LifeOSObject, capturedAt: string, keys: string[]) {
    if (!keys.length) return [];
    const since = Date.parse(capturedAt);
    const events = this.ctx.index.all().filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.object_id === target.frontmatter.id && Date.parse(String(object.frontmatter.occurred_at)) > since);
    const changed = new Set<string>();
    // Values set since the capture by patches dictated before it: not a conflict (dictation order).
    const earlier: Array<Record<string, unknown>> = [];
    if (Date.parse(String(target.frontmatter.updated_at)) > since) {
      if (!events.length) return keys;
      for (const event of events) {
        const metadata = metadataOf(event);
        if (event.frontmatter.action === appliedAction && typeof metadata.captured_at === "string" && !(Date.parse(metadata.captured_at) > since)) { earlier.push(record(metadata.after)); continue; }
        const fields = touchedFields(String(event.frontmatter.action), metadata);
        if (!fields) return keys;
        fields.forEach((field) => changed.add(field));
      }
    }
    const base = await this.ctx.objects.versionAt?.(target.frontmatter.id, capturedAt);
    if (base && base.contentHash !== target.contentHash) {
      for (const key of keys) {
        const current = target.frontmatter[key];
        if (!sameValue(current, base.frontmatter[key]) && !earlier.some((after) => Object.hasOwn(after, key) && sameValue(current, after[key]))) changed.add(key);
      }
    }
    return keys.filter((key) => changed.has(key));
  }

  /** Writes the `update` Review Item (current vs proposed per field) and the audit event that makes re-sends idempotent. */
  private async raiseReview(patch: ParsedPatch, target: LifeOSObject, before: Record<string, unknown>, after: Record<string, unknown>, reasons: string[], run: AdoptionRun) {
    const changes: UpdateChange[] = Object.keys(after).map((field) => ({ field, current: before[field], proposed: after[field] }));
    const title = `Change ${[...changes.map((change) => change.field), ...(patch.appendNote ? ["note"] : [])].join(", ")} on ${target.frontmatter.title}`;
    const proposal: UpdateProposal = { changes, ...(patch.appendNote ? { append_note: patch.appendNote } : {}), reasons, base_revision: target.frontmatter.revision, base_hash: target.contentHash, draft_key: patch.draftKey, captured_at: patch.capturedAt };
    const cell = (value: unknown) => value === null ? "(none)" : (typeof value === "string" ? value : JSON.stringify(value)).replace(/\|/g, "\\|").replace(/\n/g, " ");
    const table = changes.length ? `\n\n| Field | Current | Proposed |\n| --- | --- | --- |\n${changes.map((change) => `| ${change.field} | ${cell(change.current)} | ${cell(change.proposed)} |`).join("\n")}` : "";
    const note = patch.appendNote ? `\n\nNote to append:\n\n${patch.appendNote.split("\n").map((line) => `> ${line}`).join("\n")}` : "";
    const { frontmatter: { id } } = await proposeReviewItem(this.ctx, run, {
      role: replayRoles.review, reviewType: "update", title, target: { type: target.frontmatter.type, id: target.frontmatter.id }, proposed: { ...proposal },
      confidence: patch.origin === "agent-extracted" ? "Medium" : "High", origin: patch.origin,
      body: `# ${title}\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}${table}${note}\n`
    });
    await this.ctx.writeAuditOnce(reviewRaisedAction, id, run.now, { draft_key: patch.draftKey, content_hash: patch.contentHash, draft_path: patch.file.relativePath, agent_run_id: run.id, origin: patch.origin, captured_at: patch.capturedAt, target_object_id: target.frontmatter.id, reasons }, { matchOn: ["draft_key", "content_hash"] });
    return id;
  }

  /** `id` wins; otherwise one live object of `type` whose title matches ignoring case and accents. */
  private target(patch: ParsedPatch) {
    const { index } = this.ctx;
    const { id, title, type } = patch.target;
    let target: LifeOSObject | undefined;
    if (id) {
      target = index.get(id);
      if (!target) throw new DraftError([`id: no object with ID ${id}`]);
      if (type && target.frontmatter.type !== type) throw new DraftError([`type: object ${id} is a ${target.frontmatter.type}, not a ${type}`]);
    } else {
      const wanted = foldForSearch(title!);
      const matches = index.all().filter((object) => object.frontmatter.type === type && isLive(object) && foldForSearch(object.frontmatter.title.trim()) === wanted);
      if (!matches.length) throw new DraftError([`title: no ${type} titled "${title}"`]);
      if (matches.length > 1) throw new DraftError([`title: ${matches.length} ${type}s are titled "${title}" (${matches.map((match) => match.frontmatter.id).join(", ")}); give the id instead`]);
      target = matches[0]!;
    }
    const paths = index.duplicatePaths?.(target.frontmatter.id);
    if (paths) throw new DraftError([`id: ${target.frontmatter.id} is a duplicate object ID (${paths.join(" and ")}); resolve the duplicate before patching it`]);
    // Not isLive on purpose: a patch names its target by ID, and an explicit ID reaches an archived object (#118).
    if (target.frontmatter.deleted_at) throw new DraftError([`id: object ${target.frontmatter.id} is deleted`]);
    return target;
  }

  /** Why this patch may not apply on its own (PRD: only low-risk dictated changes auto-apply). Empty means apply. */
  private reviewReasons(patch: ParsedPatch, target: LifeOSObject) {
    if (patch.origin === "agent-extracted") return ["origin: agent-extracted patches always need review"];
    const keys = Object.keys(patch.set);
    if (keys.length && target.frontmatter.type === "decision") return ["set: any change to a decision needs review"];
    if (keys.length && target.frontmatter.type !== "task") return [`set: changes to a ${target.frontmatter.type} need review; only task status, due date, priority and waiting_for, and appended notes, apply automatically`];
    return keys.filter((key) => !(autoAppliedTaskFields as readonly string[]).includes(key)).map((key) => `set.${key}: changes to ${key} need review`);
  }

  /**
   * Turns `set` into stored field changes and checks them against the target, whatever the route: task
   * rules, references by name (#33 resolver), decision fields and lifecycle (#41), and the schema. Throws
   * `DraftError` with every issue, so a bad patch is filed as failed rather than raised for review.
   */
  private changes(patch: ParsedPatch, target: LifeOSObject) {
    const current = target.frontmatter;
    const isTask = current.type === "task";
    const isDecision = current.type === "decision";
    const issues: string[] = [];
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch.set)) {
      if (isTask && (autoAppliedTaskFields as readonly string[]).includes(key)) continue;
      if (protectedFields.includes(key)) { issues.push(`set.${key}: cannot be changed by a patch${key.endsWith("decision_id") ? "; use superseded_by" : ""}`); continue; }
      const field = Object.hasOwn(referenceFields, key) ? referenceFields[key as ReferenceField].linkField : key;
      if (isDecision && key !== "superseded_by" && !["status", ...decisionFields].includes(field)) { issues.push(`set.${key}: not a decision field (expected status, superseded_by, ${decisionFields.join(", ")})`); continue; }
      if (key === "superseded_by") {
        if (!isDecision) { issues.push("set.superseded_by: only a decision can be superseded"); continue; }
        const successor = this.link("superseded_by", "decision", value);
        if (typeof successor !== "string") issues.push(successor.issue);
        else if (successor === current.id) issues.push("superseded_by: a decision cannot supersede itself");
        else Object.assign(changes, { status: "superseded", superseded_by_decision_id: successor });
        continue;
      }
      if (Object.hasOwn(referenceFields, key)) {
        const spec = referenceFields[key as ReferenceField];
        if (value === null) { changes[field] = undefined; continue; }
        const found = (spec.list && Array.isArray(value) ? value : [value]).map((reference) => this.link(key, spec.type, reference));
        const failed = found.flatMap((result) => typeof result === "string" ? [] : [result.issue]);
        if (failed.length) issues.push(...failed);
        else changes[field] = spec.list ? [...new Set(found as string[])] : found[0];
        continue;
      }
      changes[key] = value ?? undefined;
    }
    if (isTask) { const task = this.taskChanges(patch, target); issues.push(...task.issues); Object.assign(changes, task.changes); }
    // #42: resolving or closing an open point is stamped with when the user said it, as the lifecycle rules require.
    if (current.type === "open-point" && changes.status !== current.status) {
      if (changes.status === "resolved") changes.resolved_at ??= patch.capturedAt;
      if (changes.status === "closed") changes.closed_at ??= patch.capturedAt;
    }
    if (isDecision && changes.status === "superseded" && current.status !== "superseded" && !changes.superseded_by_decision_id) issues.push("set.status: to supersede a decision, give superseded_by: the decision that replaces it");
    if (issues.length) throw new DraftError(issues);
    // The result must still be a valid object and a legal lifecycle move (the guarded write checks this again on accept).
    const next = { ...current, ...changes };
    try { validateFrontmatter(next); } catch (error) { issues.push(...(validationIssues(error) ?? [String(error)]).map((issue) => `set.${issue}`)); }
    const problem = envelopeWriteProblem(next, current) ?? lifecycleWriteProblem(next, current);
    if (problem) issues.push(`set: ${problem}`);
    if (issues.length) throw new DraftError(issues);
    return changes;
  }

  /** One reference by ID, name, alias or email through the shared resolver (#33); the issue text when there is not exactly one. */
  private link(field: string, type: ObjectEnvelope["type"], reference: unknown): string | { issue: string } {
    if (typeof reference !== "string" && typeof reference !== "number") return { issue: `${field}: must be a name or ID` };
    const wanted = String(reference).trim();
    const result = this.resolver.resolve(type, wanted);
    if (result.status === "resolved") return result.id;
    if (result.status === "unknown") return { issue: `${field}: no ${type} called "${wanted}"` };
    return { issue: `${field}: ${result.candidates.length} ${type === "person" ? "people" : `${type}s`} are called "${wanted}" (${result.candidates.map((candidate) => candidate.id).join(", ")}); give the id instead` };
  }

  /** Validates the auto-applied task fields and derives the dependent ones (completion stamps, due pairs, waiting_for). */
  private taskChanges(patch: ParsedPatch, task: LifeOSObject) {
    const { set } = patch;
    const current = task.frontmatter;
    const issues: string[] = [];
    const changes: Record<string, unknown> = {};
    const has = (key: string) => Object.hasOwn(set, key);
    if (has("status")) {
      const status = statuses.find((candidate) => candidate.toLowerCase() === text(set.status).toLowerCase());
      if (!status) issues.push(`status: unknown status "${text(set.status)}" (expected one of ${statuses.join(", ")})`);
      else if (status !== current.status) {
        changes.status = status;
        changes.completed_at = status === "Done" ? patch.capturedAt : undefined;
        changes.cancelled_at = status === "Cancelled" ? patch.capturedAt : undefined;
      }
    }
    if (has("priority")) {
      const match = set.priority === null ? null : ["High", "Medium", "Low"].find((candidate) => candidate.toLowerCase() === text(set.priority).toLowerCase());
      if (match === undefined) issues.push(`priority: unknown priority "${text(set.priority)}" (expected High, Medium, Low, or null to clear)`); else changes.priority = match ?? undefined;
    }
    if (has("due_on") && has("due_at") && set.due_on !== null && set.due_at !== null) issues.push("due_on: use due_on or due_at, not both");
    else {
      if (has("due_on")) {
        const dueOn = text(set.due_on);
        if (set.due_on === null) changes.due_on = undefined;
        else if (isCalendarDate(dueOn)) Object.assign(changes, { due_on: dueOn, due_at: undefined, due_timezone: undefined });
        else issues.push(`due_on: not a calendar date YYYY-MM-DD ("${dueOn}")`);
      }
      if (has("due_at")) {
        const dueAt = text(set.due_at).includes("T") ? toUtc(set.due_at) : undefined;
        if (set.due_at === null) Object.assign(changes, { due_at: undefined, due_timezone: undefined });
        else if (dueAt) Object.assign(changes, { due_at: dueAt, due_on: undefined, due_timezone: current.due_timezone ?? "UTC" });
        else issues.push(`due_at: not an ISO 8601 date-time with Z or an offset ("${text(set.due_at)}")`);
      }
      if (has("due_timezone")) {
        const zone = text(set.due_timezone);
        if (!validTimeZone(zone) || !zone) issues.push(`due_timezone: unknown time zone "${zone}" (use an IANA name such as Europe/Paris)`);
        else if (!(has("due_at") ? set.due_at !== null : current.due_at)) issues.push("due_timezone: only together with a due_at");
        else changes.due_timezone = zone;
      }
    }
    const status = (changes.status ?? current.status) as string;
    if (has("waiting_for")) {
      if (set.waiting_for === null) changes.waiting_for_person_id = undefined;
      else if (status !== "Waiting") issues.push(`waiting_for: only with status Waiting (the task would be ${status}); add status: Waiting to the patch`);
      else {
        const person = this.link("waiting_for", "person", set.waiting_for);
        if (typeof person === "string") changes.waiting_for_person_id = person; else issues.push(person.issue);
      }
    } else if (status !== "Waiting" && current.waiting_for_person_id) changes.waiting_for_person_id = undefined;
    return { changes, issues };
  }

  /** draft_key → the patch it applied or raised for review, from `patch.applied` / `patch.review-raised` audit events (authoritative, so it survives restarts and lost sidecars). */
  private ledger() {
    const ledger = new Map<string, { contentHash: string; objectId: string }>();
    for (const object of this.ctx.index.all()) {
      if (object.frontmatter.type !== "audit-event" || (object.frontmatter.action !== appliedAction && object.frontmatter.action !== reviewRaisedAction)) continue;
      const metadata = metadataOf(object);
      if (typeof metadata.draft_key === "string" && typeof metadata.content_hash === "string") ledger.set(metadata.draft_key, { contentHash: metadata.content_hash, objectId: String(object.frontmatter.object_id) });
    }
    return ledger;
  }
}

/** The text `append_note` adds to a body: a blank line, the note, a newline. Shared with accepting an `update` Review Item. */
export const appendedText = (body: string, note: string) => `${body.endsWith("\n") || !body ? "" : "\n"}\n${note}\n`;

/** The fields an audit event says it changed on its object: `[]` for creations, `undefined` when unknown. */
function touchedFields(action: string, metadata: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(metadata.fields)) return metadata.fields.map(String);
  if (metadata.changes && typeof metadata.changes === "object") return Object.keys(metadata.changes);
  if (metadata.after && typeof metadata.after === "object") return Object.keys(metadata.after);
  if (typeof metadata.link_field === "string") return [metadata.link_field];
  if (/\.(created|quick-captured)$/.test(action) || action === "draft.adopted" || action === "review.accepted") return [];
  if (action.endsWith(".deleted") || action === "note.restored") return ["deleted_at"];
  return ({ "object.sensitivity-changed": ["sensitivity"], "object.archived": ["archived_at"], "decision.superseded": ["status", "superseded_by_decision_id"] } as Record<string, string[]>)[action];
}
