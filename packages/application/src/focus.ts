import { uuidV7, type LifeOSObject, type ObjectEnvelope } from "@lifeos/domain";
import { DraftError, isCalendarDate, text, toUtc, type AdoptionRun, type ParsedDraft } from "./adoption.js";
import { markdownFileName, ObjectConflictError, type AppContext } from "./context.js";
import { workOrderContractVersion } from "./enrichment.js";
import type { InboxStore } from "./ports.js";
import { isLive, isRestricted, objectIdPattern } from "./support.js";

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
/** Max must-dos (PRD "Settings"): how many items the effective Top 3 shows. A synced app-setting (ADR 0005). */
export const defaultMaxMustDos = maxTopThree;
export const maxMustDosLimit = 5;
export const focusSettingsPath = "settings/daily-focus.md";
/** #47: what the user can do to one date's Top 3. `restore` un-dismisses; `reset` clears every choice for the date. */
export const focusOverrideActions = ["pin", "unpin", "replace", "dismiss", "restore", "reset"] as const;
export type FocusOverrideAction = typeof focusOverrideActions[number];
export interface FocusOverrideChange { action: unknown; taskId?: unknown; replacementId?: unknown }
/** The date's Focus Override as Today reads it; `contentHash` is the expected hash for the next change. */
export interface FocusOverrideState { id: string; path: string; contentHash: string; pinned: string[]; replaced: Array<{ from: string; to: string }>; dismissed: string[] }
type RuleCandidate = { task: LifeOSObject; reason: string };
/**
 * One fixed-path file per date, like the ADR 0005 settings: two devices changing the same day before
 * Drive syncs write the same file (the second save gets a 409) instead of two competing overrides.
 */
