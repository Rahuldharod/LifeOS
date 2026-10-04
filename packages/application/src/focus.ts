import { sensitivityOf, uuidV7, type LifeOSObject } from "@lifeos/domain";
import { DraftError, isCalendarDate, text, toUtc, type AdoptionRun, type ParsedDraft } from "./adoption.js";
import { markdownFileName, type AppContext } from "./context.js";
import { workOrderContractVersion } from "./enrichment.js";
import type { InboxStore } from "./ports.js";

/**
 * Daily Focus (ADR 0011, PRD "Daily Focus and Today"). The morning routine writes the brief as a
 * `daily-focus` Inbox Draft; adoption files it as a `daily-focus` object, and a newer brief for the
 * same date archives the older one in place. The app never edits a brief: Today overlays live status
 * from the index (finished tasks struck through and sunk, past meetings marked), and "Refresh" writes
 * a `replan` Work Order for Claude. Restricted objects are never shown from a brief (ADR 0010).
 */

/** The Top 3 cap ("max, configurable": a setting can replace this constant). */
export const maxTopThree = 3;
export const maxMeetingPrep = 3;
export const maxDeferCandidates = 3;
/** "About 300 words": a little slack, so a brief is refused only when it clearly no longer fits one screen. */
export const maxBriefWords = 330;

export type FocusItemState = "open" | "done" | "cancelled" | "past" | "missing";
/** One entry of the brief with its live status. `object` is absent when the referenced object is gone (`missing`). */
export interface FocusItem {
  id: string;
  state: FocusItemState;
  object?: LifeOSObject;
  overdue?: boolean;
  whyToday?: string;
  ifThen?: string;
  ageDays?: number;
  context?: string;
  ask?: string;
  reason?: string;
}
export interface DailyFocusView {
  /** The calendar date shown (the user's local date). */
  date: string;
  brief?: { id: string; title: string; path: string; generatedAt: string; body: string };
  iOwe: FocusItem[];
  /** The effective Top 3: the brief's, or the deterministic rule's when there is no brief. */
  top3: FocusItem[];
  top3Source: "brief" | "rule";
  waitingAndDecisions: FocusItem[];
  meetingPrep: FocusItem[];
  dayShape?: { meetingHours: number; freeHours: number };
  deferCandidates: FocusItem[];
  /** Restricted objects the brief references: counted, never named. */
  restrictedHidden: number;
}
export interface ReplanRequest {
  workOrder: string;
  /** True when an unprocessed replan for the same date was already waiting; nothing new was written. */
  alreadyRequested: boolean;
  message: string;
}

const isLive = (object: LifeOSObject) => !object.frontmatter.deleted_at && !object.frontmatter.archived_at;
const isRestricted = (object: LifeOSObject) => sensitivityOf(object.frontmatter) === "restricted";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateText = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : text(value);
const list = (value: unknown) => Array.isArray(value) ? value as unknown[] : [];
const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The live brief for a date: the newest `generated_at` among the date's non-archived, non-restricted briefs. */
function currentBrief(ctx: AppContext, date: string) {
  return ctx.index.all()
    .filter((object) => object.frontmatter.type === "daily-focus" && isLive(object) && dateText(object.frontmatter.focus_on) === date && !isRestricted(object))
    .sort((left, right) => String(right.frontmatter.generated_at ?? "").localeCompare(String(left.frontmatter.generated_at ?? "")))[0];
}

/**
 * Adoption route for `daily-focus` drafts (both origins: the routine is an Agent, but a dictated
 * brief follows the same rules). Validates every section at once, writes the object, then archives
 * any older brief for the same date. A brief older than the live one (a late arrival) is filed
 * already archived, so the newest `generated_at` always wins whatever the arrival order.
 */
