// Today (#68): the home page, moved out of the App component. App still loads the data and owns the
// actions (they refresh every page); this module only lays them out.
import React, { useState } from "react";
import { LockBadge } from "./EnvelopeBadges.js";
import { formatTime } from "./dateFormat.js";
import { PageHeader, Summary, objectRow } from "./pageParts.js";
import type { TodaySettings } from "./SettingsPage.js";
import { awaitingAdoptionLabel, daysBetween } from "./todayPanels.js";
import { SelfEmailWarning, type SetupWarning } from "./SelfEmailWarning.js";
import { CappedRows, GiveUpRow, LivePanel, WaitingGroupRow, type WaitingGroup } from "./TodayLists.js";

type LifeObject = { frontmatter: Record<string, unknown> & { id: string; title: string; type: string; status?: string; revision: number; created_at: string; updated_at: string }; body: string; relativePath: string; contentHash: string };
type FocusItem = { id: string; state: "open" | "done" | "cancelled" | "past" | "missing"; object?: LifeObject; overdue?: boolean; whyToday?: string; ifThen?: string; ageDays?: number; context?: string; ask?: string; reason?: string; pinned?: boolean; replaces?: { id: string; title: string } };
export type FocusChange = { action: "pin" | "unpin" | "replace" | "dismiss" | "restore" | "reset"; taskId?: string; replacementId?: string };
export type DailyFocus = { date: string; brief?: { id: string; title: string; path: string; generatedAt: string; body: string; lengthWarning?: string }; iOwe: FocusItem[]; top3: FocusItem[]; top3Source: "brief" | "rule"; maxMustDos: number; override?: { contentHash: string }; dismissedTop3: FocusItem[]; waitingAndDecisions: FocusItem[]; meetingPrep: FocusItem[]; dayShape?: { meetingHours: number; freeHours: number }; deferCandidates: FocusItem[]; restrictedHidden: number };
export type Today = { tasks: LifeObject[]; overdue: LifeObject[]; dueToday: LifeObject[]; upcoming: LifeObject[]; waiting: LifeObject[]; topThree: Array<{ task: LifeObject; reason: string }>; reviewCount: number; focus?: DailyFocus };
/** #48: Today's live panels, computed by the server on each load (never from the brief). */
export type TodayPanels = {
  date: string; overdue: LifeObject[]; dueToday: LifeObject[]; upcomingHighPriority: LifeObject[];
  waitingByPerson: Array<WaitingGroup & { tasks: LifeObject[] }>;
  nextMeetings: Array<{ title: string; startsAt: string; endsAt: string; inProgress: boolean; meetingId?: string; noteId?: string; calendarEventId?: string; calendarName?: string; restricted: boolean }>;
  meetingHours: number; meetingHeavy: boolean; calendarError?: string;
  openPointsForMeetings: Array<{ openPoint: LifeObject; meetingId: string; meetingTitle: string; link: "raised-in" | "project" | "client" | "people" }>;
  reviewCount: number; inbox: { awaiting: number; drafts: number; patches: number }; failedDrafts: Array<{ path: string; reason: string }>;
  staleWorkOrders: Array<{ path: string; requestedAt: string; ageDays: number }>; settings: TodaySettings;
  /** #76: present while the user's own email addresses are unset. */
  setupWarning?: SetupWarning;
};
export type EnrichmentStatus = { proposedGaveUp: Array<{ meetingId: string; title: string; requestedAt: string }>; staleWorkOrders: Array<{ path: string; requestedAt: string; ageDays: number }> };

type Props = {
  today: Today; panels?: TodayPanels; enrichment: EnrichmentStatus; eventCount: number; capture: string; busy: boolean; readOnly: boolean;
  onCaptureChange: (text: string) => void; onCapture: () => void; onReplan: () => Promise<void>; onChangeFocus: (change: FocusChange) => Promise<void>;
  onEnrich: () => Promise<void>; onGiveUp: (meetingId: string) => Promise<boolean>; onOpenInbox: () => void; onOpenSelfEmails: () => void;
};

