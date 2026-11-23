import type { LifeOSObject } from "@lifeos/domain";
import { ObjectConflictError, type AppContext } from "./context.js";
import type { UpdateProposal } from "./patches.js";
import { sameValue } from "./support.js";

/**
 * #242 (ADR 0025): undoing an accepted `link-resolution` or `update` Review Item. Each plan function checks, writing nothing,
 * that the accept can be put back and returns the record the undo journal keeps; `applyRevert` puts it back and is safe to run
 * again after a crash. A refusal is an `ObjectConflictError` with the reason (HTTP 409), the same rule as Patch undo: a field the
 * accept set must still hold the value it set, so nothing the user changed afterwards is overwritten.
 */

/** What accepting a link-resolution item replaced, kept on the item itself (written before the link, so a crash cannot lose it). */
export interface LinkUndo { target_id: string; field: string; list: boolean; previous: unknown; linked: string; changed: boolean }

/** Fields a decision or open point can never move back from (ADR 0013 / lifecycle rules): an update setting one cannot be undone. */
const finalFields: Record<string, ReadonlySet<string>> = {
  decision: new Set(["status", "supersedes_decision_id", "superseded_by_decision_id"]),
  "open-point": new Set(["status", "resolved_at", "closed_at", "resolution_decision_id"])
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const written = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? undefined]));
const titleOf = (object: LifeOSObject) => `"${String(object.frontmatter.title)}"`;
const live = (object: LifeOSObject | undefined) => object && !object.frontmatter.deleted_at ? object : undefined;

/** The undo record of an accepted link-resolution item, or the reason there is none (an item accepted before #242). */
export function planLinkRevert(ctx: AppContext, review: LifeOSObject) {
  const stored = record(review.frontmatter.link_undo);
  if (typeof stored.target_id !== "string" || typeof stored.field !== "string" || typeof stored.linked !== "string") {
    throw new ObjectConflictError("Cannot undo: this link was accepted before LifeOS kept a record of what it replaced. Change the field yourself.");
  }
  const target = live(ctx.index.get(stored.target_id));
  if (target && stored.changed === true) {
    const current = target.frontmatter[stored.field];
    const holds = stored.list === true ? Array.isArray(current) && current.includes(stored.linked) : current === stored.linked;
    if (!holds) throw new ObjectConflictError(`Cannot undo: ${stored.field} of ${titleOf(target)} was changed after the link was accepted. Open it to change it yourself.`);
  }
  return { kind: "link", ...stored };
}

/** The undo record of an accepted `update` item, or the reason it cannot be undone cleanly. */
export function planUpdateRevert(ctx: AppContext, review: LifeOSObject) {
  const proposal = record(review.frontmatter.proposed_fields) as unknown as UpdateProposal;
  const targetId = String(review.frontmatter.target_object_id);
  if (!Array.isArray(proposal.changes)) throw new ObjectConflictError("Cannot undo: this change has no record of the fields it changed.");
  if (proposal.changes.some((change) => change.field === "superseded_by_decision_id")) {
    throw new ObjectConflictError("Cannot undo: this change replaced a decision with another one, which changed both decisions. A replaced decision is final, so it cannot be put back.");
  }
  const before = Object.fromEntries(proposal.changes.map((change) => [change.field, change.current ?? null]));
  const after = Object.fromEntries(proposal.changes.map((change) => [change.field, change.proposed ?? null]));
  const appended = typeof review.frontmatter.applied_append === "string" ? review.frontmatter.applied_append : undefined;
  const target = live(ctx.index.get(targetId));
  if (target) {
    const final = finalFields[String(target.frontmatter.type)];
    const sticky = final ? Object.keys(after).filter((field) => final.has(field)) : [];
    if (sticky.length) throw new ObjectConflictError(`Cannot undo: ${sticky.join(", ")} of a ${String(target.frontmatter.type)} cannot be changed back once it is set.`);
    if (proposal.append_note && appended === undefined) throw new ObjectConflictError("Cannot undo: this change added a note, and LifeOS did not keep the exact text it added. Remove the note yourself.");
    const changed = Object.keys(after).filter((field) => !sameValue(target.frontmatter[field], after[field]));
    if (appended !== undefined && !target.body.endsWith(appended)) changed.push("the added note");
    if (changed.length) throw new ObjectConflictError(`Cannot undo: ${changed.join(", ")} of ${titleOf(target)} changed after the change was applied; undo would overwrite the newer edit. Open it to change it yourself.`);
  }
  return { kind: "update", target_id: targetId, before, after, ...(appended !== undefined ? { appended } : {}) };
}

/**
 * Puts one link or update back. Returns the ID of the target it covers (none when the target is gone or the accept changed nothing); a replay that finds it already back returns it too.
 * Throws `ObjectConflictError`, having written nothing, when the target no longer holds what the accept set.
 */
export async function applyRevert(ctx: AppContext, revert: Record<string, unknown>, now: string): Promise<string[]> {
  const target = live(ctx.index.get(String(revert.target_id)));
  if (!target) return [];
  const conflict = (what: string) => new ObjectConflictError(`Cannot undo: ${what} of ${titleOf(target)} was changed while the undo was being made. Open it to change it yourself.`);
  if (revert.kind === "link") {
    if (revert.changed !== true) return [];
    const field = String(revert.field), linked = String(revert.linked), current = target.frontmatter[field];
    if (revert.list === true) {
      if (!Array.isArray(current) || !current.includes(linked)) return [target.frontmatter.id];
      const rest = current.filter((id) => id !== linked);
      await ctx.update(target, { [field]: rest.length || revert.previous ? rest : undefined }, { expectedHash: target.contentHash, now });
    } else {
      if (sameValue(current, revert.previous)) return [target.frontmatter.id];
      if (current !== linked) throw conflict(field);
      await ctx.update(target, { [field]: revert.previous ?? undefined }, { expectedHash: target.contentHash, now });
    }
    return [target.frontmatter.id];
  }
  const before = record(revert.before), after = record(revert.after);
  const appended = typeof revert.appended === "string" ? revert.appended : undefined;
  const holds = (values: Record<string, unknown>) => Object.entries(values).every(([field, value]) => sameValue(target.frontmatter[field], value));
  const noteIn = appended !== undefined && target.body.endsWith(appended);
  if (holds(before) && !noteIn) return [target.frontmatter.id];
  if (!holds(after) || (appended !== undefined && !noteIn)) throw conflict(Object.keys(after).join(", "));
  await ctx.update(target, written(before), { expectedHash: target.contentHash, now, ...(appended !== undefined ? { body: target.body.slice(0, -appended.length) } : {}) });
  return [target.frontmatter.id];
}

/**
 * After an `update` item is undone, its guard (`base_revision`, `base_hash`) is moved to the target as the undo left it, so the
 * item can be applied again instead of failing as "changed since". Only when the target really holds the old values again; an
 * edit made since keeps the old guard, and applying then reports the conflict. Returns the item's new `proposed_fields`.
 */
export function rebasedProposal(ctx: AppContext, review: LifeOSObject, revert: Record<string, unknown>) {
  const target = live(ctx.index.get(String(revert.target_id)));
  const before = record(revert.before);
  const appended = typeof revert.appended === "string" ? revert.appended : undefined;
  if (!target || !Object.entries(before).every(([field, value]) => sameValue(target.frontmatter[field], value)) || (appended !== undefined && target.body.endsWith(appended))) return undefined;
  return { ...record(review.frontmatter.proposed_fields), base_revision: target.frontmatter.revision, base_hash: target.contentHash };
}
