import { envelopeWriteProblem, lifecycleWriteProblem, objectTypes, uuidV7, validateFrontmatter, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DraftError, draftOrigins, isCalendarDate, text, toUtc, validationIssues, type AdoptionRun, type DraftOrigin, type DraftResult, type FileDocument } from "./adoption.js";
import { foldForSearch, markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { decisionFields } from "./decisions.js";
import type { InboxDocument } from "./ports.js";
import { ReferenceResolver, referenceFields, type ReferenceField } from "./resolution.js";

/**
 * Patch Drafts (ADR 0007, PRD "Patch drafts"): an Agent asks for a change to an existing object by
 * dropping a file in `_inbox/patches/`. Adoption reads them in the same batch as drafts, after them.
 *
 * One patch: check the contract → idempotency (draft_key + content hash, from `patch.applied` audit
 * events) → resolve the target → decide whether it may apply on its own → one guarded write → a
 * `patch.applied` audit event holding before/after values → filed with the shared `.result.md` sidecar.
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
const same = (left: unknown, right: unknown) => JSON.stringify(stored(left)) === JSON.stringify(stored(right));
const metadataOf = (object: LifeOSObject) => (object.frontmatter.metadata ?? {}) as Record<string, unknown>;
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const validTimeZone = (zone: string) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } };

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
      if (previous && previous.contentHash === patch.contentHash) return file(document, "processed", { draftKey, objectIds: [previous.objectId], outcome: "duplicate" });
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
    const alreadyUndone = ctx.index.all().some((object) => object.frontmatter.type === "audit-event" && object.frontmatter.action === undoneAction && metadataOf(object).patch_audit_id === auditEventId);
    if (alreadyUndone) return target;

    const before = record(metadata.before);
    const after = record(metadata.after);
    const appended = typeof metadata.appended_text === "string" ? metadata.appended_text : undefined;
    const changed = Object.keys(after).filter((key) => !same(target.frontmatter[key], after[key]));
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
    const reasons = this.reviewReasons(patch, target);
    const changes = this.changes(patch, target);
    const keys = Object.keys(changes).filter((key) => !same(target.frontmatter[key], changes[key]));
    const before = Object.fromEntries(keys.map((key) => [key, stored(target.frontmatter[key])]));
    const after = Object.fromEntries(keys.map((key) => [key, stored(changes[key])]));
    // Conflict rule (PRD): the target was edited after the patch was captured, on a field the patch changes.
    const conflicts = this.changedSince(target, patch.capturedAt, keys);
    if (conflicts.length) reasons.push(`conflict: ${conflicts.join(", ")} changed after this patch was captured (${patch.capturedAt}); review it so the newer edit is not overwritten`);
    if (reasons.length && (keys.length || patch.appendNote)) return { objectId: await this.raiseReview(patch, target, before, after, reasons, run), outcome: "review" };

    // The exact text appended, so undo can remove precisely that and nothing the user wrote after it.
    const appended = patch.appendNote ? appendedText(target.body, patch.appendNote) : undefined;
    // A patch that changes nothing ("mark it done" when it already is) writes no revision, but is still audited so a re-send is recognised.
    if (keys.length || appended) await this.ctx.update(target, written(after), { expectedHash: target.contentHash, now: run.now, ...(appended ? { body: target.body + appended } : {}) });
    await this.ctx.writeAudit(appliedAction, target.frontmatter.id, run.now, {
      draft_key: patch.draftKey, content_hash: patch.contentHash, draft_path: patch.file.relativePath, agent_run_id: run.id, origin: patch.origin,
      captured_at: patch.capturedAt, before, after, ...(appended ? { append_note: patch.appendNote, appended_text: appended } : {})
    });
    return { objectId: target.frontmatter.id, outcome: "applied" };
  }

  /**
   * Which of `keys` were changed after `capturedAt`, read from the target's audit events. Another patch's
   * change counts from when it was captured, so dictation order wins over adoption order. An edit whose
   * fields are unknown (external edit, unaudited write) counts as touching every field: never overwrite blind.
   */
  private changedSince(target: LifeOSObject, capturedAt: string, keys: string[]) {
    const since = Date.parse(capturedAt);
    if (!keys.length || !(Date.parse(String(target.frontmatter.updated_at)) > since)) return [];
    const events = this.ctx.index.all().filter((object) => object.frontmatter.type === "audit-event" && object.frontmatter.object_id === target.frontmatter.id && Date.parse(String(object.frontmatter.occurred_at)) > since);
    if (!events.length) return keys;
    const changed = new Set<string>();
    for (const event of events) {
      const metadata = metadataOf(event);
      if (event.frontmatter.action === appliedAction && typeof metadata.captured_at === "string" && !(Date.parse(metadata.captured_at) > since)) continue;
      const fields = touchedFields(String(event.frontmatter.action), metadata);
      if (!fields) return keys;
      fields.forEach((field) => changed.add(field));
    }
    return keys.filter((key) => changed.has(key));
  }

  /** Writes the `update` Review Item (current vs proposed per field) and the audit event that makes re-sends idempotent. */
  private async raiseReview(patch: ParsedPatch, target: LifeOSObject, before: Record<string, unknown>, after: Record<string, unknown>, reasons: string[], run: AdoptionRun) {
    const id = uuidV7();
    const changes: UpdateChange[] = Object.keys(after).map((field) => ({ field, current: before[field], proposed: after[field] }));
    const title = `Change ${[...changes.map((change) => change.field), ...(patch.appendNote ? ["note"] : [])].join(", ")} on ${target.frontmatter.title}`;
    const proposal: UpdateProposal = { changes, ...(patch.appendNote ? { append_note: patch.appendNote } : {}), reasons, base_revision: target.frontmatter.revision, base_hash: target.contentHash, draft_key: patch.draftKey, captured_at: patch.capturedAt };
    const cell = (value: unknown) => value === null ? "(none)" : (typeof value === "string" ? value : JSON.stringify(value)).replace(/\|/g, "\\|").replace(/\n/g, " ");
    const table = changes.length ? `\n\n| Field | Current | Proposed |\n| --- | --- | --- |\n${changes.map((change) => `| ${change.field} | ${cell(change.current)} | ${cell(change.proposed)} |`).join("\n")}` : "";
    const note = patch.appendNote ? `\n\nNote to append:\n\n${patch.appendNote.split("\n").map((line) => `> ${line}`).join("\n")}` : "";
    await this.ctx.objects.write({
      relativePath: `review-items/${markdownFileName(title, id, run.now)}`,
      frontmatter: {
        ...this.ctx.envelope(id, "review-item", title, run.now, patch.origin),
        review_type: "update", target_object_type: target.frontmatter.type, target_object_id: target.frontmatter.id, proposed_fields: { ...proposal },
        confidence_label: patch.origin === "agent-extracted" ? "Medium" : "High", field_evidence: {}, status: "pending", operation_id: uuidV7(), source_ids: [], agent_run_id: run.id
      },
      body: `# ${title}\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}${table}${note}\n`
    });
    await this.ctx.writeAudit(reviewRaisedAction, id, run.now, { draft_key: patch.draftKey, content_hash: patch.contentHash, draft_path: patch.file.relativePath, agent_run_id: run.id, origin: patch.origin, captured_at: patch.capturedAt, target_object_id: target.frontmatter.id, reasons });
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
      const matches = index.all().filter((object) => object.frontmatter.type === type && !object.frontmatter.deleted_at && !object.frontmatter.archived_at && foldForSearch(object.frontmatter.title.trim()) === wanted);
      if (!matches.length) throw new DraftError([`title: no ${type} titled "${title}"`]);
      if (matches.length > 1) throw new DraftError([`title: ${matches.length} ${type}s are titled "${title}" (${matches.map((match) => match.frontmatter.id).join(", ")}); give the id instead`]);
      target = matches[0]!;
    }
    const paths = index.duplicatePaths?.(target.frontmatter.id);
    if (paths) throw new DraftError([`id: ${target.frontmatter.id} is a duplicate object ID (${paths.join(" and ")}); resolve the duplicate before patching it`]);
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
