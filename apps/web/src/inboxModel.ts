import type { LifeObject, ReviewEvidence } from "@lifeos/contracts";
import { addCalendarDays, dateInTimeZone, zonedMidnight } from "./zonedTime.js";

export type ReviewChoices = Record<"people" | "projects" | "clients" | "products", Array<{ id: string; title: string }>>;
export type InboxReview = LifeObject & { evidence?: Record<string, ReviewEvidence[]> };
export type Outcome = "accepted" | "rejected";
/** `false` means nothing happened; an accept may name the object it created (for the toast's View). */
export type ActionResult = boolean | void | { objectId?: string };
/** ADR 0025: what undoing a batch did. `refused` carries the server's reason for each item it would not undo. */
export type UndoResult = { undone: string[]; refused: Array<{ id: string; reason: string }> };
/** The ID of the object an accept created, read from the accept response (the new object). */
export const createdObjectId = (response: unknown): string | undefined => {
  const id = (response as { frontmatter?: { id?: unknown } } | undefined)?.frontmatter?.id;
  return typeof id === "string" ? id : undefined;
};
export type CreatedPeriod = "" | "today" | "7d" | "30d";
export type InboxTab = "All" | "Summary" | "Decision" | "Task" | "Open point" | "Other";
/** Tab order is also the 1–6 shortcut order. */
export const inboxTabs: InboxTab[] = ["All", "Summary", "Decision", "Task", "Open point", "Other"];
/** `objects` maps an accepted item's ID to the object it created. */
export type BulkResult = { decided: string[]; failures: string[]; objects?: Record<string, string> };

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
/** Controls that already use Enter or Space themselves; the Inbox's Enter-to-open leaves them alone. */
export const interactiveTarget = "button, a[href], input, select, textarea, summary, [role='button'], [role='tab'], [role='separator'], [contenteditable=''], [contenteditable='true']";
export const errorText = (caught: unknown) => caught instanceof Error ? caught.message : "Something went wrong";

export const createdWindow = (period: CreatedPeriod, now: Date, timeZone: string) => {
  if (!period) return undefined;
  const today = dateInTimeZone(now, timeZone);
  const startDay = period === "today" ? today : addCalendarDays(today, -(period === "7d" ? 6 : 29));
  return { from: zonedMidnight(startDay, timeZone).getTime(), to: zonedMidnight(addCalendarDays(today, 1), timeZone).getTime() };
};

/** What a Review Item is, in the words the list badge uses (CONTEXT.md: Review kind). Create items follow their target type. */
export type ReviewKind = "Task" | "Decision" | "Open point" | "Knowledge note" | "Change" | "Summary" | "Link" | "Merge" | (string & {});
const createKinds: Record<string, ReviewKind> = { task: "Task", decision: "Decision", "open-point": "Open point", "knowledge-note": "Knowledge note" };
/** The badge for a Review type and (for a create item) its target object type; History rows carry these two fields. */
export const kindOf = (type: string, target = ""): ReviewKind => {
  if (type === "update") return "Change";
  if (type === "summary") return "Summary";
  if (type === "link-resolution") return "Link";
  if (type === "person-merge") return "Merge";
  return createKinds[target] ?? (target ? `${target[0]!.toUpperCase()}${target.slice(1).replaceAll("-", " ")}` : "Task");
};
export const reviewKind = (review: InboxReview): ReviewKind => kindOf(reviewType(review), text(review.frontmatter.target_object_type));
export const kindClass = (kind: ReviewKind) => `kind-${kind.toLowerCase().replaceAll(" ", "-")}`;

export type DateBucket = "Today" | "Yesterday" | "Earlier this week" | "Older";
const dayMs = 86_400_000;
const midday = (key: string) => Date.parse(`${key}T12:00:00.000Z`);
/** The calendar day an instant falls on in `timeZone` ("YYYY-MM-DD"). */
export const dayOf = (value: string | Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(value));
export const dateBucket = (iso: string, now: Date, timeZone: string): DateBucket => {
  if (Number.isNaN(Date.parse(iso))) return "Older";
  const days = Math.round((midday(dayOf(now, timeZone)) - midday(dayOf(iso, timeZone))) / dayMs);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "Earlier this week" : "Older";
};

export type SourceGroup = { key: string; label: string; items: InboxReview[] };
export type DateGroup = { bucket: DateBucket; sources: SourceGroup[] };
export const groupKey = (bucket: DateBucket, source: SourceGroup) => `${bucket}|${source.key}`;
const dateOrder: DateBucket[] = ["Today", "Yesterday", "Earlier this week", "Older"];
const created = (review: InboxReview) => Date.parse(String(review.frontmatter.created_at)) || 0;
const newestFirst = (a: InboxReview, b: InboxReview) => created(b) - created(a) || a.frontmatter.id.localeCompare(b.frontmatter.id);

