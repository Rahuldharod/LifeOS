import React, { useRef, useState } from "react";
import type { InboxHistoryEntry } from "@lifeos/contracts";
import { LockBadge } from "./EnvelopeBadges.js";
import { dateBucket, dayOf, errorText, kindClass, kindOf, type UndoResult } from "./inboxModel.js";
import { InboxToast, useInboxToast, type ToastAction } from "./InboxToast.js";
import "./InboxHistory.css";

export type HistoryFilter = "All" | "Mine" | "System";
const filters: HistoryFilter[] = ["All", "Mine", "System"];
const actionWords: Record<InboxHistoryEntry["action"], string> = { accepted: "Accepted", rejected: "Rejected", merged: "Merged", "kept-separate": "Kept separate", applied: "Applied", linked: "Linked" };
/** An action that put nothing in the world: undoing it puts the item back, so the way to change the result is to reopen it. */
const isReopen = (entry: InboxHistoryEntry) => entry.source === "review" && (entry.action === "rejected" || entry.action === "kept-separate");

/** "Open task", "Open person": what an accept created or changed. */
export const openLabel = (entry: InboxHistoryEntry) => {
  const noun = entry.reviewType === "person-merge" ? "person" : entry.reviewType === "create" ? kindOf("create", entry.targetObjectType).toLowerCase() : entry.targetObjectType ? entry.targetObjectType.replaceAll("-", " ") : "item";
  return `Open ${noun}`;
};

const whenOf = (iso: string, now: Date, timeZone: string) => {
  if (Number.isNaN(Date.parse(iso))) return iso;
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
  const bucket = dateBucket(iso, now, timeZone);
  const day = bucket === "Today" || bucket === "Yesterday" ? bucket : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(new Date(dayOf(iso, timeZone) + "T12:00:00Z"));
  return `${day} ${time}`;
};

/** The Inbox History tab (CONTEXT.md): the last 100 Review actions, newest first, with Undo and a way to change the result. */
export function InboxHistory({ entries, switcher, loading = false, error, busy, readOnly, displayTimeZone, now = new Date(), onUndo, onUndoPatch, onOpenObject, onReopen }: {
  entries: InboxHistoryEntry[]; switcher: React.ReactNode; loading?: boolean; error?: string; busy: boolean; readOnly: boolean; displayTimeZone: string; now?: Date;
  /** Undoes these Review Items; the server's refusal is each item's reason (the same call as the toast's Undo). */
  onUndo: (ids: string[]) => Promise<UndoResult>;
  /** Undoes an applied Patch Draft by its audit event ID; rejects with the server's reason. */
  onUndoPatch: (entry: InboxHistoryEntry) => Promise<void>;
  /** Opens the object an accept created or changed. */
  onOpenObject: (objectId: string) => void;
  /** The item is pending again: go to the Inbox with it focused. */
  onReopen: (reviewId: string) => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>("All");
  const toasts = useInboxToast(); const { notify } = toasts;
  const running = useRef(false);
  const shown = entries.filter((entry) => filter === "All" || (filter === "Mine" ? entry.actor === "you" : entry.actor === "system"));
  const locked = busy || readOnly;
  const view = (objectId: string | undefined): ToastAction[] => objectId ? [{ id: "view", label: "View", run: () => onOpenObject(objectId) }] : [];

  /** Undo one row. A refusal says why and, for an accept, offers to open the object that was changed since. */
  const undo = async (entry: InboxHistoryEntry, then?: (reviewId: string) => void) => {
    if (running.current) return;
    running.current = true;
    try {
      if (entry.source === "patch") { await onUndoPatch(entry); notify(`Undid the change to ${entry.title}`); return; }
      const { undone, refused } = await onUndo([entry.reviewId!]);
      if (refused.length) { notify(`Not undone: ${refused.map((one) => one.reason).join("; ")}`, view(entry.objectId)); return; }
      if (undone.length) { if (then) then(entry.reviewId!); else notify("1 proposal back in the Inbox"); }
    } catch (caught) { notify(`Not undone: ${errorText(caught)}`, view(entry.objectId)); }
    finally { running.current = false; }
  };

  return <section className="inbox-history" aria-label="Inbox History" data-workspace="inbox-history">
    <InboxToast toast={toasts.toast} onHold={toasts.hold} onRelease={toasts.release} />
    <header className="workspace-heading"><div><span>INBOX · HISTORY</span><h2>Review actions</h2><p className="muted">Last 100, newest first. Undo puts an item back or takes its change back.</p></div>{switcher}</header>
    <div className="inbox-history-chips" role="group" aria-label="Who took the action">
      {filters.map((name) => <button key={name} type="button" aria-pressed={filter === name} className={filter === name ? "selected" : ""} onClick={() => setFilter(name)}>{name}</button>)}
    </div>
    {loading ? <div className="inbox-state" aria-busy="true">Loading history…</div>
      : error ? <div className="inbox-state failure" role="alert">{error}</div>
      : shown.length === 0 ? <div className="inbox-state"><h3>{entries.length ? "No matching actions" : "No Review actions yet"}</h3><p>{entries.length ? `Nothing in the last ${entries.length} was taken by ${filter === "Mine" ? "you" : "the System"}.` : "Accept or reject a proposal and it is listed here."}</p></div>
      : <table className="inbox-history-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>
        {shown.map((entry) => {
          const kind = kindOf(entry.reviewType, entry.targetObjectType);
          return <tr key={entry.id} className={entry.undone ? "undone" : ""} data-history-id={entry.id}>
            <td className="when">{whenOf(entry.at, now, displayTimeZone)}</td>
            <td>{entry.actor === "system" ? <span className="inbox-history-system">System</span> : "You"}</td>
            <td className="outcome">{actionWords[entry.action]}</td>
            <td className="item"><span className={`inbox-badge ${kindClass(kind)}`}>{kind}</span> <strong>{entry.title}</strong> <LockBadge frontmatter={{ sensitivity: entry.restricted ? "restricted" : "normal" }} />
              {(entry.sourceMeetingTitle || entry.summary) && <small> · {[entry.sourceMeetingTitle, entry.summary].filter(Boolean).join(" · ")}</small>}</td>
            <td className="actions">{entry.undone ? <em>Undone</em> : <>
              {entry.undoable && <button type="button" disabled={locked} aria-label={`Undo: ${entry.title}`} onClick={() => void undo(entry)}>Undo</button>}
              {isReopen(entry) ? entry.undoable && <button type="button" disabled={locked} aria-label={`Reopen in Inbox: ${entry.title}`} onClick={() => void undo(entry, onReopen)}>Reopen in Inbox</button>
                : entry.objectId && <button type="button" aria-label={`${openLabel(entry)}: ${entry.title}`} onClick={() => onOpenObject(entry.objectId!)}>{openLabel(entry)}</button>}
            </>}</td>
          </tr>;
        })}
      </tbody></table>}
  </section>;
}
