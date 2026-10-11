// Today (#132): priority-first composition. Data and mutations stay owned by App; this module keeps
// the effective Top 3, next meeting and capture visually primary while preserving existing workflows.
import React, { useState } from "react";
import { LockBadge } from "./EnvelopeBadges.js";
import { formatTime } from "./dateFormat.js";
import { PageHeader, Summary, objectRow } from "./pageParts.js";
import { awaitingAdoptionLabel, daysBetween } from "./todayPanels.js";
import { SelfEmailWarning } from "./SelfEmailWarning.js";
import { BackupWarning } from "./BackupWarning.js";
import { CalendarOfflineBanner } from "./CalendarOffline.js";
import { CappedRows, GiveUpRow, LivePanel, WaitingGroupRow } from "./TodayLists.js";
import type { DailyFocus, EnrichmentStatus, FocusChange, FocusItem, LifeObject, NextMeeting, Today, TodayPanels } from "@lifeos/contracts";

type Props = {
  today: Today; panels?: TodayPanels; enrichment: EnrichmentStatus; eventCount: number; capture: string; busy: boolean; readOnly: boolean; loading?: boolean;
  onCaptureChange: (text: string) => void; onCapture: () => void; onReplan: () => Promise<void>; onChangeFocus: (change: FocusChange) => Promise<void>;
  onEnrich: () => Promise<void>; onGiveUp: (meetingId: string) => Promise<boolean>; onOpenInbox: () => void; onOpenSettingsCard: (cardId: string) => void; onBackUpNow?: () => void;
  onCompleteTask?: (task: LifeObject) => Promise<unknown>; onOpenTasks?: () => void; onOpenCalendar?: () => void;
  timeZone?: string; onRetryCalendar?: () => void;
};

export function TodayPage({ today, panels: todayPanels, enrichment, eventCount, capture, busy, readOnly, loading = false, onCaptureChange, onCapture, onReplan, onChangeFocus, onEnrich, onGiveUp, onOpenInbox, onOpenSettingsCard, onCompleteTask, onOpenTasks, onOpenCalendar, timeZone, onRetryCalendar, onBackUpNow }: Props) {
  if (loading) return <TodayLoading />;
  const setupWarning = todayPanels?.setupWarning;
  const warnings = Number(Boolean(setupWarning && (setupWarning.selfEmailsMissing || setupWarning.internalDomainsMissing))) + Number(Boolean(todayPanels?.backupWarning)) + Number(Boolean(todayPanels?.calendarOffline));
  return <>
    <PageHeader eyebrow="HOME / TODAY" title="What needs your attention?" description="Choose what moves today forward. Everything else is still close at hand." />
    {readOnly && <p className="today-read-only" role="status">Read-only: viewing today without changing it.</p>}
    <div className="today-priority-grid">
      {today.focus
        ? <DailyFocusPanel focus={today.focus} tasks={today.tasks} disabled={busy || readOnly} onRefresh={() => void onReplan()} onChange={(change) => void onChangeFocus(change)} onCompleteTask={onCompleteTask} onOpenTasks={onOpenTasks} />
        : <article className="daily-focus today-empty-priority"><span>TOP 3</span><h3>No plan is available yet</h3><p className="muted">Reload Today to build your priority list.</p></article>}
      <div className="today-side-rail">
        <NextMeetingCard panels={todayPanels} timeZone={timeZone} busy={busy} onRetryCalendar={onRetryCalendar} onOpenCalendar={onOpenCalendar} />
        <article className="quick-capture"><span>QUICK CAPTURE</span><h3>Get it out of your head</h3><div className="capture-row"><input aria-label="Quick Capture" value={capture} onChange={(event) => onCaptureChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && capture.trim()) onCapture(); }} placeholder="A task or commitment…" /><button className="primary" disabled={!capture.trim() || busy || readOnly} onClick={onCapture}>Capture</button></div></article>
      </div>
    </div>
    <div className="today-warning-stack">
      <SelfEmailWarning warning={todayPanels?.setupWarning} onOpenSettings={onOpenSettingsCard} />
      <BackupWarning warning={todayPanels?.backupWarning} disabled={busy || readOnly || !onBackUpNow} onBackUpNow={() => onBackUpNow?.()} />
    </div>
    <div className="summary today-summary" aria-label="Supporting counts">
      <Summary label="ACTIVE TASKS" value={today.tasks.length} detail="across all contexts" />
      <Summary label="REVIEW INBOX" value={today.reviewCount} detail="awaiting confirmation" />
      <Summary label="TODAY'S EVENTS" value={eventCount} detail="across connected calendars" />
      <Summary label="WARNINGS" value={warnings} detail="need attention" />
    </div>
    <section className="today-supporting" aria-labelledby="today-supporting-title">
      <div className="today-section-heading"><div><span>SUPPORTING WORK</span><h3 id="today-supporting-title">More from today</h3></div><p className="muted">Live counts and workflows, kept below your priorities.</p></div>
      <article className="enrichment"><span>AFTER MEETINGS</span><div className="capture-row"><p>Ask Claude to collect transcripts, recordings and Gong material for meetings that ended in the last 48 hours.</p><button className="primary" disabled={busy || readOnly} onClick={() => void onEnrich()}>Enrich last 48h</button></div>
        <CappedRows items={enrichment.proposedGaveUp} row={(meeting) => <GiveUpRow key={meeting.meetingId} meeting={meeting} disabled={busy || readOnly} onGiveUp={(meetingId) => void onGiveUp(meetingId)} />} /></article>
      <div className="today-live-grid">
        {todayPanels ? <TodayLivePanels panels={todayPanels} onOpenInbox={onOpenInbox} /> : <>
          <LivePanel title="Overdue" items={today.overdue} empty="Nothing overdue." row={objectRow} />
          <LivePanel title="Due today" items={today.dueToday} empty="Nothing due today." row={objectRow} />
          <LivePanel title="Waiting" items={today.waiting} empty="Nothing waiting on someone else." row={objectRow} />
        </>}
      </div>
    </section>
  </>;
}

