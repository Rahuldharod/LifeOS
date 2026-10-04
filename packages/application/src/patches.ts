import { objectTypes, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DraftError, draftOrigins, isCalendarDate, text, toUtc, validationIssues, type AdoptionRun, type DraftOrigin, type DraftResult, type FileDocument } from "./adoption.js";
import { foldForSearch, ObjectConflictError, type AppContext } from "./context.js";
import type { InboxDocument } from "./ports.js";

/**
 * Patch Drafts (ADR 0007, PRD "Patch drafts"): an Agent asks for a change to an existing object by
 * dropping a file in `_inbox/patches/`. Adoption reads them in the same batch as drafts, after them.
 *
 * One patch: check the contract → idempotency (draft_key + content hash, from `patch.applied` audit
 * events) → resolve the target → decide whether it may apply on its own → one guarded write → a
 * `patch.applied` audit event holding before/after values → filed with the shared `.result.md` sidecar.
 * `undoPatch` puts the before values back through another guarded write, audited as `patch.undone`.
 */

export const patchContractVersion = 1;
/** Task fields a user-dictated patch may change without review. `waiting_for` needs the task to end up Waiting. */
export const autoAppliedTaskFields = ["status", "due_on", "due_at", "due_timezone", "priority", "waiting_for"] as const;
const appliedAction = "patch.applied";
const undoneAction = "patch.undone";
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

// Audit values use `null` for "absent" (YAML cannot hold `undefined`); writes use `undefined`, which removes the field.
const stored = (value: unknown) => value === undefined ? null : value;
const written = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? undefined]));
const same = (left: unknown, right: unknown) => JSON.stringify(stored(left)) === JSON.stringify(stored(right));
const metadataOf = (object: LifeOSObject) => (object.frontmatter.metadata ?? {}) as Record<string, unknown>;
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
const validTimeZone = (zone: string) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } };

export class PatchModule {
  constructor(private readonly ctx: AppContext) {}

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

      let objectId: string;
      try { objectId = await this.apply(patch, run); }
      catch (error) {
        const issues = validationIssues(error);
        if (issues) return fail(issues);
        // Not the patch's fault (disk, lease, target changed mid-write): leave it in patches for the next trigger.
        return { draft: document.relativePath, outcome: "skipped", objectIds: [], reason: `${prefix}: ${error instanceof Error ? error.message : String(error)}; will retry` };
      }
      ledger.set(patch.draftKey, { contentHash: patch.contentHash, objectId });
      // The next patch in the batch may target the same object: it needs the new content hash.
      await this.ctx.rebuildIndex();
      return file(document, "processed", { draftKey, objectIds: [objectId], outcome: "applied" });
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

  /** Applies one patch with a guarded write and audits it; returns the target ID. */
  private async apply(patch: ParsedPatch, run: AdoptionRun) {
    const target = this.target(patch);
    const reasons = this.reviewReasons(patch, target);
    // #37 adds the conflict rule here: target updated after captured_at on a patched field → review, not overwrite.
    if (reasons.length) return this.routeToReview(patch, target, reasons);

    const changes = target.frontmatter.type === "task" ? this.taskChanges(patch, target) : {};
    const keys = Object.keys(changes).filter((key) => !same(target.frontmatter[key], changes[key]));
    const before = Object.fromEntries(keys.map((key) => [key, stored(target.frontmatter[key])]));
    const after = Object.fromEntries(keys.map((key) => [key, stored(changes[key])]));
    // The exact text appended, so undo can remove precisely that and nothing the user wrote after it.
    const appended = patch.appendNote ? `${target.body.endsWith("\n") || !target.body ? "" : "\n"}\n${patch.appendNote}\n` : undefined;
    // A patch that changes nothing ("mark it done" when it already is) writes no revision, but is still audited so a re-send is recognised.
    if (keys.length || appended) await this.ctx.update(target, written(after), { expectedHash: target.contentHash, now: run.now, ...(appended ? { body: target.body + appended } : {}) });
    await this.ctx.writeAudit(appliedAction, target.frontmatter.id, run.now, {
      draft_key: patch.draftKey, content_hash: patch.contentHash, draft_path: patch.file.relativePath, agent_run_id: run.id, origin: patch.origin,
      captured_at: patch.capturedAt, before, after, ...(appended ? { append_note: patch.appendNote, appended_text: appended } : {})
    });
    return target.frontmatter.id;
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
    if (keys.length && target.frontmatter.type !== "task") return [`set: changes to a ${target.frontmatter.type} need review; only task status, due date, priority and waiting_for, and appended notes, apply automatically`];
    return keys.filter((key) => !(autoAppliedTaskFields as readonly string[]).includes(key)).map((key) => `set.${key}: changes to ${key} need review`);
  }

  /**
   * #37 seam: patches that need a second look become `update` Review Items. Until that lands they are
   * filed as failed with the reasons, so nothing is applied that should have been reviewed.
   */
  private async routeToReview(_patch: ParsedPatch, _target: LifeOSObject, reasons: string[]): Promise<string> {
    throw new DraftError(reasons.map((reason) => `${reason} (review of patches is not supported yet, so this patch was not applied)`));
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
        const person = this.person(text(set.waiting_for));
        if (typeof person === "string") issues.push(person); else changes.waiting_for_person_id = person.frontmatter.id;
      }
    } else if (status !== "Waiting" && current.waiting_for_person_id) changes.waiting_for_person_id = undefined;
    if (issues.length) throw new DraftError(issues);
    return changes;
  }

  /** A person by ID, or by title ignoring case and accents. Returns the issue text when there is not exactly one. */
  private person(reference: string): LifeOSObject | string {
    const people = this.ctx.index.all().filter((object) => object.frontmatter.type === "person" && !object.frontmatter.deleted_at);
    const byId = people.find((person) => person.frontmatter.id === reference);
    if (byId) return byId;
    const matches = people.filter((person) => foldForSearch(person.frontmatter.title.trim()) === foldForSearch(reference));
    if (matches.length === 1) return matches[0]!;
    return matches.length ? `waiting_for: ${matches.length} people are called "${reference}" (${matches.map((match) => match.frontmatter.id).join(", ")}); give the person's id instead` : `waiting_for: no person called "${reference}"`;
  }

  /** draft_key → the patch it applied, from `patch.applied` audit events (authoritative, so it survives restarts and lost sidecars). */
  private ledger() {
    const ledger = new Map<string, { contentHash: string; objectId: string }>();
    for (const object of this.ctx.index.all()) {
      if (object.frontmatter.type !== "audit-event" || object.frontmatter.action !== appliedAction) continue;
      const metadata = metadataOf(object);
      if (typeof metadata.draft_key === "string" && typeof metadata.content_hash === "string") ledger.set(metadata.draft_key, { contentHash: metadata.content_hash, objectId: String(object.frontmatter.object_id) });
    }
    return ledger;
  }
}
