import { describe, expect, it } from "vitest";
import { bulkEditChanges, bulkEditPlan, bulkFieldForKey, fieldValue, missingFieldNote, restoreEdits, sharedValue } from "./bulkEditModel.js";
import type { InboxReview } from "./inboxModel.js";

const review = (id: string, fields: Record<string, unknown> = {}): InboxReview => ({
  relativePath: `review-items/${id}.md`, contentHash: `${id}-hash`, body: "",
  frontmatter: { id, type: "review-item", schema_version: 1, revision: 1, title: `Proposal ${id}`, created_at: "2026-11-24T08:00:00Z", updated_at: "2026-11-24T08:00:00Z", review_type: "create", target_object_type: "task", status: "pending", proposed_fields: {}, ...fields }
});
const task = (id: string, fields: Record<string, unknown> = {}) => review(id, fields);
const decision = (id: string, fields: Record<string, unknown> = {}) => review(id, { target_object_type: "decision", ...fields });
const openPoint = (id: string) => review(id, { target_object_type: "open-point" });

describe("bulkEditPlan", () => {
  it("offers every Task field, in the fixed order, when only Tasks are ticked", () => {
    expect(bulkEditPlan([task("a"), task("b")]).fields).toEqual(["owner_person_id", "due_on", "priority", "primary_project_id", "primary_client_id", "primary_product_id"]);
  });
  it("offers only the fields every ticked kind has", () => {
    expect(bulkEditPlan([task("a"), openPoint("b")]).fields).toEqual(["owner_person_id", "primary_project_id", "primary_client_id", "primary_product_id"]);
    expect(bulkEditPlan([task("a"), decision("b"), openPoint("c")]).fields).toEqual(["primary_project_id", "primary_client_id", "primary_product_id"]);
  });
  it("skips and counts kinds with no editable field instead of hiding every button", () => {
    const plan = bulkEditPlan([task("a"), review("s", { review_type: "summary", target_object_type: "meeting" }), review("c", { review_type: "update" }), review("k", { target_object_type: "knowledge-note" })]);
    expect(plan.items.map((item) => item.frontmatter.id)).toEqual(["a"]);
    expect(plan.skipped).toBe(3);
    expect(plan.fields).toContain("due_on");
  });
  it("offers nothing when no ticked item has a field", () => {
    expect(bulkEditPlan([review("s", { review_type: "summary" })])).toMatchObject({ items: [], fields: [], skipped: 1 });
    expect(bulkEditPlan([])).toMatchObject({ fields: [], skipped: 0 });
  });
});

describe("values", () => {
  it("reads context links from the review and the rest from the proposed fields", () => {
    const item = task("a", { primary_project_id: "pr1", proposed_fields: { owner_person_id: "p1", due_on: "2026-12-01", priority: "High" } });
    expect(["primary_project_id", "owner_person_id", "due_on", "priority", "primary_client_id"].map((key) => fieldValue(item, key as never))).toEqual(["pr1", "p1", "2026-12-01", "High", ""]);
  });
  it("is shared when every item agrees and Mixed (undefined) when they differ", () => {
    expect(sharedValue([task("a", { primary_project_id: "pr1" }), task("b", { primary_project_id: "pr1" })], "primary_project_id")).toBe("pr1");
    expect(sharedValue([task("a"), task("b")], "primary_project_id")).toBe("");
    expect(sharedValue([task("a", { primary_project_id: "pr1" }), task("b")], "primary_project_id")).toBeUndefined();
  });
});

describe("bulkEditChanges", () => {
  it("sets the value on items that differ, leaves the others alone, and keeps each item's old value for Undo", () => {
    const items = [task("a", { primary_client_id: "c1" }), task("b", { primary_client_id: "c2" }), task("c")];
    const { changes, undo, unchanged } = bulkEditChanges(items, "primary_client_id", "c1");
    expect(unchanged).toBe(1);
    expect(changes.map((change) => [change.review.frontmatter.id, change.edits])).toEqual([["b", { primary_client_id: "c1" }], ["c", { primary_client_id: "c1" }]]);
    expect(undo.map((change) => [change.review.frontmatter.id, change.edits])).toEqual([["b", { primary_client_id: "c2" }], ["c", { primary_client_id: null }]]);
  });
  it("clears a field with null (Owner back to Me)", () => {
    expect(bulkEditChanges([task("a", { proposed_fields: { owner_person_id: "p1" } })], "owner_person_id", "").changes[0]!.edits).toEqual({ owner_person_id: null });
  });
  it("puts back a due date that had a time as its instant and time zone", () => {
    expect(restoreEdits(task("a", { proposed_fields: { due_at: "2026-12-01T15:00:00.000Z", due_timezone: "Europe/Paris" } }), "due_on")).toEqual({ due_at: "2026-12-01T15:00:00.000Z", due_timezone: "Europe/Paris" });
    expect(restoreEdits(task("b", { proposed_fields: { due_on: "2026-12-01" } }), "due_on")).toEqual({ due_on: "2026-12-01" });
  });
});

describe("field keys (PB-044)", () => {
  it("maps O D I J C P to their fields, in either case, and nothing else", () => {
    expect(["o", "D", "i", "j", "c", "P"].map(bulkFieldForKey)).toEqual(["owner_person_id", "due_on", "priority", "primary_project_id", "primary_client_id", "primary_product_id"]);
    expect(["r", "a", "k", "x"].map(bulkFieldForKey)).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("names the kinds that lack a field, or nothing when all have it", () => {
    expect(missingFieldNote([task("a"), decision("b")], "due_on")).toBe("Due isn't available for Decisions");
    expect(missingFieldNote([task("a"), decision("b"), openPoint("c")], "priority")).toBe("Priority isn't available for Decisions and Open points");
    expect(missingFieldNote([review("s", { review_type: "summary" })], "primary_product_id")).toBe("Product isn't available for Summaries");
    expect(missingFieldNote([task("a"), openPoint("b")], "owner_person_id")).toBeUndefined();
  });
});