function TodayLoading() {
  return <div className="today-loading" aria-busy="true" aria-label="Loading today">
    <PageHeader eyebrow="HOME / TODAY" title="What needs your attention?" description="Loading today…" />
    <div className="today-priority-grid">
      <article className="daily-focus today-skeleton"><span>TOP 3</span><div className="today-skeleton-line" /><div className="today-skeleton-line" /><div className="today-skeleton-line" /></article>
      <div className="today-side-rail"><article className="today-skeleton"><span>NEXT MEETING</span><div className="today-skeleton-line" /><div className="today-skeleton-line" /></article><article className="today-skeleton"><span>QUICK CAPTURE</span><div className="today-skeleton-line" /></article></div>
    </div>
  </div>;
}

function NextMeetingCard({ panels, timeZone, busy, onRetryCalendar, onOpenCalendar }: { panels?: TodayPanels; timeZone?: string; busy: boolean; onRetryCalendar?: () => void; onOpenCalendar?: () => void }) {
  const meeting = panels?.nextMeetings[0];
  return <article className="today-next-meeting"><span>NEXT MEETING</span>
    {panels && <CalendarOfflineBanner offline={panels.calendarOffline} timeZone={timeZone} busy={busy} onRetry={onRetryCalendar ?? (() => undefined)} />}
    {!panels ? <><div className="today-skeleton-line" /><div className="today-skeleton-line" /></> : meeting ? <>
      <h3>{meeting.inProgress ? "Now" : formatTime(meeting.startsAt)} · {meeting.title}</h3>
      <p className="muted">{meetingTime(meeting)}{meeting.calendarName ? ` · ${meeting.calendarName}` : ""}{meeting.noteId ? " · Has notes" : ""}{meeting.restricted && <> · <LockBadge frontmatter={{ sensitivity: "restricted" }} /></>}</p>
      {onOpenCalendar && <button type="button" disabled={busy} onClick={onOpenCalendar}>Open Calendar</button>}
    </> : <div className="today-purpose-empty"><h3>No more meetings today</h3><p className="muted">Your remaining time is clear.</p>{onOpenCalendar && <button type="button" aria-label="Open Calendar" disabled={busy} onClick={onOpenCalendar}>Open Calendar</button>}</div>}
  </article>;
}