export function TodayPage({ today, panels: todayPanels, enrichment, eventCount, capture, busy, readOnly, onCaptureChange, onCapture, onReplan, onChangeFocus, onEnrich, onGiveUp, onOpenInbox, onOpenSelfEmails }: Props) {
  return <>
    <PageHeader eyebrow="HOME / TODAY" title="What needs your attention?" description="A calm view of active work and pending decisions." />
    <SelfEmailWarning warning={todayPanels?.setupWarning} onOpenSettings={onOpenSelfEmails} />
    <div className="summary">
      <Summary label="Active tasks" value={today.tasks.length} detail="across all contexts" />
      <Summary label="Review inbox" value={today.reviewCount} detail="awaiting confirmation" />
      <Summary label="Today's events" value={eventCount} detail="across connected calendars" />
    </div>
    <article className="quick-capture"><span>QUICK CAPTURE</span><div className="capture-row"><input value={capture} onChange={(event) => onCaptureChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && capture.trim()) onCapture(); }} placeholder="Capture a task or commitment…" /><button className="primary" disabled={!capture.trim() || busy || readOnly} onClick={onCapture}>Capture</button></div></article>
    {/* #64: /today always returns `focus`, so the old "Suggested Top 3" fallback could never show. */}
    {today.focus && <DailyFocusPanel focus={today.focus} tasks={today.tasks} disabled={busy || readOnly} onRefresh={() => void onReplan()} onChange={(change) => void onChangeFocus(change)} />}
    <article className="enrichment"><span>AFTER MEETINGS</span><div className="capture-row"><p>Ask Claude to collect transcripts, recordings and Gong material for meetings that ended in the last 48 hours.</p><button className="primary" disabled={busy || readOnly} onClick={() => void onEnrich()}>Enrich last 48h</button></div>
      {/* #48: stale Work Orders moved to the "Inbox and agents" live panel. */}
      <CappedRows items={enrichment.proposedGaveUp} row={(meeting) => <GiveUpRow key={meeting.meetingId} meeting={meeting} disabled={busy || readOnly} onGiveUp={(meetingId) => void onGiveUp(meetingId)} />} /></article>
    {todayPanels ? <TodayLivePanels panels={todayPanels} onOpenInbox={onOpenInbox} /> : <>
      {/* Until the live panels load (or if they fail), the basic lists from /today stand in. */}
      <LivePanel title="Overdue" items={today.overdue} empty="Nothing overdue." row={objectRow} />
      <LivePanel title="Due today" items={today.dueToday} empty="Nothing due today." row={objectRow} />
      <LivePanel title="Waiting" items={today.waiting} empty="Nothing waiting on someone else." row={objectRow} />
    </>}
  </>;
}

/**
 * #46: the morning brief with live status, in the agreed order: I owe → Top 3 → waiting/decisions →
 * meeting prep → day shape. Finished items are struck through (the server already sank them), past
 * meetings are marked, and deleted references show as missing. Without a brief, the rule's Top 3 shows.
 */
function DailyFocusPanel({ focus, tasks, disabled, onRefresh, onChange }: { focus: DailyFocus; tasks: LifeObject[]; disabled: boolean; onRefresh: () => void; onChange: (change: FocusChange) => void }) {
  const stateLabel = { open: "", done: "Done", cancelled: "Cancelled", past: "Past", missing: "Missing: deleted or not found" } as const;
  const row = (item: FocusItem, details: Array<string | undefined>) => <div className={`object-row focus-item ${item.state}`} key={item.id}><i /><div><b>{item.object?.frontmatter.title ?? "Missing item"}{item.object && <LockBadge frontmatter={item.object.frontmatter} />}</b><small>{[stateLabel[item.state], ...details].filter(Boolean).join(" · ")}</small></div></div>;
  const section = (title: string, items: FocusItem[], details: (item: FocusItem) => Array<string | undefined>, empty: string) => <div className="focus-section"><h4>{title}</h4>{items.length ? <CappedRows items={items} row={(item) => row(item, details(item))} /> : <p className="muted">{empty}</p>}</div>;
  const { brief } = focus;
  return <article className="daily-focus">
    <span>DAILY FOCUS</span>
    <div className="capture-row"><p className="muted">{brief ? `Generated at ${formatTime(brief.generatedAt)}` : "No brief for today yet. Top 3 suggested by priority, then due date."}</p><button disabled={disabled} onClick={onRefresh} title="Ask Claude to re-plan today">Refresh</button></div>
    {brief?.lengthWarning && <p className="muted" role="note">Note: {brief.lengthWarning}.</p>}
    {brief && section("I owe", focus.iOwe, (item) => [item.overdue && item.state === "open" ? "Overdue" : undefined], "Nothing owed today.")}
    <TopThreeSection focus={focus} tasks={tasks} disabled={disabled} onChange={onChange} stateLabel={stateLabel} />
    {brief && <>
      {section("Waiting and decisions", focus.waitingAndDecisions, (item) => [item.ageDays !== undefined ? `${item.ageDays} days` : undefined], "Nothing to chase.")}
      {section("Meeting prep", focus.meetingPrep, (item) => [item.object?.frontmatter.starts_at ? formatTime(item.object.frontmatter.starts_at) : undefined, item.context, item.ask ? `Your ask: ${item.ask}` : undefined], "No meetings to prepare.")}
      {focus.dayShape && <div className="focus-section"><h4>Day shape</h4><p>{focus.dayShape.meetingHours} h in meetings · {focus.dayShape.freeHours} h free</p></div>}
      {focus.deferCandidates.length > 0 && section("Consider deferring", focus.deferCandidates, (item) => [item.reason], "")}
      {brief.body.trim() && <p className="focus-narrative">{brief.body.trim()}</p>}
    </>}
    {focus.restrictedHidden > 0 && <p className="muted">{focus.restrictedHidden} restricted {focus.restrictedHidden === 1 ? "item" : "items"} not shown.</p>}
  </article>;
}
/**
 * #47: the effective Top 3 with the user's controls. Every control is a real button or select (keyboard
 * operable, Escape cancels a replace), and "Pinned" / "Replaces …" are written out, never shown by colour alone.
 */
