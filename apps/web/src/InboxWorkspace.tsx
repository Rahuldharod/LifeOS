import React, { useEffect, useMemo, useRef, useState } from "react";
import type { LifeObject, ObjectLink, PersonLabel, ReviewEdits } from "@lifeos/contracts";
import type { LinkCardActions } from "./LinkResolutionCard.js";
import { InboxQueue } from "./InboxQueue.js";
import { InboxReadingPane } from "./InboxReadingPane.js";
import { InboxToast, useInboxToast } from "./InboxToast.js";
import { InboxShortcutSheet } from "./InboxShortcutSheet.js";
import { InboxBulkEdit } from "./InboxBulkEdit.js";
import { bulkEditChanges, bulkEditPlan, bulkFieldLabel, missingFieldNote, type BulkEditChange, type BulkFieldKey, type EditResult } from "./bulkEditModel.js";
import { useInboxKeys } from "./useInboxKeys.js";
import { useInboxUndo } from "./useInboxUndo.js";
import { adjacentId, createdWindow, errorText, groupKey, groupReviews, inboxTabs, needsChoice, proposalTab, rangeIds, reviewRowCells, reviewType, type ActionResult, type BulkResult, type UndoResult, type CreatedPeriod, type InboxReview, type InboxTab, type Outcome, type ReviewChoices } from "./inboxModel.js";
import type { InboxView } from "./useInboxView.js";
import { useSplitPane } from "./splitPane.js";
import { useListDetailReturn } from "./useListDetailReturn.js";
import { useInboxRowLayout } from "./useInboxRowLayout.js";
import { useInboxView } from "./useInboxView.js";
import { useNarrowWorkspace } from "./useNarrowWorkspace.js";
import "./InboxWorkspace.css";

export type { BulkResult, InboxReview, InboxTab, ReviewChoices, UndoResult } from "./inboxModel.js";
export type { BulkEditChange, EditResult } from "./bulkEditModel.js";

const count = (n: number) => n === 1 ? "1 proposal" : `${n} proposals`;