/** Date, then Source meeting; items with none group by the Agent run that wrote them, then "Other". Groups run newest item first. */
export function groupReviews(reviews: InboxReview[], { now, timeZone, meetingTitle }: { now: Date; timeZone: string; meetingTitle: (id: string) => string | undefined }): DateGroup[] {
  const sourceOf = (review: InboxReview) => {
    const meetingId = text(review.frontmatter.source_meeting_id); const runId = text(review.frontmatter.agent_run_id);
    if (meetingId) return { key: `meeting:${meetingId}`, label: `Meeting · ${meetingTitle(meetingId) ?? "unavailable"}` };
    // The run ID means nothing to the user; the time it wrote the item names the run (#237 review).
    if (runId) return { key: `run:${runId}`, label: `Agent run · ${runTime(String(review.frontmatter.created_at), now, timeZone)}` };
    return { key: "other", label: "Other" };
  };
  const byBucket = new Map<DateBucket, Map<string, SourceGroup>>();
  for (const review of [...reviews].sort(newestFirst)) {
    const bucket = dateBucket(String(review.frontmatter.created_at), now, timeZone); const source = sourceOf(review);
    const sources = byBucket.get(bucket) ?? new Map<string, SourceGroup>(); byBucket.set(bucket, sources);
    const group = sources.get(source.key) ?? { ...source, items: [] }; sources.set(source.key, group);
    group.items.push(review);
  }
  return dateOrder.filter((bucket) => byBucket.has(bucket)).map((bucket) => ({
    bucket,
    // Items are already newest first, so a group's first item is its newest.
    sources: [...byBucket.get(bucket)!.values()].sort((a, b) => created(b.items[0]!) - created(a.items[0]!) || a.key.localeCompare(b.key))
  }));
}

/** The id next to `id` in the visual order, skipping ids in `hidden` (collapsed groups). Unknown `id` gives the first shown id. */
export function adjacentId(ordered: string[], hidden: Set<string>, id: string, direction: -1 | 1): string | undefined {
  const index = ordered.indexOf(id);
  if (index < 0) return ordered.find((candidate) => !hidden.has(candidate));
  for (let at = index + direction; at >= 0 && at < ordered.length; at += direction) if (!hidden.has(ordered[at]!)) return ordered[at];
  return undefined;
}

/** The ids from `anchor` to `id` inclusive in the visual order, skipping hidden (collapsed) ones. Without a usable anchor, just `id`. */
export function rangeIds(ordered: string[], hidden: Set<string>, anchor: string | undefined, id: string): string[] {
  const shown = ordered.filter((candidate) => !hidden.has(candidate));
  const from = anchor ? shown.indexOf(anchor) : -1; const to = shown.indexOf(id);
  if (from < 0 || to < 0) return [id];
  return shown.slice(Math.min(from, to), Math.max(from, to) + 1);
}

export type RowCells = { kind: ReviewKind; owner?: string; due?: string; project?: string; client?: string; product?: string; low: boolean };
/** `contextName` names a project, client or product by ID. */
export type RowLookups = { personName: (id: string) => string | undefined; contextName: (id: string) => string | undefined };
const clock = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
/** An Agent run is named by when it wrote: the time today, else the day and time (two runs on one older day stay apart). */
const runTime = (iso: string, now: Date, timeZone: string) => Number.isNaN(Date.parse(iso)) ? "time unknown" : dayOf(iso, timeZone) === dayOf(now, timeZone) ? clock(iso, timeZone) : `${shortDay(dayOf(iso, timeZone))} ${clock(iso, timeZone)}`;
const shortDay = (key: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(midday(key));
/** Owner, Due, Project, Client and Product for one list row, read the way the detail pane reads them (PB-043 dropped the arrival time). */
export function reviewRowCells(review: InboxReview, { personName, contextName }: RowLookups): RowCells {
  const proposed = (review.frontmatter.proposed_fields ?? {}) as Record<string, unknown>;
  const target = text(review.frontmatter.target_object_type); const create = reviewType(review) === "create";
  const ownerId = text(proposed.owner_person_id); const due = text(proposed.due_on);
  const context = (key: string, unknown: string) => { const id = text(review.frontmatter[key]); return id ? contextName(id) ?? unknown : undefined; };
  return {
    kind: reviewKind(review),
    owner: create && editableByTarget[target]?.includes("owner_person_id") ? (ownerId ? personName(ownerId) ?? "Unknown person" : "Me") : undefined,
    due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? shortDay(due) : undefined,
    project: context("primary_project_id", "Unknown project"),
    client: context("primary_client_id", "Unknown client"),
    product: context("primary_product_id", "Unknown product"),
    low: review.frontmatter.confidence_label === "Low"
  };
}

/**
 * #244: how many Review actions the user made today, for the Inbox zero screen. Counts History entries whose instant falls on today's
 * calendar day in `timeZone`, made by "you" (not the system) and not undone. History holds only the last 100 entries, so after 100
 * actions in one day this under-counts; that is accepted.
 */
export const processedToday = (entries: Array<{ at: string; actor: string; undone: boolean }>, now: Date, timeZone: string) => {
  const today = dayOf(now, timeZone);
  return entries.filter((entry) => entry.actor === "you" && !entry.undone && dayOf(entry.at, timeZone) === today).length;
};