const meetingTime = (meeting: NextMeeting) => `${formatTime(meeting.startsAt)}–${formatTime(meeting.endsAt)}`;

function DailyFocusPanel({ focus, tasks, disabled, onRefresh, onChange, onCompleteTask, onOpenTasks }: { focus: DailyFocus; tasks: LifeObject[]; disabled: boolean; onRefresh: () => void; onChange: (change: FocusChange) => void; onCompleteTask?: (task: LifeObject) => Promise<unknown>; onOpenTasks?: () => void }) {
  const stateLabel = { open: "", done: "Done", cancelled: "Cancelled", past: "Past", missing: "Missing: deleted or not found" } as const;
  const row = (item: FocusItem, details: Array<string | undefined>) => <div className={`object-row focus-item ${item.state}`} key={item.id}><i /><div><b>{item.object?.frontmatter.title ?? "Missing item"}{item.object && <LockBadge frontmatter={item.object.frontmatter} />}</b><small>{[stateLabel[item.state], ...details].filter(Boolean).join(" · ")}</small></div></div>;
  const section = (title: string, items: FocusItem[], details: (item: FocusItem) => Array<string | undefined>, empty: string) => <div className="focus-section"><h4>{title}</h4>{items.length ? <CappedRows items={items} row={(item) => row(item, details(item))} /> : <p className="muted">{empty}</p>}</div>;
  const { brief } = focus;
  return <article className="daily-focus">
    <div className="today-focus-heading"><div><span>TOP 3</span><h3>Make today count</h3><p className="muted">{brief ? `Brief generated at ${formatTime(brief.generatedAt)}` : "Suggested by priority, then due date."}</p></div><button disabled={disabled} onClick={onRefresh} title="Ask Claude to re-plan today">Refresh</button></div>
    {brief?.lengthWarning && <p className="muted" role="note">Note: {brief.lengthWarning}.</p>}
    <TopThreeSection focus={focus} tasks={tasks} disabled={disabled} onChange={onChange} onCompleteTask={onCompleteTask} onOpenTasks={onOpenTasks} stateLabel={stateLabel} />
    {brief && <details className="today-brief-details"><summary>Morning brief details</summary><div>
      {section("I owe", focus.iOwe, (item) => [item.overdue && item.state === "open" ? "Overdue" : undefined], "Nothing owed today.")}
      {section("Waiting and decisions", focus.waitingAndDecisions, (item) => [item.ageDays !== undefined ? `${item.ageDays} days` : undefined], "Nothing to chase.")}
      {section("Meeting prep", focus.meetingPrep, (item) => [item.object?.frontmatter.starts_at ? formatTime(item.object.frontmatter.starts_at) : undefined, item.context, item.ask ? `Your ask: ${item.ask}` : undefined], "No meetings to prepare.")}
      {focus.dayShape && <div className="focus-section"><h4>Day shape</h4><p>{focus.dayShape.meetingHours} h in meetings · {focus.dayShape.freeHours} h free</p></div>}
      {focus.deferCandidates.length > 0 && section("Consider deferring", focus.deferCandidates, (item) => [item.reason], "")}
      {brief.body.trim() && <p className="focus-narrative">{brief.body.trim()}</p>}
    </div></details>}
    {focus.restrictedHidden > 0 && <p className="muted">{focus.restrictedHidden} restricted {focus.restrictedHidden === 1 ? "item" : "items"} not shown.</p>}
  </article>;
}