const overridePath = (date: string) => `focus-overrides/${date}.md`;
/** "About 300 words": a little slack before a brief is flagged as too long for one screen (it is still adopted). */
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
  /** #47: the user pinned this item for the day. */
  pinned?: boolean;
  /** #47: the user put this task in the slot of another Top 3 item. */
  replaces?: { id: string; title: string };
}
export interface DailyFocusView {
  /** The calendar date shown (the user's local date). */
  date: string;
  brief?: { id: string; title: string; path: string; generatedAt: string; body: string; lengthWarning?: string };
  iOwe: FocusItem[];
  /** The effective Top 3: the brief's, or the deterministic rule's when there is no brief. */
  top3: FocusItem[];
  top3Source: "brief" | "rule";
  /** #47: the max must-dos setting (default 3); the effective Top 3 never has more items. */
  maxMustDos: number;
  /** #47: the user's choices for the date, when any were saved. */
  override?: FocusOverrideState;
  /** #47: tasks dismissed from the date's Top 3, so they can be restored. Restricted ones are left out. */
  dismissedTop3: FocusItem[];
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

const dateText = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : text(value);
const list = (value: unknown) => Array.isArray(value) ? value as unknown[] : [];
const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The live brief for a date: the newest `generated_at` among the date's non-archived, non-restricted briefs. */
function currentBrief(ctx: AppContext, date: string) {
  return ctx.index.all()
    .filter((object) => object.frontmatter.type === "daily-focus" && isLive(object) && dateText(object.frontmatter.focus_on) === date && !isRestricted(object))
    .sort((left, right) => String(right.frontmatter.generated_at ?? "").localeCompare(String(left.frontmatter.generated_at ?? "")))[0];
}

function overrideState(object: LifeOSObject | undefined): FocusOverrideState | undefined {
  if (!object) return undefined;
  const ids = (value: unknown) => [...new Set(list(value).map(text).filter((id) => objectIdPattern.test(id)))];
  const replaced = list(object.frontmatter.replaced).map(record).map((entry) => ({ from: text(entry?.from), to: text(entry?.to) })).filter((entry) => objectIdPattern.test(entry.from) && objectIdPattern.test(entry.to));
  return { id: object.frontmatter.id, path: object.relativePath, contentHash: object.contentHash, pinned: ids(object.frontmatter.pinned), replaced, dismissed: ids(object.frontmatter.dismissed) };
}

/** The max must-dos setting from front matter; a missing or hand-edited invalid value falls back to the default. */
function maxMustDosOf(frontmatter: Record<string, unknown> | undefined) {
  const value = frontmatter?.max_must_dos;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maxMustDosLimit ? value : defaultMaxMustDos;
}

async function readIfPresent(ctx: AppContext, relativePath: string) {
  try { return await ctx.objects.read(relativePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
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
      if (!objectIdPattern.test(id)) issues.push(id ? `${at}.${idField}: not an object ID ("${id}")` : `${at}.${idField}: missing`);
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
  // Up to the highest max must-dos a user can choose; Today shows only as many as the current setting allows,
  // so a brief is never lost because the setting is lower than its Top 3.
  const top3 = section("top3", "task_id", ["task"], maxMustDosLimit, (entry, at) => ({ why_today: requiredText(entry, at, "why_today"), ...optionalText(entry, "if_then") }));
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
  // An over-long brief is still adopted, so a wordy routine never costs the user their morning; Today shows the warning.
  const lengthWarning = words > maxBriefWords ? `The brief is ${words} words; aim for about 300 so it fits one screen` : undefined;
  if (issues.length) throw new DraftError(issues);

  // Briefs adopted earlier in this batch are not in the index yet; the rebuild below keeps the next one honest.
  const others = ctx.index.all().filter((object) => object.frontmatter.type === "daily-focus" && isLive(object) && dateText(object.frontmatter.focus_on) === focusOn);
  const newer = others.filter((object) => String(object.frontmatter.generated_at ?? "") > generatedAt!).sort((left, right) => String(right.frontmatter.generated_at).localeCompare(String(left.frontmatter.generated_at)))[0];
  const id = run.newId("main");
  await ctx.objects.write({
    relativePath: `daily-focus/${markdownFileName(draft.title, id, run.now)}`,
    frontmatter: {
      ...ctx.envelope(id, "daily-focus", draft.title, run.now, draft.origin), captured_at: draft.capturedAt,
      focus_on: focusOn, generated_at: generatedAt, i_owe: iOwe, top3, waiting_and_decisions: waiting, meeting_prep: meetingPrep,
      ...(dayShape ? { day_shape: dayShape } : {}), defer_candidates: defer, ...(lengthWarning ? { length_warning: lengthWarning } : {}),
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
  view(date: string, ruleCandidates: RuleCandidate[], now = new Date()): DailyFocusView {
    const brief = currentBrief(this.ctx, date);
    const override = overrideState(this.ctx.index.all().find((object) => object.relativePath === overridePath(date) && object.frontmatter.type === "focus-override"));
    const maxMustDos = this.maxMustDos();
    const hidden = { count: 0 };
    const items = (field: string, idField: string, extra: (entry: Record<string, unknown>) => Partial<FocusItem>, sink = true) => this.items(brief, field, idField, extra, now, hidden, sink);
    const shape = record(brief?.frontmatter.day_shape);
    const view: DailyFocusView = {
      date,
      ...(brief ? { brief: { id: brief.frontmatter.id, title: brief.frontmatter.title, path: brief.relativePath, generatedAt: String(brief.frontmatter.generated_at ?? brief.frontmatter.created_at), body: brief.body, ...(typeof brief.frontmatter.length_warning === "string" ? { lengthWarning: brief.frontmatter.length_warning } : {}) } } : {}),
      iOwe: items("i_owe", "task_id", (entry) => ({ overdue: entry.overdue === true })).map((item) => ({ ...item, overdue: item.overdue || this.dueBefore(item.object, date) })),
      ...this.effectiveTopThree(brief, ruleCandidates, now, hidden, override, maxMustDos),
      maxMustDos,
      ...(override ? { override } : {}),
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
   * The effective Top 3 (#47): the brief's `top3`, or with no brief the deterministic rule's ranking,
   * with the date's Focus Override applied: pinned tasks first (in pin order), each replaced task's
   * slot given to its replacement, dismissed tasks left out, then cut to the max must-dos. With a
   * brief, a freed slot stays empty (the user can replace instead); the rule simply ranks the next
   * task. Restricted tasks never appear, whoever chose them; they are counted in `hidden`.
   */
  effectiveTopThree(brief: LifeOSObject | undefined, ruleCandidates: RuleCandidate[], now: Date, hidden = { count: 0 }, override?: Pick<FocusOverrideState, "pinned" | "replaced" | "dismissed">, max = defaultMaxMustDos): Pick<DailyFocusView, "top3" | "top3Source" | "dismissedTop3"> {
    const base = brief
      ? this.items(brief, "top3", "task_id", (entry) => ({ whyToday: text(entry.why_today), ...(text(entry.if_then) ? { ifThen: text(entry.if_then) } : {}) }), now, hidden, false)
      : ruleCandidates.filter(({ task }) => !isRestricted(task)).map(({ task, reason }) => ({ ...this.live(task.frontmatter.id, now), whyToday: reason }));
    const { pinned = [], replaced = [], dismissed = [] } = override ?? {};
    // A restricted brief entry was already counted by `items`; count each other restricted choice once.
    const counted = new Set(list(brief?.frontmatter.top3).map((entry) => text(record(entry)?.task_id)));
    const chosen = (id: string, extra: Partial<FocusItem>): FocusItem | undefined => {
      const item = this.live(id, now);
      if (!item.object) return undefined;
      if (isRestricted(item.object)) { if (!counted.has(id)) { counted.add(id); hidden.count += 1; } return undefined; }
      return { ...item, ...extra };
    };
    const result: FocusItem[] = [];
    const add = (item: FocusItem | undefined) => { if (item && !dismissed.includes(item.id) && !result.some((other) => other.id === item.id)) result.push(item); };
    for (const id of pinned) {
      const fromBase = base.find((item) => item.id === id && item.object);
      add(fromBase ? { ...fromBase, pinned: true } : chosen(id, { whyToday: "Pinned by you", pinned: true }));
    }
    for (const item of base) {
      const to = replaced.find((entry) => entry.from === item.id)?.to;
      add(to ? chosen(to, { whyToday: "Your choice", replaces: { id: item.id, title: item.object?.frontmatter.title ?? "Missing item" } }) : item);
    }
    // Finished and missing entries sink; the rest keep their order (sort is stable).
    const top3 = result.slice(0, max).sort((left, right) => Number(left.state !== "open") - Number(right.state !== "open"));
    const dismissedTop3 = dismissed.map((id) => this.live(id, now)).filter((item) => item.object && !isRestricted(item.object));
    return { top3Source: brief ? "brief" : "rule", top3, dismissedTop3 };
  }

  /**
   * Applies one pin, unpin, replace, dismiss, restore or reset to the date's Focus Override and
   * returns the new view. A guarded save: `expectedHash` must match the override on disk (none when
   * there is no override yet), so a change made first on another device is a conflict (409), never
   * silently merged. A change that alters nothing writes nothing.
   */
  async changeOverride(date: string, change: FocusOverrideChange, expectedHash: string | undefined, ruleCandidates: RuleCandidate[], options: { now?: Date } = {}): Promise<DailyFocusView> {
    if (!isCalendarDate(date)) throw new Error(`Not a calendar date YYYY-MM-DD: "${date}"`);
    const action = text(change.action) as FocusOverrideAction;
    if (!focusOverrideActions.includes(action)) throw new Error("action: must be pin, unpin, replace, dismiss, restore or reset");
    const taskId = action === "reset" ? "" : this.idOf(change.taskId, "taskId");
    const now = options.now ?? new Date();
    const current = await readIfPresent(this.ctx, overridePath(date));
    if (current && current.contentHash !== expectedHash) throw new ObjectConflictError("Today's Top 3 was changed on another device; the latest is loaded, make your change again");
    if (!current && expectedHash) throw new ObjectConflictError("Today's Top 3 changes were removed on another device; the latest is loaded, make your change again");
    const state = overrideState(current) ?? { pinned: [], replaced: [], dismissed: [] };
    const max = this.maxMustDos();
    const effective = this.effectiveTopThree(currentBrief(this.ctx, date), ruleCandidates, now, { count: 0 }, state, max).top3.map((item) => item.id);
    const label = (id: string) => { const object = this.ctx.index.get(id); return object && !isRestricted(object) ? `"${object.frontmatter.title}"` : id; };
    const inTopThree = (id: string) => { if (!effective.includes(id)) throw new Error(`${label(id)} is not in today's Top 3`); };
    const without = (ids: string[], id: string) => ids.filter((other) => other !== id);
    let pinned = [...state.pinned];
    let replaced = state.replaced.map((entry) => ({ ...entry }));
    let dismissed = [...state.dismissed];

    if (action === "pin") {
      this.pickable(taskId);
      if (!pinned.includes(taskId)) {
        if (!effective.includes(taskId) && effective.length >= max) throw new Error(`The Top 3 is full (${max} must-dos): dismiss or replace one first`);
        pinned.push(taskId);
        dismissed = without(dismissed, taskId);
      }
    } else if (action === "unpin") pinned = without(pinned, taskId);
    else if (action === "dismiss") { inTopThree(taskId); dismissed = [...without(dismissed, taskId), taskId]; pinned = without(pinned, taskId); }
    else if (action === "restore") dismissed = without(dismissed, taskId);
    else if (action === "reset") { pinned = []; replaced = []; dismissed = []; }
    else {
      inTopThree(taskId);
      const to = this.idOf(change.replacementId, "replacementId");
      const target = this.pickable(to);
      if (["Done", "Cancelled"].includes(String(target.frontmatter.status))) throw new Error(`Only an open task can replace a Top 3 item; ${label(to)} is ${String(target.frontmatter.status)}`);
      if (effective.includes(to)) throw new Error(`${label(to)} is already in today's Top 3`);
      // Replacing a replacement keeps the original slot: A → B then B → C is stored as A → C, and A → B → A as nothing.
      const earlier = replaced.find((entry) => entry.to === taskId);
      if (earlier) earlier.to = to;
      else replaced.push({ from: taskId, to });
      replaced = replaced.filter((entry) => entry.from !== entry.to);
      pinned = pinned.map((id) => id === taskId ? to : id);
      dismissed = without(dismissed, to);
    }

    if (JSON.stringify([pinned, replaced, dismissed]) !== JSON.stringify([state.pinned, state.replaced, state.dismissed])) {
      const fields = { focus_on: date, pinned, replaced, dismissed };
      const timestamp = now.toISOString();
      if (current) await this.ctx.update(current, fields, { expectedHash, now: timestamp });
      else await this.ctx.objects.write({
        relativePath: overridePath(date),
        frontmatter: { ...this.ctx.envelope(uuidV7(), "focus-override", `Focus Override ${date}`, timestamp), ...fields } as ObjectEnvelope,
        body: `# Focus Override ${date}\n\nYour changes to this day's Top 3 (pinned, replaced and dismissed task IDs). Only LifeOS writes this file; a newer morning brief never changes it.\n`
      });
      await this.ctx.rebuildIndex();
    }
    return this.view(date, ruleCandidates, now);
  }

  /** The max must-dos setting, with the hash for a guarded save (none until it is first saved). */
  async settings(): Promise<{ maxMustDos: number; contentHash?: string }> {
    const current = await readIfPresent(this.ctx, focusSettingsPath);
    return { maxMustDos: maxMustDosOf(current?.frontmatter), ...(current ? { contentHash: current.contentHash } : {}) };
  }

  async saveSettings(input: { maxMustDos?: unknown }, expectedHash?: string) {
    const value = input.maxMustDos;
    if (!(typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maxMustDosLimit)) throw new Error(`Max must-dos must be a whole number from 1 to ${maxMustDosLimit}`);
    const current = await readIfPresent(this.ctx, focusSettingsPath);
    if (current && current.contentHash !== expectedHash) throw new ObjectConflictError("The Daily Focus settings changed on another device; reload and try again");
    if (!current && expectedHash) throw new ObjectConflictError("The Daily Focus settings were removed; reload and try again");
    const now = new Date().toISOString();
    const written = await this.ctx.objects.write({
      relativePath: focusSettingsPath,
      expectedHash: current?.contentHash,
      frontmatter: {
        ...current?.frontmatter,
        ...(current ? { revision: current.frontmatter.revision + 1, updated_at: now, updated_by_device: this.ctx.deviceId } : this.ctx.envelope(uuidV7(), "app-setting", "Daily Focus", now)),
        setting_key: "daily-focus",
        max_must_dos: value
      } as ObjectEnvelope,
      body: current?.body ?? "# Daily Focus\n\n`max_must_dos`: how many must-dos Today's Top 3 shows (1 to 5, default 3).\n"
    });
    await this.ctx.rebuildIndex();
    return { maxMustDos: value, contentHash: written.contentHash };
  }

  private maxMustDos() {
    return maxMustDosOf(this.ctx.index.all().find((object) => object.relativePath === focusSettingsPath && object.frontmatter.type === "app-setting")?.frontmatter);
  }

  private idOf(value: unknown, field: string) {
    const id = text(value);
    if (!id) throw new Error(`${field}: missing`);
    if (!objectIdPattern.test(id)) throw new Error(`${field}: not an object ID ("${id}")`);
    return id;
  }

  /** A task the user may put in the Top 3: live, a task, never restricted (ADR 0010). */
  private pickable(id: string) {
    const object = this.ctx.index.get(id);
    if (!object || object.frontmatter.type !== "task" || !isLive(object)) throw new Error(`Task not found: ${id}`);
    if (isRestricted(object)) throw new Error("Restricted tasks never appear in the Top 3");
    return object;
  }

  /**
   * "Refresh": asks Claude to re-plan the date by writing a `replan` Work Order to `_inbox/requests/`.
   * A replan for the same date still waiting there is returned instead of writing a second one.
   * The Work Order names only the date and the current brief; restricted briefs are never named. A waiting
   * replan that names a brief restricted since it was written is rewritten without it (#63).
   */
  async requestReplan(date: string, options: { now?: Date } = {}): Promise<ReplanRequest> {
    if (!isCalendarDate(date)) throw new Error(`Not a calendar date YYYY-MM-DD: "${date}"`);
    if (!this.inbox) throw new Error("The inbox folder is not configured, so no Work Order can be written");
    await this.inbox.ensureFolders();
    await this.ctx.rebuildIndex();
    for (const file of await this.inbox.list("requests")) {
      const document = await this.inbox.read("requests", file.name).catch(() => undefined);
      const fields = document?.frontmatter;
      if (fields?.kind !== "replan" || dateText(fields.focus_on) !== date) continue;
      if (isRestricted(this.ctx.index.get(text(fields.current_brief_id)))) {
        const { current_brief_id: _id, current_brief_path: _path, current_generated_at: _generated, ...rest } = fields;
        await this.inbox.writeDocument("requests", file.name, rest, document!.body);
      }
      return { workOrder: file.relativePath, alreadyRequested: true, message: `A re-plan for ${date} is already waiting for Claude` };
    }
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