export async function adoptDailyFocus(ctx: AppContext, draft: ParsedDraft, run: AdoptionRun): Promise<string[]> {
  const { fields } = draft;
  const issues: string[] = [];
  const focusOn = dateText(fields.focus_on);
  if (!focusOn) issues.push("focus_on: missing; the date this brief is for (YYYY-MM-DD)");
  else if (!isCalendarDate(focusOn)) issues.push(`focus_on: not a calendar date YYYY-MM-DD ("${focusOn}")`);
  const generatedAt = fields.generated_at === undefined ? draft.capturedAt : toUtc(fields.generated_at);
  if (!generatedAt) issues.push(`generated_at: not an ISO 8601 date-time with Z or an offset ("${String(fields.generated_at)}")`);

  /** Reads one list section; each entry must reference an object ID of an allowed type when that object is known. */
  const section = (name: string, idField: string, types: string[], max: number | undefined, read: (entry: Record<string, unknown>, at: string) => Record<string, unknown>) => {
    if (fields[name] === undefined || fields[name] === null) return [];
    if (!Array.isArray(fields[name])) { issues.push(`${name}: must be a list`); return []; }
    const entries = fields[name] as unknown[];
    if (max !== undefined && entries.length > max) issues.push(`${name}: has ${entries.length} entries; at most ${max}`);
    return entries.map((raw, index) => {
      const at = `${name}.${index}`;
      const entry = record(raw);
      if (!entry) { issues.push(`${at}: must be an entry with ${idField}`); return {}; }
      const id = text(entry[idField]);
      if (!uuid.test(id)) issues.push(id ? `${at}.${idField}: not an object ID ("${id}")` : `${at}.${idField}: missing`);
      else {
        // An unknown ID is accepted (shown as missing on Today); a known object of the wrong kind is the Agent's mistake.
        const target = ctx.index.get(id);
        if (target && !types.includes(target.frontmatter.type)) issues.push(`${at}.${idField}: ${id} is a ${target.frontmatter.type}, expected ${types.join(" or ")}`);
      }
      return { [idField]: id, ...read(entry, at) };
    });
  };
  const requiredText = (entry: Record<string, unknown>, at: string, key: string) => { const value = text(entry[key]); if (!value) issues.push(`${at}.${key}: missing`); return value; };
  const optionalText = (entry: Record<string, unknown>, key: string) => text(entry[key]) ? { [key]: text(entry[key]) } : {};

  const iOwe = section("i_owe", "task_id", ["task"], undefined, (entry, at) => {
    if (entry.overdue !== undefined && typeof entry.overdue !== "boolean") issues.push(`${at}.overdue: must be true or false`);
    return { overdue: entry.overdue === true };
  });
  const top3 = section("top3", "task_id", ["task"], maxTopThree, (entry, at) => ({ why_today: requiredText(entry, at, "why_today"), ...optionalText(entry, "if_then") }));
  const waiting = section("waiting_and_decisions", "object_id", ["task", "decision", "open-point"], undefined, (entry, at) => {
    const age = entry.age_days;
    if (age !== undefined && !(typeof age === "number" && Number.isInteger(age) && age >= 0)) issues.push(`${at}.age_days: must be a whole number of days`);
    return typeof age === "number" ? { age_days: age } : {};
  });
  const meetingPrep = section("meeting_prep", "meeting_id", ["meeting"], maxMeetingPrep, (entry) => ({ ...optionalText(entry, "context"), ...optionalText(entry, "ask") }));
  const defer = section("defer_candidates", "task_id", ["task"], maxDeferCandidates, (entry, at) => ({ reason: requiredText(entry, at, "reason") }));

  let dayShape: Record<string, number> | undefined;
  if (fields.day_shape !== undefined) {
    const shape = record(fields.day_shape);
    if (!shape) issues.push("day_shape: must have meeting_hours and free_hours");
    else {
      dayShape = {};
      for (const key of ["meeting_hours", "free_hours"]) {
        if (typeof shape[key] === "number" && shape[key] >= 0) dayShape[key] = shape[key] as number;
        else issues.push(`day_shape.${key}: ${shape[key] === undefined ? "missing" : "must be a number of hours"}`);
      }
    }
  }
  const words = draft.body.trim().split(/\s+/).filter(Boolean).length;
  if (words > maxBriefWords) issues.push(`body: the brief is ${words} words; keep it to about 300 so it fits one screen`);
  if (issues.length) throw new DraftError(issues);

  // Briefs adopted earlier in this batch are not in the index yet; the rebuild below keeps the next one honest.
  const others = ctx.index.all().filter((object) => object.frontmatter.type === "daily-focus" && isLive(object) && dateText(object.frontmatter.focus_on) === focusOn);
  const newer = others.filter((object) => String(object.frontmatter.generated_at ?? "") > generatedAt!).sort((left, right) => String(right.frontmatter.generated_at).localeCompare(String(left.frontmatter.generated_at)))[0];
  const id = uuidV7();
  await ctx.objects.write({
    relativePath: `daily-focus/${markdownFileName(draft.title, id, run.now)}`,
    frontmatter: {
      ...ctx.envelope(id, "daily-focus", draft.title, run.now, draft.origin), captured_at: draft.capturedAt,
      focus_on: focusOn, generated_at: generatedAt, i_owe: iOwe, top3, waiting_and_decisions: waiting, meeting_prep: meetingPrep,
      ...(dayShape ? { day_shape: dayShape } : {}), defer_candidates: defer,
      ...(newer ? { archived_at: run.now, superseded_by_id: newer.frontmatter.id } : {})
    },
    body: draft.body.trim() ? `${draft.body.trim()}\n` : ""
  });
  if (!newer) {
    for (const older of others) {
      await ctx.update(older, { archived_at: run.now, superseded_by_id: id }, { expectedHash: older.contentHash, now: run.now });
      await ctx.writeAudit("daily-focus.superseded", older.frontmatter.id, run.now, { superseded_by: id, focus_on: focusOn }, { type: "agent", ref: run.id });
    }
  }
  await ctx.rebuildIndex();
  return [id];
}

