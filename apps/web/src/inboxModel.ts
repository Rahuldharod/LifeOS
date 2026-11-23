import type { LifeObject, ReviewEvidence } from "@lifeos/contracts";
import { addCalendarDays, dateInTimeZone, zonedMidnight } from "./zonedTime.js";

export type ReviewChoices = Record<"people" | "projects" | "clients" | "products", Array<{ id: string; title: string }>>;
export type InboxReview = LifeObject & { evidence?: Record<string, ReviewEvidence[]> };
export type Outcome = "accepted" | "rejected";
export type ActionResult = boolean | void;
export type CreatedPeriod = "" | "today" | "7d" | "30d";
export type InboxTab = "All" | "Summary" | "Decision" | "Task" | "Open point" | "Other";
/** Tab order is also the 1–6 shortcut order. */
export const inboxTabs: InboxTab[] = ["All", "Summary", "Decision", "Task", "Open point", "Other"];
export type BulkResult = { decided: string[]; failures: string[] };

export const editableByTarget: Record<string, string[]> = {
  task: ["owner_person_id", "due_on", "priority", "primary_project_id", "primary_client_id", "primary_product_id"],
  decision: ["primary_project_id", "primary_client_id", "primary_product_id"],
  "open-point": ["owner_person_id", "primary_project_id", "primary_client_id", "primary_product_id"]
};
export const text = (value: unknown) => typeof value === "string" ? value : "";
export const reviewType = (review: InboxReview) => text(review.frontmatter.review_type) || "create";
export const proposalLabel = (review: InboxReview) => reviewType(review) === "create" ? `Create ${text(review.frontmatter.target_object_type) || "item"}` : reviewType(review).replaceAll("-", " ");
export const proposalTab = (review: InboxReview): Exclude<InboxTab, "All"> => {
  const kind = reviewType(review);
  if (kind === "summary") return "Summary";
  if (kind !== "create") return "Other";
  if (review.frontmatter.target_object_type === "task") return "Task";
  if (review.frontmatter.target_object_type === "decision") return "Decision";
  if (review.frontmatter.target_object_type === "open-point") return "Open point";
  return "Other";
};
/** Link and merge proposals need a judgement call, so bulk Accept skips them (bulk Reject does not). */
export const needsChoice = (review: InboxReview) => ["link-resolution", "person-merge"].includes(reviewType(review));
/** Single-key shortcuts must not fire while the user types; checkboxes and radios are not typing. */
export const typingTarget = "input:not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']";
export const errorText = (caught: unknown) => caught instanceof Error ? caught.message : "Something went wrong";

export const createdWindow = (period: CreatedPeriod, now: Date, timeZone: string) => {
  if (!period) return undefined;
  const today = dateInTimeZone(now, timeZone);
  const startDay = period === "today" ? today : addCalendarDays(today, -(period === "7d" ? 6 : 29));
  return { from: zonedMidnight(startDay, timeZone).getTime(), to: zonedMidnight(addCalendarDays(today, 1), timeZone).getTime() };
};