/** The Inbox page: owns the state (filters, opened item, ticks, decisions) and composes the queue, reading pane, keys and toast. */
export function InboxWorkspace({ reviews, objects, labels, choices, selectedId, loading = false, error, busy, readOnly, displayTimeZone, now = new Date(), onOpen, onBack, onAccept, onReject, onSave, onEditMany, onDecideMany, onUndo, onView, linkActionsFor, switcher, processedToday, onSeeHistory }: {
  reviews: InboxReview[]; objects: Array<LifeObject | ObjectLink>; labels: Map<string, PersonLabel>; choices: ReviewChoices;
  selectedId?: string; loading?: boolean; error?: string; busy: boolean; readOnly: boolean; displayTimeZone: string; now?: Date;
  onOpen?: (id: string, options?: { replace?: boolean }) => void; onBack?: () => void;
  onAccept: (review: InboxReview) => Promise<ActionResult>; onReject: (review: InboxReview) => Promise<ActionResult>; onSave: (review: InboxReview, edits: ReviewEdits) => Promise<ActionResult>;
  /** PB-043 Bulk edit: saves each item's edits (one request each, one refresh at the end). Without it, the Inbox calls onSave per item. */
  onEditMany?: (changes: BulkEditChange[]) => Promise<EditResult>;
  /** Bulk decisions with one refresh at the end. Without it, the Inbox calls onAccept/onReject per item. */
  onDecideMany?: (reviews: InboxReview[], outcome: Outcome) => Promise<BulkResult>;
  /** ADR 0025: undoes these Review Items (one request each, one refresh at the end). Without it, the toast has no Undo. */
  onUndo?: (ids: string[]) => Promise<UndoResult>;
  /** Opens the object an accept created (the toast's View). Without it, the toast has no View. */
  onView?: (objectId: string) => void;
  linkActionsFor?: (reviewId: string) => LinkCardActions;
  /** The Inbox / History switch for the page header (#243). */
  switcher?: React.ReactNode;
  /** #244: Review actions made today (from History), and the button that opens the History tab, for the Inbox zero screen. */
  processedToday?: number; onSeeHistory?: () => void;
}) {
  const narrow = useNarrowWorkspace();
  const { view, setView } = useInboxView();
  /** One pane at a time: a narrow screen, or List view. The list is hidden while an item is open, and nothing opens by itself. */
  const oneUp = narrow || view === "list";
  const [openedId, setOpenedId] = useState<string | undefined>(() => selectedId ?? (oneUp ? undefined : reviews[0]?.frontmatter.id));
  /** Double-clicking the divider goes to List view; the width stays remembered for when the user comes back to Split. */
  const split = useSplitPane("inbox", { onDoubleClick: () => chooseView("list") });
  const [query, setQuery] = useState(""); const [tab, setTabState] = useState<InboxTab>("All"); const [advanced, setAdvanced] = useState(false);
  const [meetingId, setMeetingId] = useState(""); const [period, setPeriod] = useState<CreatedPeriod>("");
  const [deciding, setDeciding] = useState<InboxReview>(); const toasts = useInboxToast(); const { notify } = toasts; const [actionError, setActionError] = useState("");
  const [activeId, setActiveId] = useState<string>(); const active = useRef(new Set<string>());
  const [checked, setChecked] = useState<Set<string>>(() => new Set()); const [bulkRunning, setBulkRunning] = useState(false);
  const detailRef = useRef<HTMLElement>(null); const queueRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /** PB-044: the field picker that is open, and (with nothing ticked) the Focused item a letter key opened it for. */
  const [fieldOpen, setFieldOpen] = useState<BulkFieldKey>(); const [soloId, setSoloId] = useState<string>();
  const rowLayout = useInboxRowLayout(queueRef, oneUp && openedId !== undefined);

  /** The Focused item is what the keys act on; the Open item is what the reading pane shows. `dom` asks to move real keyboard focus to the row too. */
  const [focusState, setFocusState] = useState<{ id?: string; dom?: boolean }>({});
  const [helpOpen, setHelpOpen] = useState(false); const anchor = useRef<string | undefined>(undefined);

  const openedRef = useRef(openedId); openedRef.current = openedId;
  /** The route followed a link or the back button. When it only echoes an item the user just opened, leave focus where the keys have moved it since. */
  useEffect(() => { if (selectedId !== undefined && selectedId !== openedRef.current) { setOpenedId(selectedId); setFocusState({ id: selectedId }); } }, [selectedId]);

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
  /** The queue is grouped by date, then Source meeting / Agent run; `visible` is the same items in that on-screen order. */
  const groups = groupReviews(filtered.filter((review) => tab === "All" || proposalTab(review) === tab), { now, timeZone: displayTimeZone, meetingTitle: (id) => { const title = objectById.get(id)?.frontmatter.title; return typeof title === "string" ? title : undefined; } });
  const visible = groups.flatMap((group) => group.sources.flatMap((source) => source.items));
  /** Items in collapsed groups stay in `visible` (ticks, counts) but ↑/↓ and auto-advance skip them. */
  const hiddenIds = new Set(groups.flatMap((group) => group.sources.filter((source) => collapsed.has(groupKey(group.bucket, source))).flatMap((source) => source.items.map((review) => review.frontmatter.id))));
  const contextChoices = useMemo(() => new Map([...choices.projects, ...choices.clients, ...choices.products].map((choice) => [choice.id, choice.title])), [choices]);
  const contextName = (id: string) => contextChoices.get(id) ?? (typeof objectById.get(id)?.frontmatter.title === "string" ? String(objectById.get(id)!.frontmatter.title) : undefined);
  const personName = (id: string) => labels.get(id)?.label ?? choices.people.find((person) => person.id === id)?.title;
  const cellsFor = (review: InboxReview) => reviewRowCells(review, { personName, contextName });
  const toggleGroup = (key: string) => setCollapsed((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; });
  /** Bulk actions only touch ticked items that are on screen now. */
  const ticked = visible.filter((review) => checked.has(review.frontmatter.id));
  const acceptable = ticked.filter((review) => !needsChoice(review));
  const visibleIds = visible.map((review) => review.frontmatter.id);
  /** The Focused item: the last one the user moved to, else the Open item, else the first one shown (a decided or collapsed item gives way). */
  const shownIds = visibleIds.filter((id) => !hiddenIds.has(id));
  const focusedId = focusState.id && shownIds.includes(focusState.id) ? focusState.id : openedId && shownIds.includes(openedId) ? openedId : shownIds[0];
  const focusedRef = useRef(focusedId); focusedRef.current = focusedId;
  /** Where focus was put, before the "decided item gave way" fallback: a decision refreshes the list mid-flight, so `focusedId` can already have moved on. */
  const focusSourceRef = useRef(focusState.id ?? openedId); focusSourceRef.current = focusState.id ?? openedId;
  useEffect(() => {
    if (!focusState.dom || !focusState.id) return;
    const row = [...(queueRef.current?.querySelectorAll<HTMLElement>("[data-review-id]") ?? [])].find((element) => element.dataset.reviewId === focusState.id);
    row?.querySelector<HTMLElement>(".inbox-row-open")?.focus(); // real focus scrolls the row into view and announces it
  }, [focusState]);
  /** Keyboard focus is on the page or in the list (not in the reading pane or a field), so it may follow the Focused item. */
  const listHasKeyboard = () => { const element = globalThis.document.activeElement; return !element || element === globalThis.document.body || Boolean(queueRef.current?.contains(element)); };

  useEffect(() => {
    if (oneUp || openedId || !visible.length) return;
    setOpenedId(visible[0]!.frontmatter.id);
  }, [oneUp, openedId, visible]);

  // While a decision saves, the refresh drops the item from `reviews`; keep showing it until the Inbox moves on (no "Select a proposal" flash).
  const selected = reviews.find((review) => review.frontmatter.id === openedId) ?? (deciding?.frontmatter.id === openedId ? deciding : undefined);
  const open = (id: string, options?: { replace?: boolean }) => { setOpenedId(id); setFocusState({ id }); setActionError(""); onOpen?.(id, options); };
  /** Back to the list. Focus returns to the row that was open (List view and narrow screens hide the list while an item is open). */
  const back = () => { if (openedId) setFocusState({ id: openedId, dom: true }); setOpenedId(undefined); setActionError(""); onBack?.(); };
  /** Switching to List closes the open item (the list is the first thing the user sees); switching to Split opens the Focused item (the first one only when nothing is Focused). */
  const chooseView = (next: InboxView) => {
    if (next === view || narrow) return;
    setView(next);
    if (next === "list") back(); else if (focusedId) open(focusedId);
  };
  const setTab = (next: InboxTab) => { setTabState(next); setChecked(new Set()); };
  const clearFilters = () => { setQuery(""); setTab("All"); setMeetingId(""); setPeriod(""); };
  /** Tick or untick one item, or (`range`) tick everything from the last anchor to it. A plain tick sets the anchor. */
  const toggleChecked = (id: string, range = false) => {
    const rangeOf = range && anchor.current && anchor.current !== id ? rangeIds(visibleIds, hiddenIds, anchor.current, id) : undefined;
    if (!rangeOf) anchor.current = id;
    setChecked((current) => { const next = new Set(current); if (rangeOf) rangeOf.forEach((rangeId) => next.add(rangeId)); else if (!next.delete(id)) next.add(id); return next; });
  };
  /** Tick every item in a group, or untick them all when every one is already ticked. */
  const toggleGroupChecked = (items: InboxReview[]) => {
    const ids = items.map((review) => review.frontmatter.id);
    setChecked((current) => { const next = new Set(current); const all = ids.every((id) => next.has(id)); ids.forEach((id) => all ? next.delete(id) : next.add(id)); return next; });
  };
  const clearChecked = () => { anchor.current = undefined; setChecked(new Set()); };
  /** PB-035: the item below in the list, or the one above when the decided item was the bottom one. */
  const nextAfter = (id: string) => adjacentId(visibleIds, hiddenIds, id, 1) ?? adjacentId(visibleIds, hiddenIds, id, -1);
  /** PB-035: once a decision is recorded, open the next waiting item; after the last one, show the empty list state. */
  const advanceFrom = (id: string, nextId: string | undefined) => {
    if (openedRef.current !== undefined && openedRef.current !== id) return; // the user already moved on while the decision was saving
    if (nextId) { open(nextId, { replace: true }); return; }
    setOpenedId(undefined); setActionError("");
  };
  /** After a Review action on the Focused item, focus lands on the next item (the Open item advances separately, above). */
  const moveFocusOn = (decidedId: string, nextId: string | undefined, dom: boolean) => { if (nextId && focusSourceRef.current === decidedId) setFocusState({ id: nextId, dom }); };
  /** ADR 0025: an undone item is back in the list and becomes the Focused item. */
  const undoing = useInboxUndo({ toasts, onUndo, onView, onRestored: (ids) => setFocusState({ id: ids[0], dom: listHasKeyboard() }) });
  const decide = async (review: InboxReview, outcome: Outcome, action: () => Promise<ActionResult>) => {
    const id = review.frontmatter.id;
    if (active.current.has(id) || busy || readOnly) return;
    const nextId = nextAfter(id); const followWithKeyboard = listHasKeyboard();
    active.current.add(id); setActiveId(id); setActionError(""); setDeciding(review);
    try {
      const result = await action();
      if (result === false) return;
      const objectId = typeof result === "object" ? result.objectId : undefined;
      undoing.announce(`Proposal ${outcome}`, [review], outcome, objectId ? { [id]: objectId } : {});
      advanceFrom(id, nextId);
      moveFocusOn(id, nextId, followWithKeyboard);
    } catch (caught) { setActionError(errorText(caught)); }
    finally { active.current.delete(id); setActiveId((current) => current === id ? undefined : current); setDeciding((current) => current?.frontmatter.id === id ? undefined : current); }
  };
  /** Link-resolution cards run their own requests; once one finishes, the Inbox moves on the same way. */
  const linkFinished = (review: InboxReview, nextId: string | undefined, outcome: Outcome) => { const followWithKeyboard = listHasKeyboard(); undoing.announce(`Proposal ${outcome}`, [review], outcome); advanceFrom(review.frontmatter.id, nextId); moveFocusOn(review.frontmatter.id, nextId, followWithKeyboard); };
  const position = selected ? visibleIds.indexOf(selected.frontmatter.id) : -1;
  const previousId = selected ? adjacentId(visibleIds, hiddenIds, selected.frontmatter.id, -1) : undefined;
  const followingId = selected && position >= 0 ? adjacentId(visibleIds, hiddenIds, selected.frontmatter.id, 1) : undefined;
  const step = useRef<(direction: -1 | 1) => boolean>(() => false);
  step.current = (direction) => { const target = direction < 0 ? previousId : followingId; if (target) open(target); return Boolean(target); };

  /** Bulk Accept/Reject on a set of items (the ticked ones, or one group). Link and merge items are skipped on Accept and counted. Each item is its own idempotent request; a failure does not stop the rest. */
  const decideSet = async (pool: InboxReview[], outcome: Outcome) => {
    if (busy || readOnly || bulkRunning || !pool.length) return;
    const targets = outcome === "accepted" ? pool.filter((review) => !needsChoice(review)) : pool;
    const skipped = pool.length - targets.length;
    if (!targets.length) { if (skipped) notify(`${skipped} skipped (link or merge needs a choice)`); return; }
    const targetIds = new Set(targets.map((review) => review.frontmatter.id));
    const openId = openedRef.current;
    const skip = new Set([...hiddenIds, ...targetIds]);
    const nextId = openId ? adjacentId(visibleIds, skip, openId, 1) ?? adjacentId(visibleIds, skip, openId, -1) : undefined;
    const focusId = focusedRef.current; const followWithKeyboard = listHasKeyboard();
    const nextFocus = focusId && targetIds.has(focusId) ? adjacentId(visibleIds, skip, focusId, 1) ?? adjacentId(visibleIds, skip, focusId, -1) : undefined;
    setBulkRunning(true); setActionError("");
    try {
      const result = onDecideMany ? await onDecideMany(targets, outcome) : await decideEach(targets, outcome);
      const decided = new Set(result.decided);
      setChecked((current) => new Set([...current].filter((id) => !decided.has(id))));
      if (anchor.current && decided.has(anchor.current)) anchor.current = undefined;
      // One Undo covers the whole batch (ADR 0025).
      undoing.announce([`${decided.size === 1 ? "1 proposal" : `${decided.size} proposals`} ${outcome}`, ...(skipped ? [`${skipped} skipped (link or merge needs a choice)`] : [])].join(" · "), targets.filter((review) => decided.has(review.frontmatter.id)), outcome, result.objects);
      if (result.failures.length) setActionError(`${result.failures.length} not ${outcome}: ${result.failures.join("; ")}`);
      if (openId && decided.has(openId)) advanceFrom(openId, nextId);
      if (focusId && nextFocus && decided.has(focusId)) setFocusState({ id: nextFocus, dom: followWithKeyboard });
    } catch (caught) { setActionError(errorText(caught)); }
    finally { setBulkRunning(false); }
  };
  const decideTicked = (outcome: Outcome) => decideSet(ticked, outcome);
  const decideEach = async (targets: InboxReview[], outcome: Outcome): Promise<BulkResult> => {
    const result: BulkResult = { decided: [], failures: [], objects: {} };
    for (const review of targets) {
      try {
        const done = await (outcome === "accepted" ? onAccept(review) : onReject(review));
        if (done === false) { result.failures.push(review.frontmatter.title); continue; }
        result.decided.push(review.frontmatter.id);
        if (typeof done === "object" && done.objectId) result.objects![review.frontmatter.id] = done.objectId;
      }
      catch (caught) { result.failures.push(`${review.frontmatter.title}: ${errorText(caught)}`); }
    }
    return result;
  };
  /** Saves a set of edits; a failure does not stop the rest. */
  const saveEach = async (changes: BulkEditChange[]): Promise<EditResult> => {
    const result: EditResult = { edited: [], failures: [] };
    for (const { review, edits } of changes) {
      try { if (await onSave(review, edits) === false) result.failures.push(review.frontmatter.title); else result.edited.push(review.frontmatter.id); }
      catch (caught) { result.failures.push(`${review.frontmatter.title}: ${errorText(caught)}`); }
    }
    return result;
  };
  const saveMany = (changes: BulkEditChange[]) => onEditMany ? onEditMany(changes) : saveEach(changes);
  /** PB-043 Bulk edit acts on the ticked items; PB-044: with nothing ticked, on the Focused item a letter key opened a picker for. */
  const solo = ticked.length ? undefined : visible.find((review) => review.frontmatter.id === soloId);
  const editTargets = ticked.length ? ticked : solo ? [solo] : [];
  const bulkPlan = bulkEditPlan(editTargets);
  /** Closing a picker opened for the Focused item takes keyboard focus back to its row. */
  const openField = (key: BulkFieldKey | undefined) => {
    setFieldOpen(key);
    if (!key && soloId) { setFocusState({ id: soloId, dom: true }); setSoloId(undefined); }
  };
  /** PB-043 Bulk edit: sets one field on every target item that has it. The items stay pending and stay ticked; the toast offers Undo. */
  const editTargetsField = async (targets: InboxReview[], key: BulkFieldKey, value: string) => {
    if (busy || readOnly || bulkRunning) return;
    const plan = bulkEditPlan(targets);
    // PB-044: the Open item with unsaved edits in the reading pane is left alone, so the user's typing is never overwritten.
    const unsavedId = detailRef.current?.querySelector("[data-unsaved]") ? selected?.frontmatter.id : undefined;
    const items = plan.items.filter((review) => review.frontmatter.id !== unsavedId);
    const unsaved = plan.items.length - items.length;
    const { changes, undo, unchanged } = bulkEditChanges(items, key, value);
    const label = bulkFieldLabel[key];
    const skippedNote = [...(plan.skipped ? [`${plan.skipped} skipped (no ${label})`] : []), ...(unsaved ? [`${unsaved} skipped (unsaved edits)`] : [])];
    if (!changes.length) { notify([unchanged ? `${label} already set on ${count(unchanged)}` : `${label} not changed`, ...skippedNote].join(" · ")); return; }
    setBulkRunning(true); setActionError("");
    try {
      const result = await saveMany(changes);
      const edited = new Set(result.edited);
      const failed = changes.length - edited.size;
      const message = [`${label} updated on ${count(edited.size + unchanged)}`, ...skippedNote, ...(failed ? [`${failed} failed`] : [])].join(" · ");
      if (result.failures.length) setActionError(`${failed} not updated: ${result.failures.join("; ")}`);
      const restore = undo.filter((change) => edited.has(change.review.frontmatter.id));
      notify(message, restore.length ? [{ id: "undo", label: "Undo", key: "Z", run: () => void undoBulkEdit(label, restore) }] : []);
    } catch (caught) { setActionError(errorText(caught)); }
    finally { setBulkRunning(false); }
  };
  /** The toast's Undo for a Bulk edit: puts back each item's previous value. Not a Review action, so not in Inbox History. */
  const undoBulkEdit = async (label: string, restore: BulkEditChange[]) => {
    setBulkRunning(true);
    try {
      const result = await saveMany(restore);
      notify(result.failures.length ? `${result.edited.length} of ${restore.length} put back · not undone: ${result.failures.join("; ")}` : `${label} put back on ${count(result.edited.length)}`);
    } catch (caught) { notify(`Not undone: ${errorText(caught)}`); }
    finally { setBulkRunning(false); }
  };
  const saveEdits = async (review: InboxReview, edits: ReviewEdits) => {
    const id = review.frontmatter.id;
    if (active.current.has(id) || busy || readOnly) return;
    active.current.add(id); setActiveId(id); setActionError("");
    try { const result = await onSave(review, edits); if (result !== false) notify("Proposal updated"); }
    catch (caught) { setActionError(errorText(caught)); }
    finally { active.current.delete(id); setActiveId(undefined); }
  };

  /** Accept or Reject one item from the list (key or row button). When it is the Open item, its own detail buttons run, so unsaved edits still block Accept instead of being lost. */
  const decideItem = (target: InboxReview, outcome: Outcome) => {
    const id = target.frontmatter.id; const link = reviewType(target) === "link-resolution"; const open = id === selected?.frontmatter.id;
    if (open) {
      const control = detailRef.current?.querySelector<HTMLButtonElement>(`button[data-shortcut='${outcome === "accepted" ? "a" : "r"}']`);
      if (control && !control.disabled) control.click();
      else if (control && outcome === "accepted") {
        // Disabled for a reason the user can act on: unsaved edits, or a read-only Mac. While a decision is saving, say nothing.
        if (control.dataset.unsaved) notify("Save your edits first, then accept.");
        else if (readOnly) notify("Read-only on this Mac: click “Use LifeOS here” before accepting.");
      }
      if (control || !needsChoice(target)) return Boolean(control);
    }
    // An Open merge runs its own Merge button above (A). A link has no single Accept: the user picks the record in its card.
    if (needsChoice(target) && outcome === "accepted") { notify(open ? "Pick the record to link in the proposal." : `${link ? "Link" : "Merge"} proposals need a choice: open it to decide.`); return true; }
    const linkActions = link ? linkActionsFor?.(id) : undefined;
    void decide(target, outcome, outcome === "accepted" ? () => onAccept(target) : linkActions ? async () => { await linkActions.onReject(); } : () => onReject(target));
    return true;
  };
  /** A / R: every ticked item, else the Focused item. */
  const decideFocused = (outcome: Outcome) => {
    if (ticked.length) { void decideTicked(outcome); return true; }
    const target = visible.find((review) => review.frontmatter.id === focusedId);
    return target ? decideItem(target, outcome) : false;
  };
  /** A row's own button: it makes that row the Focused item first, so focus moves on from it like after a key. */
  const decideRow = (id: string, outcome: Outcome) => {
    const target = visible.find((review) => review.frontmatter.id === id);
    if (!target) return;
    setFocusState((current) => current.id === id ? current : { id });
    focusSourceRef.current = id;
    decideItem(target, outcome);
  };
  useInboxKeys({
    setTab,
    // On a narrow screen with a proposal open the list is hidden, so ↑/↓ step through the open proposals as before.
    moveFocus: (direction) => {
      if (oneUp && selected) return step.current(direction);
      if (!focusedId) return false;
      const target = adjacentId(visibleIds, hiddenIds, focusedId, direction);
      if (target) setFocusState({ id: target, dom: true });
      return true; // at either end the key is still ours, so the page does not scroll
    },
    openFocused: () => { if (!focusedId || focusedId === openedId) return false; open(focusedId); return true; },
    toggleFocused: (range) => { if (!focusedId) return false; toggleChecked(focusedId, range); return true; },
    decide: decideFocused,
    undo: undoing.undoLast,
    save: () => {
      const control = detailRef.current?.querySelector<HTMLButtonElement>("button[data-shortcut='s']");
      if (!control || control.disabled) return false;
      control.click(); return true;
    },
    clearSelection: () => {
      if (view === "list" && !narrow && selected) { back(); return true; }
      if (!checked.size) return false; clearChecked(); return true;
    },
    toggleView: () => { if (narrow) return false; chooseView(view === "split" ? "list" : "split"); return true; },
    // PB-044: O, D, I, J, C, P open a field's picker in the bulk bar, for the ticked items or else the Focused item, whenever the list shows.
    setField: (key) => {
      if (oneUp && selected) return false;
      const targets = ticked.length ? ticked : visible.filter((review) => review.frontmatter.id === focusedId);
      if (!targets.length) return false;
      if (readOnly) { notify("Read-only on this Mac: click “Use LifeOS here” before editing."); return true; }
      if (busy || bulkRunning) return true;
      const plan = bulkEditPlan(targets);
      if (!plan.fields.includes(key)) { notify(missingFieldNote(plan.items.length ? plan.items : targets, key) ?? `${bulkFieldLabel[key]} isn't available here`); return true; }
      setSoloId(ticked.length ? undefined : focusedId);
      setFieldOpen(key);
      return true;
    },
    showHelp: () => setHelpOpen(true)
  });
  /** After a tab switch, an open item that is not in the new tab gives way to the tab's first item (wide screens; narrow shows the list). */
  const shownTab = useRef(tab);
  useEffect(() => {
    if (shownTab.current === tab) return;
    shownTab.current = tab;
    if (oneUp || (openedId && visibleIds.includes(openedId))) return;
    if (visibleIds[0]) open(visibleIds[0], { replace: true });
  });
  const itemBusy = Boolean(busy || bulkRunning || (selected && activeId === selected.frontmatter.id));
  const allTicked = visible.length > 0 && ticked.length === visible.length;

  const ref = useListDetailReturn(selected?.frontmatter.id);
  return <div ref={ref} className={`inbox-workspace pane-workspace${selected ? " detail-open" : ""}`} data-workspace="inbox" data-view={narrow ? undefined : view} style={split.style}>
    <InboxToast toast={toasts.toast} held={toasts.held} onHold={toasts.hold} onRelease={toasts.release} />
    <InboxShortcutSheet open={helpOpen} onClose={() => setHelpOpen(false)} />
    <InboxQueue paneRef={queueRef} groups={groups} collapsed={collapsed} cellsFor={cellsFor} rowMode={rowLayout.mode} twoLine={rowLayout.twoLine} view={view} onView={narrow ? undefined : chooseView} switcher={switcher} onRowMode={rowLayout.setMode} onShowHelp={() => setHelpOpen(true)} onFocusRow={(id) => setFocusState((current) => current.id === id ? current : { id })} onToggleGroup={toggleGroup} visible={visible} reviewCount={reviews.length} tabCounts={tabCounts} tab={tab} query={query} advanced={advanced} meetings={meetings} meetingId={meetingId} period={period} openedId={openedId} focusedId={focusedId}
      checked={checked} ticked={ticked} acceptableCount={acceptable.length} allTicked={allTicked}
      bulkEdit={<InboxBulkEdit items={bulkPlan.items} fields={bulkPlan.fields} choices={choices} personName={personName} contextName={contextName} disabled={readOnly} pending={busy || bulkRunning}
        openKey={fieldOpen} scope={solo ? "Focused item" : undefined} onOpenKey={openField} onApply={(key, value) => void editTargetsField(editTargets, key, value)} />} loading={loading} error={error} busy={busy} readOnly={readOnly} bulkRunning={bulkRunning}
      hidden={oneUp && Boolean(selected)}
      onTab={setTab} onQuery={setQuery} onToggleAdvanced={() => setAdvanced(!advanced)} onMeeting={setMeetingId} onPeriod={setPeriod} onClearFilters={clearFilters} processedToday={processedToday} onSeeHistory={onSeeHistory}
      onOpen={(id) => open(id)} onToggleChecked={toggleChecked} onToggleGroupChecked={toggleGroupChecked} onSelectAll={() => setChecked(new Set(visibleIds))} onDeselectAll={clearChecked} onDecideTicked={(outcome) => void decideTicked(outcome)} onDecideRow={decideRow} onDecideGroup={(items, outcome) => void decideSet(items, outcome)} />
    {!oneUp && <div {...split.dividerProps} />}
    <InboxReadingPane paneRef={detailRef} selected={selected} hidden={oneUp && !selected} position={position} total={visibleIds.length} previousId={previousId} followingId={followingId} readOnly={readOnly} actionError={actionError}
      objectById={objectById} labels={labels} choices={choices} itemBusy={itemBusy} nextId={selected ? nextAfter(selected.frontmatter.id) : undefined} linkActions={selected ? linkActionsFor?.(selected.frontmatter.id) : undefined}
      onBack={back} onStep={(direction) => void step.current(direction)}
      onAccept={() => selected && void decide(selected, "accepted", () => onAccept(selected))} onReject={() => selected && void decide(selected, "rejected", () => onReject(selected))}
      onSave={(edits) => { if (selected) void saveEdits(selected, edits); }}
      onLinkCompletion={(outcome, nextId) => selected && linkFinished(selected, nextId, outcome)} />
  </div>;
}