export class DailyFocusModule {
  constructor(private readonly ctx: AppContext, private readonly inbox?: InboxStore) {}

  /**
   * Today's brief with live status. `ruleTopThree` is the deterministic Top 3 (priority, then due
   * date), used when no brief exists. `now` decides which meetings are past.
   */
  view(date: string, ruleTopThree: Array<{ task: LifeOSObject; reason: string }>, now = new Date()): DailyFocusView {
    const brief = currentBrief(this.ctx, date);
    const hidden = { count: 0 };
    const items = (field: string, idField: string, extra: (entry: Record<string, unknown>) => Partial<FocusItem>, sink = true) => this.items(brief, field, idField, extra, now, hidden, sink);
    const shape = record(brief?.frontmatter.day_shape);
    const view: DailyFocusView = {
      date,
      ...(brief ? { brief: { id: brief.frontmatter.id, title: brief.frontmatter.title, path: brief.relativePath, generatedAt: String(brief.frontmatter.generated_at ?? brief.frontmatter.created_at), body: brief.body } } : {}),
      iOwe: items("i_owe", "task_id", (entry) => ({ overdue: entry.overdue === true })).map((item) => ({ ...item, overdue: item.overdue || this.dueBefore(item.object, date) })),
      ...this.effectiveTopThree(brief, ruleTopThree, now, hidden),
      waitingAndDecisions: items("waiting_and_decisions", "object_id", (entry) => typeof entry.age_days === "number" ? { ageDays: entry.age_days } : {}),
      // Meetings keep their (chronological) order; past ones are marked, not sunk.
      meetingPrep: items("meeting_prep", "meeting_id", (entry) => ({ ...(text(entry.context) ? { context: text(entry.context) } : {}), ...(text(entry.ask) ? { ask: text(entry.ask) } : {}) }), false),
      ...(shape && typeof shape.meeting_hours === "number" && typeof shape.free_hours === "number" ? { dayShape: { meetingHours: shape.meeting_hours, freeHours: shape.free_hours } } : {}),
      deferCandidates: items("defer_candidates", "task_id", (entry) => ({ reason: text(entry.reason) })),
      restrictedHidden: 0
    };
    view.restrictedHidden = hidden.count;
    return view;
  }

  /**
   * The effective Top 3. Seam for Focus Overrides (#47): apply the date's override to the brief's
   * entries here. With no brief, the deterministic rule applies with its visible reason.
   */
  effectiveTopThree(brief: LifeOSObject | undefined, ruleTopThree: Array<{ task: LifeOSObject; reason: string }>, now: Date, hidden = { count: 0 }): Pick<DailyFocusView, "top3" | "top3Source"> {
    if (brief) return { top3Source: "brief", top3: this.items(brief, "top3", "task_id", (entry) => ({ whyToday: text(entry.why_today), ...(text(entry.if_then) ? { ifThen: text(entry.if_then) } : {}) }), now, hidden) };
    return { top3Source: "rule", top3: ruleTopThree.filter(({ task }) => !isRestricted(task)).map(({ task, reason }) => ({ ...this.live(task.frontmatter.id, now), whyToday: reason })) };
  }

