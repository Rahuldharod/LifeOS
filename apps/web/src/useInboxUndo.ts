import { useRef } from "react";
import { isReviewActionUndoable } from "@lifeos/shared";
import { errorText, reviewType, type InboxReview, type Outcome, type UndoResult } from "./inboxModel.js";
import type { ToastAction, useInboxToast } from "./InboxToast.js";

type Toasts = ReturnType<typeof useInboxToast>;

const count = (n: number) => n === 1 ? "1 proposal" : `${n} proposals`;

/**
 * ADR 0025: after a Review action the toast offers Undo (and Z) and View. One Undo covers the whole batch of a bulk
 * action. `announce` replaces the plain toast; `undoLast` is the Z key (only while the toast is on screen).
 */
export function useInboxUndo({ toasts, onUndo, onView, onRestored }: {
  toasts: Toasts;
  /** Undoes these Review Items, one request each; without it the Inbox shows no Undo. */
  onUndo?: (ids: string[]) => Promise<UndoResult>;
  /** Opens an object (the one an accept created). */
  onView?: (objectId: string) => void;
  /** Items are back in the Inbox: the first becomes the Focused item. */
  onRestored: (ids: string[]) => void;
}) {
  const running = useRef(false);
  const { notify } = toasts;
  const view = (objectId: string): ToastAction[] => onView ? [{ id: "view", label: "View", run: () => onView(objectId) }] : [];

  const undo = async (ids: string[], objects: Record<string, string>) => {
    if (!onUndo || running.current) return;
    running.current = true;
    try {
      const { undone, refused } = await onUndo(ids);
      if (undone.length) onRestored(undone);
      if (!refused.length) { notify(`${count(undone.length)} back in the Inbox`); return; }
      // A refusal says why and offers to open the object that was changed since the accept.
      const reasons = [...new Set(refused.map((entry) => entry.reason))].join("; ");
      const opens = refused.map((entry) => objects[entry.id]).find((id): id is string => Boolean(id));
      notify(undone.length ? `${undone.length} of ${ids.length} undone · ${refused.length} not undone: ${reasons}` : `Not undone: ${reasons}`, opens ? view(opens) : []);
    } catch (caught) { notify(`Not undone: ${errorText(caught)}`); }
    finally { running.current = false; }
  };

  /** Shows `message` for a Review action on `decided`; `objects` maps accepted items to what they created. */
  const announce = (message: string, decided: InboxReview[], outcome: Outcome, objects: Record<string, string> = {}) => {
    const undoable = decided.filter((review) => isReviewActionUndoable(reviewType(review), outcome));
    if (!onUndo || !undoable.length) { notify(message); return; }
    const ids = undoable.map((review) => review.frontmatter.id);
    const created = ids.map((id) => objects[id]).filter((id): id is string => Boolean(id));
    const actions: ToastAction[] = [{ id: "undo", label: "Undo", key: "Z", run: () => void undo(ids, objects) }];
    if (outcome === "accepted" && created.length === 1 && undoable.length === 1) actions.push(...view(created[0]!));
    notify(message, actions);
  };

  /** Z: undoes the last Review action while its toast shows. */
  const undoLast = () => { const action = toasts.action("undo"); if (!action) return false; action.run(); return true; };
  return { announce, undoLast };
}
