import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LifeObject, ObjectLink, PersonLabel, ReviewEdits } from "@lifeos/contracts";
import type { LinkCardActions } from "./LinkResolutionCard.js";
import { InboxQueue } from "./InboxQueue.js";
import { InboxReadingPane } from "./InboxReadingPane.js";
import { InboxToast, useInboxToast } from "./InboxToast.js";
import { useInboxKeys } from "./useInboxKeys.js";
import { createdWindow, errorText, inboxTabs, needsChoice, proposalTab, reviewType, type ActionResult, type BulkResult, type CreatedPeriod, type InboxReview, type InboxTab, type Outcome, type ReviewChoices } from "./inboxModel.js";
import { useSplitPane } from "./splitPane.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";
import "./InboxWorkspace.css";

export type { BulkResult, InboxReview, InboxTab, ReviewChoices } from "./inboxModel.js";

/** The Inbox page: owns the state (filters, opened item, ticks, decisions) and composes the queue, reading pane, keys and toast. */
export function InboxWorkspace({ reviews, objects, labels, choices, selectedId, loading = false, error, busy, readOnly, displayTimeZone, now = new Date(), onOpen, onBack, onAccept, onReject, onSave, onDecideMany, linkActionsFor }: {
  reviews: InboxReview[]; objects: Array<LifeObject | ObjectLink>; labels: Map<string, PersonLabel>; choices: ReviewChoices;
  selectedId?: string; loading?: boolean; error?: string; busy: boolean; readOnly: boolean; displayTimeZone: string; now?: Date;
  onOpen?: (id: string, options?: { replace?: boolean }) => void; onBack?: () => void;
  onAccept: (review: InboxReview) => Promise<ActionResult>; onReject: (review: InboxReview) => Promise<ActionResult>; onSave: (review: InboxReview, edits: ReviewEdits) => Promise<ActionResult>;
  /** Bulk decisions with one refresh at the end. Without it, the Inbox calls onAccept/onReject per item. */
  onDecideMany?: (reviews: InboxReview[], outcome: Outcome) => Promise<BulkResult>;
  linkActionsFor?: (reviewId: string) => LinkCardActions;
}) {
  const narrow = useNarrowWorkspace();
  const [openedId, setOpenedId] = useState<string | undefined>(() => selectedId ?? (narrow ? undefined : reviews[0]?.frontmatter.id));
  const split = useSplitPane("inbox");
  const [query, setQuery] = useState(""); const [tab, setTabState] = useState<InboxTab>("All"); const [advanced, setAdvanced] = useState(false);
  const [meetingId, setMeetingId] = useState(""); const [period, setPeriod] = useState<CreatedPeriod>("");
  const [deciding, setDeciding] = useState<InboxReview>(); const { notification, notify } = useInboxToast(); const [actionError, setActionError] = useState("");
  const [activeId, setActiveId] = useState<string>(); const active = useRef(new Set<string>());
  const [checked, setChecked] = useState<Set<string>>(() => new Set()); const [bulkRunning, setBulkRunning] = useState(false);
  const detailRef = useRef<HTMLElement>(null);

  const openedRef = useRef(openedId); openedRef.current = openedId;
  useEffect(() => { if (selectedId !== undefined) setOpenedId(selectedId); }, [selectedId]);

  const objectById = useMemo(() => new Map(objects.map((object) => [String(object.frontmatter.id), object])), [objects]);
  const meetings = useMemo(() => objects.filter((object) => object.frontmatter.type === "meeting"), [objects]);
  const window = createdWindow(period, now, displayTimeZone);
  const filtered = reviews.filter((review) => {
    const search = `${review.frontmatter.title} ${review.body} ${reviewType(review)} ${review.frontmatter.target_object_type ?? ""}`.toLowerCase();
    if (query.trim() && !search.includes(query.trim().toLowerCase())) return false;
    if (meetingId && review.frontmatter.source_meeting_id !== meetingId) return false;
    const createdAt = Date.parse(String(review.frontmatter.created_at));
    if (window && (createdAt < window.from || createdAt >= window.to)) return false;
    return true;
  });
  const tabCounts = new Map<InboxTab, number>(inboxTabs.map((name) => [name, name === "All" ? filtered.length : filtered.filter((review) => proposalTab(review) === name).length]));
  const visible = filtered.filter((review) => tab === "All" || proposalTab(review) === tab)
    .sort((a, b) => String(b.frontmatter.created_at).localeCompare(String(a.frontmatter.created_at)));
  /** Bulk actions only touch ticked items that are on screen now. */
  const ticked = visible.filter((review) => checked.has(review.frontmatter.id));
  const acceptable = ticked.filter((review) => !needsChoice(review));

  useEffect(() => {
    if (narrow || openedId || !visible.length) return;
    setOpenedId(visible[0]!.frontmatter.id);
  }, [narrow, openedId, visible]);

  // While a decision saves, the refresh drops the item from `reviews`; keep showing it until the Inbox moves on (no "Select a proposal" flash).
  const selected = reviews.find((review) => review.frontmatter.id === openedId) ?? (deciding?.frontmatter.id === openedId ? deciding : undefined);
  const open = (id: string, options?: { replace?: boolean }) => { setOpenedId(id); setActionError(""); onOpen?.(id, options); };
  const back = () => { setOpenedId(undefined); setActionError(""); onBack?.(); };
  const setTab = (next: InboxTab) => { setTabState(next); setChecked(new Set()); };
  const clearFilters = () => { setQuery(""); setTab("All"); setMeetingId(""); setPeriod(""); };
  const toggleChecked = (id: string) => setChecked((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const visibleIds = visible.map((review) => review.frontmatter.id);
  /** PB-035: the item below in the list, or the one above when the decided item was the bottom one. */
  const nextAfter = (id: string) => {
    const index = visibleIds.indexOf(id);
    if (index < 0) return visibleIds[0];
    return visibleIds[index + 1] ?? visibleIds[index - 1];
  };
  /** PB-035: once a decision is recorded, open the next waiting item; after the last one, show the empty list state. */
  const advanceFrom = (id: string, nextId: string | undefined) => {
    if (openedRef.current !== undefined && openedRef.current !== id) return; // the user already moved on while the decision was saving
    if (nextId) { open(nextId, { replace: true }); return; }
    setOpenedId(undefined); setActionError("");
  };
  const decide = async (review: InboxReview, outcome: Outcome, action: () => Promise<ActionResult>) => {
    const id = review.frontmatter.id;
    if (active.current.has(id) || busy || readOnly) return;
    const nextId = nextAfter(id);
    active.current.add(id); setActiveId(id); setActionError(""); setDeciding(review);
    try {
      const result = await action();
      if (result === false) return;
      notify(`Proposal ${outcome}`);
      advanceFrom(id, nextId);
    } catch (caught) { setActionError(errorText(caught)); }
    finally { active.current.delete(id); setActiveId((current) => current === id ? undefined : current); setDeciding((current) => current?.frontmatter.id === id ? undefined : current); }
  };
  /** Link-resolution cards run their own requests; once one finishes, the Inbox moves on the same way. */
  const linkFinished = (review: InboxReview, nextId: string | undefined, outcome: Outcome) => { notify(`Proposal ${outcome}`); advanceFrom(review.frontmatter.id, nextId); };
  const position = selected ? visibleIds.indexOf(selected.frontmatter.id) : -1;
  const previousId = position > 0 ? visibleIds[position - 1] : undefined;
  const followingId = position >= 0 ? visibleIds[position + 1] : undefined;
  const step = useRef<(direction: -1 | 1) => boolean>(() => false);
  step.current = (direction) => { const target = direction < 0 ? previousId : followingId; if (target) open(target); return Boolean(target); };

  /** Bulk Accept/Reject on the ticked items in view. Each item is its own idempotent request; a failure does not stop the rest. */
  const decideTicked = async (outcome: Outcome) => {
    if (busy || readOnly || bulkRunning) return;
    const targets = outcome === "accepted" ? acceptable : ticked;
    const skipped = ticked.length - targets.length;
    if (!targets.length) return;
    if (outcome === "rejected" && !globalThis.confirm(`Reject ${targets.length === 1 ? "1 proposal" : `${targets.length} proposals`}? This cannot be undone.`)) return;
    const targetIds = new Set(targets.map((review) => review.frontmatter.id));
    const openId = openedRef.current;
    const openIndex = openId ? visibleIds.indexOf(openId) : -1;
    const nextId = visibleIds.slice(openIndex + 1).find((id) => !targetIds.has(id)) ?? visibleIds.slice(0, Math.max(openIndex, 0)).reverse().find((id) => !targetIds.has(id));
    setBulkRunning(true); setActionError("");
    try {
      const result = onDecideMany ? await onDecideMany(targets, outcome) : await decideEach(targets, outcome);
      const decided = new Set(result.decided);
      setChecked((current) => new Set([...current].filter((id) => !decided.has(id))));
      notify([`${decided.size === 1 ? "1 proposal" : `${decided.size} proposals`} ${outcome}`, ...(skipped ? [`${skipped} skipped (link or merge needs a choice)`] : [])].join(" · "));
      if (result.failures.length) setActionError(`${result.failures.length} not ${outcome}: ${result.failures.join("; ")}`);
      if (openId && decided.has(openId)) advanceFrom(openId, nextId);
    } catch (caught) { setActionError(errorText(caught)); }
    finally { setBulkRunning(false); }
  };
  const decideEach = async (targets: InboxReview[], outcome: Outcome): Promise<BulkResult> => {
    const result: BulkResult = { decided: [], failures: [] };
    for (const review of targets) {
      try { if ((await (outcome === "accepted" ? onAccept(review) : onReject(review))) !== false) result.decided.push(review.frontmatter.id); else result.failures.push(review.frontmatter.title); }
      catch (caught) { result.failures.push(`${review.frontmatter.title}: ${errorText(caught)}`); }
    }
    return result;
  };
  const saveEdits = async (review: InboxReview, edits: ReviewEdits) => {
    const id = review.frontmatter.id;
    if (active.current.has(id) || busy || readOnly) return;
    active.current.add(id); setActiveId(id); setActionError("");
    try { const result = await onSave(review, edits); if (result !== false) notify("Proposal updated"); }
    catch (caught) { setActionError(errorText(caught)); }
    finally { active.current.delete(id); setActiveId(undefined); }
  };

  useInboxKeys({
    detailRef, setTab,
    step: (direction) => step.current(direction),
    toggleOpenChecked: () => {
      if (!selected || !visibleIds.includes(selected.frontmatter.id)) return false;
      toggleChecked(selected.frontmatter.id); return true;
    }
  });
  /** After a tab switch, an open item that is not in the new tab gives way to the tab's first item (wide screens; narrow shows the list). */
  const shownTab = useRef(tab);
  useEffect(() => {
    if (shownTab.current === tab) return;
    shownTab.current = tab;
    if (narrow || (openedId && visibleIds.includes(openedId))) return;
    if (visibleIds[0]) open(visibleIds[0], { replace: true });
  });
  const itemBusy = Boolean(busy || bulkRunning || (selected && activeId === selected.frontmatter.id));
  const allTicked = visible.length > 0 && ticked.length === visible.length;

  const ref = useListDetailReturn(selected?.frontmatter.id);
  return <div ref={ref} className={`inbox-workspace pane-workspace${selected ? " detail-open" : ""}`} data-workspace="inbox" style={split.style}>
    <InboxToast message={notification} />
    <InboxQueue visible={visible} reviewCount={reviews.length} tabCounts={tabCounts} tab={tab} query={query} advanced={advanced} meetings={meetings} meetingId={meetingId} period={period} openedId={openedId}
      checked={checked} ticked={ticked} acceptableCount={acceptable.length} allTicked={allTicked} loading={loading} error={error} busy={busy} readOnly={readOnly} bulkRunning={bulkRunning}
      hidden={narrow && Boolean(selected)} displayTimeZone={displayTimeZone}
      onTab={setTab} onQuery={setQuery} onToggleAdvanced={() => setAdvanced(!advanced)} onMeeting={setMeetingId} onPeriod={setPeriod} onClearFilters={clearFilters}
      onOpen={(id) => open(id)} onToggleChecked={toggleChecked} onSelectAll={() => setChecked(new Set(visibleIds))} onDeselectAll={() => setChecked(new Set())} onDecideTicked={(outcome) => void decideTicked(outcome)} />
    {!narrow && <div {...split.dividerProps} />}
    <InboxReadingPane paneRef={detailRef} selected={selected} hidden={narrow && !selected} position={position} total={visibleIds.length} previousId={previousId} followingId={followingId} readOnly={readOnly} actionError={actionError}
      objectById={objectById} labels={labels} choices={choices} itemBusy={itemBusy} nextId={selected ? nextAfter(selected.frontmatter.id) : undefined} linkActions={selected ? linkActionsFor?.(selected.frontmatter.id) : undefined}
      onBack={back} onStep={(direction) => void step.current(direction)}
      onAccept={() => selected && void decide(selected, "accepted", () => onAccept(selected))} onReject={() => selected && void decide(selected, "rejected", () => onReject(selected))}
      onSave={(edits) => { if (selected) void saveEdits(selected, edits); }}
      onLinkCompletion={(outcome, nextId) => selected && linkFinished(selected, nextId, outcome)} />
  </div>;
}