  /**
   * "Refresh": asks Claude to re-plan the date by writing a `replan` Work Order to `_inbox/requests/`.
   * A replan for the same date still waiting there is returned instead of writing a second one.
   * The Work Order names only the date and the current brief; restricted briefs are never named.
   */
  async requestReplan(date: string, options: { now?: Date } = {}): Promise<ReplanRequest> {
    if (!isCalendarDate(date)) throw new Error(`Not a calendar date YYYY-MM-DD: "${date}"`);
    if (!this.inbox) throw new Error("The inbox folder is not configured, so no Work Order can be written");
    await this.inbox.ensureFolders();
    for (const file of await this.inbox.list("requests")) {
      const document = await this.inbox.read("requests", file.name).catch(() => undefined);
      if (document?.frontmatter?.kind === "replan" && dateText(document.frontmatter.focus_on) === date) return { workOrder: file.relativePath, alreadyRequested: true, message: `A re-plan for ${date} is already waiting for Claude` };
    }
    await this.ctx.rebuildIndex();
    const brief = currentBrief(this.ctx, date);
    const now = options.now ?? new Date();
    const id = uuidV7();
    const timestamp = now.toISOString();
    const file = await this.inbox.writeDocument("requests", markdownFileName(`Replan ${date}`, id, timestamp), {
      lifeos_work_order: workOrderContractVersion, kind: "replan", work_order_id: id, requested_at: timestamp, focus_on: date,
      ...(brief ? { current_brief_id: brief.frontmatter.id, current_brief_path: brief.relativePath, current_generated_at: String(brief.frontmatter.generated_at) } : {})
    }, replanBody(date));
    return { workOrder: file.relativePath, alreadyRequested: false, message: `Re-plan requested for ${date}: ask Claude to "run LifeOS replan"` };
  }

  /** One section of the brief with live status. Restricted objects are dropped and counted in `hidden`. */
  private items(brief: LifeOSObject | undefined, field: string, idField: string, extra: (entry: Record<string, unknown>) => Partial<FocusItem>, now: Date, hidden: { count: number }, sink = true) {
    const result: FocusItem[] = [];
    for (const raw of list(brief?.frontmatter[field])) {
      const entry = record(raw);
      const id = text(entry?.[idField]);
      if (!entry || !id) continue;
      const item = this.live(id, now);
      if (item.object && isRestricted(item.object)) { hidden.count += 1; continue; }
      result.push({ ...item, ...extra(entry) });
    }
    // Finished and missing entries sink; the rest keep the brief's order (sort is stable).
    return sink ? result.sort((left, right) => Number(left.state !== "open") - Number(right.state !== "open")) : result;
  }

  /** Live status of one referenced object. Deleted, archived or unknown objects are `missing`, never an error. */
  private live(id: string, now: Date): FocusItem {
    const object = this.ctx.index.get(id);
    if (!object || !isLive(object)) return { id, state: "missing" };
    const { frontmatter } = object;
    const status = String(frontmatter.status ?? "");
    let state: FocusItemState = "open";
    if (frontmatter.type === "task") state = status === "Done" ? "done" : status === "Cancelled" ? "cancelled" : "open";
    else if (frontmatter.type === "open-point") state = status === "resolved" ? "done" : status === "closed" ? "cancelled" : "open";
    else if (frontmatter.type === "decision") state = status === "active" ? "open" : "done";
    else if (frontmatter.type === "meeting") state = status === "cancelled" ? "cancelled" : Date.parse(String(frontmatter.ends_at)) <= now.getTime() ? "past" : "open";
    return { id, state, object };
  }

  private dueBefore(task: LifeOSObject | undefined, date: string) {
    const due = typeof task?.frontmatter.due_on === "string" ? task.frontmatter.due_on : typeof task?.frontmatter.due_at === "string" ? task.frontmatter.due_at.slice(0, 10) : undefined;
    return Boolean(due && due < date && task?.frontmatter.status !== "Done" && task?.frontmatter.status !== "Cancelled");
  }
}

function replanBody(date: string) {
  return `# Replan ${date}\n\nThe user asked for a fresh Daily Focus for ${date}.\n\n` +
    "- Re-read the Agent Index and today's calendar; things may have been done or moved since the last brief.\n" +
    `- Write a new \`daily-focus\` Inbox Draft to \`_inbox/drafts/\` with \`focus_on: ${date}\`, a new \`draft_key\` and the current \`generated_at\`. The newer brief replaces the older one.\n` +
    "- Never read or include files marked `sensitivity: restricted`.\n" +
    "- When done, move this file to `_inbox/processed/`.\n";
}