function TopThreeSection({ focus, tasks, disabled, onChange, stateLabel }: { focus: DailyFocus; tasks: LifeObject[]; disabled: boolean; onChange: (change: FocusChange) => void; stateLabel: Record<FocusItem["state"], string> }) {
  const [replacing, setReplacing] = useState<string>();
  const [choice, setChoice] = useState("");
  const [toPin, setToPin] = useState("");
  // Open, non-restricted tasks not already shown: the candidates for Replace and Pin (the server checks again).
  const candidates = tasks.filter((task) => task.frontmatter.sensitivity !== "restricted" && !focus.top3.some((item) => item.id === task.frontmatter.id));
  const title = (item: FocusItem) => item.object?.frontmatter.title ?? "Missing item";
  const cancelReplace = () => { setReplacing(undefined); setChoice(""); };
  const options = <>{candidates.map((task) => <option key={task.frontmatter.id} value={task.frontmatter.id}>{task.frontmatter.title}</option>)}</>;
  return <div className="focus-section top-three">
    <h4>Top 3</h4>
    {!focus.top3.length && <p className="muted">No active commitments to rank.</p>}
    {focus.top3.map((item) => <div key={item.id}>
      <div className={`object-row focus-item ${item.state}`}><i /><div><b>{title(item)}{item.object && <LockBadge frontmatter={item.object.frontmatter} />}</b><small>{[item.pinned ? "Pinned" : undefined, stateLabel[item.state], item.whyToday, item.replaces ? `Replaces "${item.replaces.title}"` : undefined, item.ifThen].filter(Boolean).join(" · ")}</small></div>
        <div className="focus-controls">
          {item.object && <button type="button" aria-pressed={Boolean(item.pinned)} aria-label={`${item.pinned ? "Unpin" : "Pin"} ${title(item)}`} disabled={disabled} onClick={() => onChange({ action: item.pinned ? "unpin" : "pin", taskId: item.id })}>{item.pinned ? "Unpin" : "Pin"}</button>}
          <button type="button" aria-expanded={replacing === item.id} aria-label={`Replace ${title(item)}`} disabled={disabled || !candidates.length} onClick={() => replacing === item.id ? cancelReplace() : (setReplacing(item.id), setChoice(""))}>Replace</button>
          <button type="button" aria-label={`Dismiss ${title(item)} for today`} disabled={disabled} onClick={() => onChange({ action: "dismiss", taskId: item.id })}>Dismiss</button>
        </div>
      </div>
      {replacing === item.id && <div className="capture-row focus-replace" onKeyDown={(event) => { if (event.key === "Escape") cancelReplace(); }}>
        <select autoFocus aria-label={`Task to put in place of ${title(item)}`} value={choice} onChange={(event) => setChoice(event.target.value)}><option value="">Choose a task…</option>{options}</select>
        <button type="button" className="primary" disabled={disabled || !choice} onClick={() => { onChange({ action: "replace", taskId: item.id, replacementId: choice }); cancelReplace(); }}>Replace</button>
        <button type="button" onClick={cancelReplace}>Cancel</button>
      </div>}
    </div>)}
    {focus.top3.length < focus.maxMustDos && candidates.length > 0 && <div className="capture-row focus-pin">
      <select aria-label="Task to pin to today's Top 3" value={toPin} disabled={disabled} onChange={(event) => setToPin(event.target.value)}><option value="">Add a task to today's Top 3…</option>{options}</select>
      <button type="button" disabled={disabled || !toPin} onClick={() => { onChange({ action: "pin", taskId: toPin }); setToPin(""); }}>Pin</button>
    </div>}
    {focus.dismissedTop3.length > 0 && <div className="focus-dismissed"><small>Dismissed for today</small>
      <CappedRows items={focus.dismissedTop3} row={(item) => <div className="object-row" key={item.id}><div><b>{title(item)}</b></div><button type="button" aria-label={`Restore ${title(item)} to today's Top 3`} disabled={disabled} onClick={() => onChange({ action: "restore", taskId: item.id })}>Restore</button></div>} />
    </div>}
    {focus.override && <button type="button" className="link-button" disabled={disabled} onClick={() => onChange({ action: "reset" })}>Clear my Top 3 changes for today</button>}
  </div>;
}
const dueText = (task: LifeObject) => typeof task.frontmatter.due_on === "string" ? task.frontmatter.due_on : typeof task.frontmatter.due_at === "string" ? task.frontmatter.due_at.slice(0, 10) : undefined;
const openPointLinkText = { "raised-in": "Raised in", project: "Same project as", client: "Same client as", people: "Same people as" } as const;

