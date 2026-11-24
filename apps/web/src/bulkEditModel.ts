import type { ReviewEdits } from "@lifeos/contracts";
import { editableByTarget, reviewType, text, type InboxReview } from "./inboxModel.js";

/** PB-043 Bulk edit: the fields it can set, in the fixed order of the buttons. */
export type BulkFieldKey = "owner_person_id" | "due_on" | "priority" | "primary_project_id" | "primary_client_id" | "primary_product_id";
export const bulkFieldOrder: BulkFieldKey[] = ["owner_person_id", "due_on", "priority", "primary_project_id", "primary_client_id", "primary_product_id"];
export const bulkFieldLabel: Record<BulkFieldKey, string> = { owner_person_id: "Owner", due_on: "Due", priority: "Priority", primary_project_id: "Project", primary_client_id: "Client", primary_product_id: "Product" };
export const priorities = ["High", "Medium", "Low"] as const;

/** One item's change in a Bulk edit (or its undo). */
export type BulkEditChange = { review: InboxReview; edits: ReviewEdits };
/** What a Bulk edit did: the IDs saved, and "title: reason" for each one that was not. */
export type EditResult = { edited: string[]; failures: string[] };

/** The fields a proposal can have edited before it is accepted: only create proposals of a Task, Decision or Open point have any. */
export const editableFieldsOf = (review: InboxReview): BulkFieldKey[] =>
  reviewType(review) === "create" ? (editableByTarget[text(review.frontmatter.target_object_type)] ?? []) as BulkFieldKey[] : [];

/**
 * The Bulk edit for the ticked items: the items that have editable fields, the fields they all share (in button order),
 * and how many ticked items have no editable field at all and are skipped (Knowledge note, Change, Summary, Link, Merge).
 */
export function bulkEditPlan(ticked: InboxReview[]): { items: InboxReview[]; fields: BulkFieldKey[]; skipped: number } {
  const items = ticked.filter((review) => editableFieldsOf(review).length > 0);
  const fields = items.length ? bulkFieldOrder.filter((key) => items.every((review) => editableFieldsOf(review).includes(key))) : [];
  return { items, fields, skipped: ticked.length - items.length };
}

const proposedOf = (review: InboxReview) => (review.frontmatter.proposed_fields ?? {}) as Record<string, unknown>;

/** One item's value for a field, as the reading pane reads it. "" means unset (Me for Owner). A due date with a time reads as that instant. */
export function fieldValue(review: InboxReview, key: BulkFieldKey): string {
  if (key.startsWith("primary_")) return text(review.frontmatter[key]);
  const proposed = proposedOf(review);
  if (key === "due_on") return text(proposed.due_on) || text(proposed.due_at);
  return text(proposed[key]);
}

/** The value every item shares, or `undefined` when they differ (the button then reads "Mixed"). */
export function sharedValue(items: InboxReview[], key: BulkFieldKey): string | undefined {
  const values = new Set(items.map((review) => fieldValue(review, key)));
  return values.size === 1 ? [...values][0] : undefined;
}

/** The edit that puts one item's field back the way it was: a due date with a time gets its instant and time zone back. */
export function restoreEdits(review: InboxReview, key: BulkFieldKey): ReviewEdits {
  const proposed = proposedOf(review);
  if (key === "due_on" && text(proposed.due_at)) return { due_at: text(proposed.due_at), due_timezone: text(proposed.due_timezone) || null };
  return { [key]: fieldValue(review, key) || null };
}

/**
 * The changes that set `key` to `value` ("" clears it) on `items`, with the edits that undo each one.
 * Items that already have the value are left alone and counted as `unchanged`.
 */
export function bulkEditChanges(items: InboxReview[], key: BulkFieldKey, value: string) {
  const changing = items.filter((review) => fieldValue(review, key) !== value);
  return {
    changes: changing.map((review): BulkEditChange => ({ review, edits: { [key]: value || null } })),
    undo: changing.map((review): BulkEditChange => ({ review, edits: restoreEdits(review, key) })),
    unchanged: items.length - changing.length
  };
}
