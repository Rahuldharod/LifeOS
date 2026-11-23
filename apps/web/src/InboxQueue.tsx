import React from "react";
import type { LifeObject, ObjectLink } from "@lifeos/contracts";
import { WorkspaceFilterBar } from "./WorkspacePatterns.js";
import { InboxRow, LowConfidenceDot } from "./InboxRow.js";
import { groupKey, inboxTabs, type CreatedPeriod, type DateGroup, type InboxReview, type InboxTab, type Outcome, type RowCells } from "./inboxModel.js";
import { rowLayoutModes, type RowLayoutMode } from "./useInboxRowLayout.js";

/** The queue pane: heading, type tabs, filters, bulk actions and the rows (or its loading, error and empty states). */
export function InboxQueue({ paneRef, groups, collapsed, cellsFor, rowMode, twoLine, visible, reviewCount, tabCounts, tab, query, advanced, meetings, meetingId, period, openedId, checked, ticked, acceptableCount, allTicked, loading, error, busy, readOnly, bulkRunning, hidden,
  onRowMode, onToggleGroup, onTab, onQuery, onToggleAdvanced, onMeeting, onPeriod, onClearFilters, onOpen, onToggleChecked, onSelectAll, onDeselectAll, onDecideTicked }: {
  paneRef: React.RefObject<HTMLElement | null>; groups: DateGroup[]; collapsed: Set<string>; cellsFor: (review: InboxReview) => RowCells; rowMode: RowLayoutMode; twoLine: boolean;
  onRowMode: (mode: RowLayoutMode) => void; onToggleGroup: (key: string) => void;
  visible: InboxReview[]; reviewCount: number; tabCounts: Map<InboxTab, number>; tab: InboxTab; query: string; advanced: boolean; meetings: Array<LifeObject | ObjectLink>; meetingId: string; period: CreatedPeriod;
  openedId?: string; checked: Set<string>; ticked: InboxReview[]; acceptableCount: number; allTicked: boolean; loading: boolean; error?: string; busy: boolean; readOnly: boolean; bulkRunning: boolean; hidden: boolean;
  onTab: (tab: InboxTab) => void; onQuery: (query: string) => void; onToggleAdvanced: () => void; onMeeting: (id: string) => void; onPeriod: (period: CreatedPeriod) => void; onClearFilters: () => void;
  onOpen: (id: string) => void; onToggleChecked: (id: string) => void; onSelectAll: () => void; onDeselectAll: () => void; onDecideTicked: (outcome: Outcome) => void;
}) {
  return <section ref={paneRef} className={`inbox-queue ${twoLine ? "two-line" : "one-line"}`} data-pane="list" aria-label="Review queue" hidden={hidden}>
    <header className="workspace-heading"><div><span>INBOX · {visible.length}</span><h2>Review proposals</h2><p className="muted">Nothing becomes a commitment until you accept it.</p></div></header>
    <div className="workspace-tabs inbox-tabs">
      <div className="inbox-tablist" role="tablist" aria-label="Proposal type">
        {inboxTabs.map((name, index) => <button role="tab" key={name} aria-selected={tab === name} className={tab === name ? "selected" : ""} title={`${name} (press ${index + 1})`} aria-keyshortcuts={String(index + 1)} onClick={() => onTab(name)}>{name} <small>{tabCounts.get(name)}</small></button>)}
      </div>
      <div className="inbox-row-layout" role="group" aria-label="Row layout">
        {rowLayoutModes.map(({ mode, label }) => <button key={mode} aria-pressed={rowMode === mode} title={mode === "auto" ? "One line with columns when the list is wide, two lines when it is narrow" : `Always ${label}`} onClick={() => onRowMode(mode)}>{label}{mode === "auto" && rowMode === "auto" && <small> · {twoLine ? "2 lines" : "1 line"}</small>}</button>)}
      </div>
    </div>
    <WorkspaceFilterBar advanced={advanced} onToggleAdvanced={onToggleAdvanced}>
      <input type="search" aria-label="Search proposals" placeholder="Search proposals…" value={query} onChange={(event) => onQuery(event.target.value)} />
    </WorkspaceFilterBar>
    {advanced && <div className="inbox-advanced-filters">
      <label>Source meeting<select aria-label="Filter by source meeting" value={meetingId} onChange={(event) => onMeeting(event.target.value)}><option value="">Any meeting</option>{meetings.map((meeting) => <option value={meeting.frontmatter.id} key={meeting.frontmatter.id}>{meeting.frontmatter.title}</option>)}</select></label>
      <label>Created<select aria-label="Filter by created period" value={period} onChange={(event) => onPeriod(event.target.value as CreatedPeriod)}><option value="">Any time</option><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
      <button onClick={() => { onMeeting(""); onPeriod(""); }}>Clear advanced filters</button>
    </div>}
    {loading ? <div className="inbox-state" aria-busy="true">Loading review queue…</div> : error ? <div className="inbox-state failure" role="alert">{error}</div> : visible.length === 0 ? <div className="inbox-state"><h3>{reviewCount ? "No matching proposals" : "Inbox clear"}</h3>{reviewCount ? <><p>{reviewCount === 1 ? "1 proposal is hidden by the filters." : `${reviewCount} proposals are hidden by the filters.`}</p><button onClick={onClearFilters}>Clear filters</button></> : <p>No proposals require your attention.</p>}</div> : <>
      <div className="inbox-bulk" role="toolbar" aria-label="Bulk actions">
        <button disabled={allTicked} onClick={onSelectAll}>Select all</button>
        <button disabled={!ticked.length} onClick={onDeselectAll}>Deselect all</button>
        {ticked.length > 0 && <>
          <small>{ticked.length} selected</small>
          <button className="primary" disabled={busy || readOnly || bulkRunning || !acceptableCount} title={acceptableCount < ticked.length ? "Link and merge proposals need a choice, so they are skipped" : undefined} onClick={() => onDecideTicked("accepted")}>Accept selected ({acceptableCount})</button>
          <button className="danger" disabled={busy || readOnly || bulkRunning} onClick={() => onDecideTicked("rejected")}>Reject selected ({ticked.length})</button>
        </>}
      </div>
      <div className="inbox-legend"><LowConfidenceDot legend /> Low confidence: check the evidence before accepting</div>
      {!twoLine && <div className="inbox-row inbox-colhead" aria-hidden><span className="c-check" /><span className="c-kind">Type</span><span className="c-dot" /><span className="c-title">Item</span><span className="c-owner">Owner</span><span className="c-due">Due</span><span className="c-project">Project</span><span className="c-time">Time</span></div>}
      <div className="inbox-rows">{groups.map(({ bucket, sources }) => <div key={bucket} className="inbox-date-group">
        <h3 className="inbox-date">{bucket}</h3>
        {sources.map((source) => {
          const key = groupKey(bucket, source); const isCollapsed = collapsed.has(key);
          return <div key={key} className="inbox-source-group">
            <button className="inbox-source" aria-expanded={!isCollapsed} aria-label={`${source.label}, ${source.items.length}`} onClick={() => onToggleGroup(key)}><span aria-hidden>{isCollapsed ? "▸" : "▾"}</span> {source.label} <small>{source.items.length}</small></button>
            {!isCollapsed && source.items.map((review) => <InboxRow key={review.frontmatter.id} review={review} cells={cellsFor(review)} twoLine={twoLine} opened={openedId === review.frontmatter.id} checked={checked.has(review.frontmatter.id)} onOpen={onOpen} onToggleChecked={onToggleChecked} />)}
          </div>;
        })}
      </div>)}</div>
    </>}
  </section>;
}
