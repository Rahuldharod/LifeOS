import React, { useEffect, useRef } from "react";
import type { LifeObject, ObjectLink } from "@lifeos/contracts";
import { WorkspaceFilterBar } from "./WorkspacePatterns.js";
import { InboxRow, LowConfidenceDot } from "./InboxRow.js";
import { groupKey, inboxTabs, type CreatedPeriod, type DateGroup, type InboxReview, type InboxTab, type Outcome, type RowCells } from "./inboxModel.js";
import { rowLayoutModes, type RowLayoutMode } from "./useInboxRowLayout.js";
import { inboxViews, type InboxView } from "./useInboxView.js";

/** The queue pane: heading, type tabs, filters, bulk actions and the rows (or its loading, error and empty states). */
export function InboxQueue({ paneRef, groups, collapsed, cellsFor, rowMode, twoLine, view, onView, switcher, visible, reviewCount, tabCounts, tab, query, advanced, meetings, meetingId, period, openedId, focusedId, checked, ticked, acceptableCount, allTicked, loading, error, busy, readOnly, bulkRunning, hidden,
  onDecideRow, onDecideGroup, onRowMode, onShowHelp, onFocusRow, onToggleGroup, onTab, onQuery, onToggleAdvanced, onMeeting, onPeriod, onClearFilters, processedToday, onSeeHistory, onOpen, onToggleChecked, onSelectAll, onDeselectAll, onDecideTicked }: {
  paneRef: React.RefObject<HTMLElement | null>; groups: DateGroup[]; collapsed: Set<string>; cellsFor: (review: InboxReview) => RowCells; rowMode: RowLayoutMode; twoLine: boolean; view: InboxView; /** Undefined where the view cannot be chosen (narrow screens). */ onView?: (view: InboxView) => void; /** The Inbox / History switch, shown in the page header (#243). */ switcher?: React.ReactNode;
  onRowMode: (mode: RowLayoutMode) => void; onShowHelp: () => void; onFocusRow: (id: string) => void; onToggleGroup: (key: string) => void;
  visible: InboxReview[]; reviewCount: number; tabCounts: Map<InboxTab, number>; tab: InboxTab; query: string; advanced: boolean; meetings: Array<LifeObject | ObjectLink>; meetingId: string; period: CreatedPeriod;
  openedId?: string; focusedId?: string; checked: Set<string>; ticked: InboxReview[]; acceptableCount: number; allTicked: boolean; loading: boolean; error?: string; busy: boolean; readOnly: boolean; bulkRunning: boolean; hidden: boolean;
  onTab: (tab: InboxTab) => void; onQuery: (query: string) => void; onToggleAdvanced: () => void; onMeeting: (id: string) => void; onPeriod: (period: CreatedPeriod) => void; onClearFilters: () => void; /** Review actions made today (#244); the Inbox zero screen shows it. */ processedToday?: number; onSeeHistory?: () => void;
  onOpen: (id: string) => void; onToggleChecked: (id: string, range?: boolean) => void; onSelectAll: () => void; onDeselectAll: () => void; onDecideTicked: (outcome: Outcome) => void;
  onDecideRow: (id: string, outcome: Outcome) => void; onDecideGroup: (items: InboxReview[], outcome: Outcome) => void;
}) {
  /** Row and group buttons are off while the app is read-only or a decision is saving. */
  const groupLocked = busy || readOnly || bulkRunning;
  /** When the last item is decided, the row that had focus is gone: move focus to the Inbox zero heading so keyboard and screen reader users land somewhere. */
  const zeroRef = useRef<HTMLHeadingElement>(null); const hadItems = useRef(reviewCount > 0);
  const zero = !loading && !error && reviewCount === 0;
  useEffect(() => { if (zero && hadItems.current) zeroRef.current?.focus(); hadItems.current = reviewCount > 0; }, [zero, reviewCount]);
  return <section ref={paneRef} className={`inbox-queue ${twoLine ? "two-line" : "one-line"}`} data-pane="list" aria-label="Review queue" hidden={hidden}>
    <header className="workspace-heading"><div><span>INBOX · {visible.length}</span><h2>Review proposals</h2><p className="muted">Nothing becomes a commitment until you accept it.</p></div>{switcher}</header>
    <div className="workspace-tabs inbox-tabs">
      <div className="inbox-tablist" role="tablist" aria-label="Proposal type">
        {inboxTabs.map((name, index) => <button role="tab" key={name} aria-selected={tab === name} className={tab === name ? "selected" : ""} title={`${name} (press ${index + 1})`} aria-keyshortcuts={String(index + 1)} onClick={() => onTab(name)}>{name} <small>{tabCounts.get(name)}</small></button>)}
      </div>
      <div className="inbox-tab-tools">
      {onView && <div className="inbox-view-toggle" role="group" aria-label="Reading pane view">
        {inboxViews.map(({ view: name, label }) => <button key={name} aria-pressed={view === name} aria-keyshortcuts="v" title={name === "split" ? "List beside the reading pane (V)" : "List at full width; an opened item replaces it (V)"} onClick={() => onView(name)}>{label}</button>)}
      </div>}
      <div className="inbox-row-layout" role="group" aria-label="Row layout">
        {rowLayoutModes.map(({ mode, label }) => <button key={mode} aria-pressed={rowMode === mode} title={mode === "auto" ? "One line with columns when the list is wide, two lines when it is narrow" : `Always ${label}`} onClick={() => onRowMode(mode)}>{label}{mode === "auto" && rowMode === "auto" && <small> · {twoLine ? "2 lines" : "1 line"}</small>}</button>)}
      </div>
      <button className="inbox-shortcuts-link" aria-keyshortcuts="?" title="Keyboard shortcuts (?)" onClick={onShowHelp}>Shortcuts <kbd>?</kbd></button></div>
    </div>
    <WorkspaceFilterBar advanced={advanced} onToggleAdvanced={onToggleAdvanced}>
      <input type="search" aria-label="Search proposals" placeholder="Search proposals…" value={query} onChange={(event) => onQuery(event.target.value)} />
    </WorkspaceFilterBar>
    {advanced && <div className="inbox-advanced-filters">
      <label>Source meeting<select aria-label="Filter by source meeting" value={meetingId} onChange={(event) => onMeeting(event.target.value)}><option value="">Any meeting</option>{meetings.map((meeting) => <option value={meeting.frontmatter.id} key={meeting.frontmatter.id}>{meeting.frontmatter.title}</option>)}</select></label>
      <label>Created<select aria-label="Filter by created period" value={period} onChange={(event) => onPeriod(event.target.value as CreatedPeriod)}><option value="">Any time</option><option value="today">Today</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></label>
      <button onClick={() => { onMeeting(""); onPeriod(""); }}>Clear advanced filters</button>
    </div>}
    {loading ? <div className="inbox-state" aria-busy="true">Loading review queue…</div> : error ? <div className="inbox-state failure" role="alert">{error}</div> : visible.length === 0 ? reviewCount ? <div className="inbox-state"><h3>No matching proposals</h3><p>{reviewCount === 1 ? "1 proposal is hidden by the filters." : `${reviewCount} proposals are hidden by the filters.`}</p><button onClick={onClearFilters}>Clear filters</button></div>
      : <div className="inbox-state inbox-zero"><div className="inbox-zero-mark" aria-hidden>✓</div><h3 ref={zeroRef} tabIndex={-1}>Inbox zero</h3>
        <p>{processedToday ? <>You processed <b>{processedToday}</b> {processedToday === 1 ? "item" : "items"} today.</> : "Nothing waiting."}</p>
        {onSeeHistory && <button onClick={onSeeHistory}>See History</button>}</div> : <>
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
      {!twoLine && <div className="inbox-row inbox-colhead" aria-hidden><span className="c-check" /><span className="c-kind">Type</span><span className="c-dot" /><span className="c-title">Item</span><span className="c-owner">Owner</span><span className="c-due">Due</span><span className="c-project">Project</span><span className="c-time">Time</span><span className="c-actions" /></div>}
      <div className="inbox-rows">{groups.map(({ bucket, sources }) => <div key={bucket} className="inbox-date-group">
        <h3 className="inbox-date">{bucket}</h3>
        {sources.map((source) => {
          const key = groupKey(bucket, source); const isCollapsed = collapsed.has(key);
          return <div key={key} className="inbox-source-group">
            <div className="inbox-source-head">
              <button className="inbox-source" aria-expanded={!isCollapsed} aria-label={`${source.label}, ${source.items.length}`} onClick={() => onToggleGroup(key)}><span aria-hidden>{isCollapsed ? "▸" : "▾"}</span> {source.label} <small>{source.items.length}</small></button>
              <span className="inbox-group-actions" role="group" aria-label={`Actions for ${source.label}`}>
                <button disabled={groupLocked} title="Accept all in this group (skips Link and Merge)" aria-label={`Accept all in ${source.label}`} onClick={() => onDecideGroup(source.items, "accepted")}>Accept all</button>
                <button className="danger" disabled={groupLocked} aria-label={`Reject all in ${source.label}`} onClick={() => onDecideGroup(source.items, "rejected")}>Reject all</button>
              </span>
            </div>
            {!isCollapsed && source.items.map((review) => <InboxRow key={review.frontmatter.id} review={review} cells={cellsFor(review)} twoLine={twoLine} opened={openedId === review.frontmatter.id} focused={focusedId === review.frontmatter.id} onFocusRow={onFocusRow} checked={checked.has(review.frontmatter.id)} onOpen={onOpen} onToggleChecked={onToggleChecked} actionsDisabled={groupLocked} onDecide={onDecideRow} />)}
          </div>;
        })}
      </div>)}</div>
    </>}
  </section>;
}