/** #48: Today's live panels, in the PRD's order. Status is always said in words, never by colour alone. */
function TodayLivePanels({ panels, onOpenInbox }: { panels: TodayPanels; onOpenInbox: () => void }) {
  const taskRow = (detail: (task: LifeObject) => string) => (task: LifeObject) => <div className="object-row" key={task.frontmatter.id}><i /><div><b>{task.frontmatter.title}<LockBadge frontmatter={task.frontmatter} /></b><small>{detail(task)}</small></div></div>;
  const overdueBy = (task: LifeObject) => { const due = dueText(task); const days = due ? daysBetween(due, panels.date) : 0; return `Overdue by ${days} ${days === 1 ? "day" : "days"} · due ${due}`; };
  const meetingTime = (meeting: TodayPanels["nextMeetings"][number]) => `${formatTime(meeting.startsAt)}–${formatTime(meeting.endsAt)}`;
  const inboxRows = [
    { key: "reviews", text: `${panels.reviewCount} review ${panels.reviewCount === 1 ? "item" : "items"} awaiting confirmation` },
    { key: "awaiting", text: awaitingAdoptionLabel(panels.inbox) },
    ...panels.failedDrafts.map((entry) => ({ key: `failed:${entry.path}`, text: `Failed draft: ${entry.reason}`, path: entry.path })),
    ...panels.staleWorkOrders.map((order) => ({ key: `stale:${order.path}`, text: `Stale Work Order: not processed for ${order.ageDays} days`, path: order.path }))
  ];
  return <>
    <LivePanel title="Overdue" items={panels.overdue} empty="Nothing overdue." row={taskRow(overdueBy)} />
    <LivePanel title="Due today" items={panels.dueToday} empty="Nothing due today." row={taskRow((task) => `Due today${task.frontmatter.priority ? ` · ${String(task.frontmatter.priority)} priority` : ""}`)} />
    <LivePanel title="Upcoming high priority" items={panels.upcomingHighPriority} empty="No upcoming high-priority work." row={taskRow((task) => `High priority · ${dueText(task) ? `due ${dueText(task)}` : "no due date"}`)} />
    <LivePanel title="Waiting by person" items={panels.waitingByPerson} empty="Nothing waiting on someone else." row={(group) => <WaitingGroupRow key={group.personId ?? "unknown"} group={group} />} />
    <LivePanel title="Next meetings" items={panels.nextMeetings} empty={panels.calendarError ? "No meetings found in LifeOS for the rest of today." : "No more meetings today."}
      note={<>{panels.calendarError && <p className="muted" role="status">Calendar could not be read ({panels.calendarError}); showing meetings already in LifeOS.</p>}<p className="muted">{panels.meetingHours} h of meetings today{panels.meetingHeavy ? ` · Meeting-heavy day (${panels.settings.meetingHoursThreshold} h or more)` : ""}</p></>}
      row={(meeting) => <div className="object-row" key={meeting.meetingId ?? meeting.calendarEventId}><i /><div><b>{meeting.title}{meeting.restricted && <LockBadge frontmatter={{ sensitivity: "restricted" }} />}</b><small>{[meeting.inProgress ? "Now" : undefined, meetingTime(meeting), meeting.calendarName, meeting.noteId ? "Has notes" : undefined].filter(Boolean).join(" · ")}</small></div></div>} />
    <LivePanel title="Open points for today's meetings" items={panels.openPointsForMeetings} empty="No open points linked to today's meetings."
      row={(entry) => <div className="object-row" key={entry.openPoint.frontmatter.id}><i /><div><b>{entry.openPoint.frontmatter.title}<LockBadge frontmatter={entry.openPoint.frontmatter} /></b><small>{[`${openPointLinkText[entry.link]} ${entry.meetingTitle}`, entry.openPoint.frontmatter.importance ? `${String(entry.openPoint.frontmatter.importance)} importance` : undefined].filter(Boolean).join(" · ")}</small></div></div>} />
    <LivePanel title="Inbox and agents" items={inboxRows} empty="" note={<button type="button" onClick={onOpenInbox}>Open Inbox</button>}
      row={(entry) => <div className="object-row" key={entry.key}><i /><div><b>{entry.text}</b>{"path" in entry && entry.path && <small><code>{entry.path}</code></small>}</div></div>} />
  </>;
}