function TopThreeSection({ focus, tasks, disabled, onChange, onCompleteTask, onOpenTasks, stateLabel }: { focus: DailyFocus; tasks: LifeObject[]; disabled: boolean; onChange: (change: FocusChange) => void; onCompleteTask?: (task: LifeObject) => Promise<unknown>; onOpenTasks?: () => void; stateLabel: Record<FocusItem["state"], string> }) {
  const [replacing, setReplacing] = useState<string>();
  const [choice, setChoice] = useState("");
  const [toPin, setToPin] = useState("");
  const candidates = tasks.filter((task) => task.frontmatter.sensitivity !== "restricted" && !focus.top3.some((item) => item.id === task.frontmatter.id));
  const title = (item: FocusItem) => item.object?.frontmatter.title ?? "Missing item";
  const cancelReplace = () => { setReplacing(undefined); setChoice(""); };
  const options = <>{candidates.map((task) => <option key={task.frontmatter.id} value={task.frontmatter.id}>{task.frontmatter.title}</option>)}</>;
  return <div className="focus-section top-three">
    {!focus.top3.length && <div className="today-purpose-empty"><h4>No active commitments to rank</h4><p className="muted">Choose your next action from Tasks.</p>{onOpenTasks && <button type="button" aria-label="Open Tasks to plan today" onClick={onOpenTasks}>Open Tasks</button>}</div>}
    {focus.top3.map((item, index) => <div className="top-three-row" key={item.id}>
      <div className={`object-row focus-item ${item.state}`}><span className="today-priority-number" aria-hidden>{index + 1}</span><div><b>{title(item)}{item.object && <LockBadge frontmatter={item.object.frontmatter} />}</b><small>{[item.pinned ? "Pinned" : undefined, stateLabel[item.state], item.whyToday, item.replaces ? `Replaces "${item.replaces.title}"` : undefined, item.ifThen].filter(Boolean).join(" · ")}</small></div>
        <div className="top-three-primary-actions"><button type="button" disabled={disabled || item.state !== "open" || !item.object || !onCompleteTask} onClick={() => item.object && void onCompleteTask?.(item.object)}>Complete</button>
          <details className="focus-more"><summary>More</summary><div className="focus-controls">
            {item.object && <button type="button" aria-pressed={Boolean(item.pinned)} aria-label={`${item.pinned ? "Unpin" : "Pin"} ${title(item)}`} disabled={disabled} onClick={() => onChange({ action: item.pinned ? "unpin" : "pin", taskId: item.id })}>{item.pinned ? "Unpin" : "Pin"}</button>}
            <button type="button" aria-expanded={replacing === item.id} aria-label={`Replace ${title(item)}`} disabled={disabled || !candidates.length} onClick={() => replacing === item.id ? cancelReplace() : (setReplacing(item.id), setChoice(""))}>Replace</button>
            <button type="button" aria-label={`Dismiss ${title(item)} for today`} disabled={disabled} onClick={() => onChange({ action: "dismiss", taskId: item.id })}>Dismiss</button>
          </div></details>
        </div>
      </div>
      {replacing === item.id && <div className="capture-row focus-replace" onKeyDown={(event) => { if (event.key === "Escape") cancelReplace(); }}><select autoFocus aria-label={`Task to put in place of ${title(item)}`} value={choice} onChange={(event) => setChoice(event.target.value)}><option value="">Choose a task…</option>{options}</select><button type="button" className="primary" disabled={disabled || !choice} onClick={() => { onChange({ action: "replace", taskId: item.id, replacementId: choice }); cancelReplace(); }}>Replace</button><button type="button" onClick={cancelReplace}>Cancel</button></div>}
    </div>)}
    {(focus.top3.length < focus.maxMustDos && candidates.length > 0) || focus.dismissedTop3.length > 0 || focus.override ? <details className="top-three-plan-more"><summary>Adjust today’s plan</summary><div>
      {focus.top3.length < focus.maxMustDos && candidates.length > 0 && <div className="capture-row focus-pin"><select aria-label="Task to pin to today's Top 3" value={toPin} disabled={disabled} onChange={(event) => setToPin(event.target.value)}><option value="">Add a task to today's Top 3…</option>{options}</select><button type="button" disabled={disabled || !toPin} onClick={() => { onChange({ action: "pin", taskId: toPin }); setToPin(""); }}>Pin</button></div>}
      {focus.dismissedTop3.length > 0 && <div className="focus-dismissed"><small>Dismissed for today</small><CappedRows items={focus.dismissedTop3} row={(item) => <div className="object-row" key={item.id}><div><b>{title(item)}</b></div><button type="button" aria-label={`Restore ${title(item)} to today's Top 3`} disabled={disabled} onClick={() => onChange({ action: "restore", taskId: item.id })}>Restore</button></div>} /></div>}
      {focus.override && <button type="button" className="link-button" disabled={disabled} onClick={() => onChange({ action: "reset" })}>Clear my Top 3 changes for today</button>}
    </div></details> : null}
  </div>;
}

const dueText = (task: LifeObject) => typeof task.frontmatter.due_on === "string" ? task.frontmatter.due_on : typeof task.frontmatter.due_at === "string" ? task.frontmatter.due_at.slice(0, 10) : undefined;
const openPointLinkText = { "raised-in": "Raised in", project: "Same project as", client: "Same client as", people: "Same people as" } as const;

function TodayLivePanels({ panels, onOpenInbox }: { panels: TodayPanels; onOpenInbox: () => void }) {
  const taskRow = (detail: (task: LifeObject) => string) => (task: LifeObject) => <div className="object-row" key={task.frontmatter.id}><i /><div><b>{task.frontmatter.title}<LockBadge frontmatter={task.frontmatter} /></b><small>{detail(task)}</small></div></div>;
  const overdueBy = (task: LifeObject) => { const due = dueText(task); const days = due ? daysBetween(due, panels.date) : 0; return `Overdue by ${days} ${days === 1 ? "day" : "days"} · due ${due}`; };
  const inboxRows = [{ key: "reviews", text: `${panels.reviewCount} review ${panels.reviewCount === 1 ? "item" : "items"} awaiting confirmation` }, { key: "awaiting", text: awaitingAdoptionLabel(panels.inbox) }, ...panels.failedDrafts.map((entry) => ({ key: `failed:${entry.path}`, text: `Failed draft: ${entry.reason}`, path: entry.path })), ...panels.staleWorkOrders.map((order) => ({ key: `stale:${order.path}`, text: `Stale Work Order: not processed for ${order.ageDays} days`, path: order.path }))];
  return <>
    <LivePanel title="Overdue" items={panels.overdue} empty="Nothing overdue." row={taskRow(overdueBy)} />
    <LivePanel title="Due today" items={panels.dueToday} empty="Nothing due today." row={taskRow((task) => `Due today${task.frontmatter.priority ? ` · ${String(task.frontmatter.priority)} priority` : ""}`)} />
    <LivePanel title="Upcoming high priority" items={panels.upcomingHighPriority} empty="No upcoming high-priority work." row={taskRow((task) => `High priority · ${dueText(task) ? `due ${dueText(task)}` : "no due date"}`)} />
    <LivePanel title="Waiting by person" items={panels.waitingByPerson} empty="Nothing waiting on someone else." row={(group) => <WaitingGroupRow key={group.personId ?? "unknown"} group={group} />} />
    <LivePanel title="Later meetings" items={panels.nextMeetings.slice(1)} empty="No later meetings today." note={<p className="muted">{panels.meetingHours} h of meetings today{panels.meetingHeavy ? ` · Meeting-heavy day (${panels.settings.meetingHoursThreshold} h or more)` : ""}</p>} row={(meeting) => <div className="object-row" key={meeting.meetingId ?? meeting.calendarEventId}><i /><div><b>{meeting.title}{meeting.restricted && <LockBadge frontmatter={{ sensitivity: "restricted" }} />}</b><small>{[meeting.inProgress ? "Now" : undefined, meetingTime(meeting), meeting.calendarName, meeting.noteId ? "Has notes" : undefined].filter(Boolean).join(" · ")}</small></div></div>} />
    <LivePanel title="Open points for today's meetings" items={panels.openPointsForMeetings} empty="No open points linked to today's meetings." row={(entry) => <div className="object-row" key={entry.openPoint.frontmatter.id}><i /><div><b>{entry.openPoint.frontmatter.title}<LockBadge frontmatter={entry.openPoint.frontmatter} /></b><small>{[`${openPointLinkText[entry.link]} ${entry.meetingTitle}`, entry.openPoint.frontmatter.importance ? `${String(entry.openPoint.frontmatter.importance)} importance` : undefined].filter(Boolean).join(" · ")}</small></div></div>} />
    <LivePanel title="Inbox and agents" items={inboxRows} empty="" note={<button type="button" onClick={onOpenInbox}>Open Inbox</button>} row={(entry) => <div className="object-row" key={entry.key}><i /><div><b>{entry.text}</b>{"path" in entry && entry.path && <small><code>{entry.path}</code></small>}</div></div>} />
  </>;
}
