import { useEffect, useRef, type RefObject } from "react";
import { useBlocker, useLocation, useNavigate } from "react-router";
import { needsSaveBeforeLeaving, saveBeforeLeaving, settleBlockedNavigation, type GuardedEditor } from "./navigationGuard.js";

export const leaveFailedMessage = "Save, discard, or resolve the work you are editing, then try again.";

export type GuardedNavigation = {
  /** Saves the open notes, then moves to `path`; false (and nothing moves) when the save fails. */
  go: (path: string, options?: { replace?: boolean }) => Promise<boolean>;
  /** Moves to `path` without saving: for callers that already saved, or a URL for the same item. */
  follow: (path: string, options?: { replace?: boolean }) => void;
  /** Saves the open notes without moving; false after telling the user why. */
  leave: () => Promise<boolean>;
  /** True while a held Back/Forward is saving; nothing else should change the URL meanwhile. */
  settling: RefObject<boolean>;
  /**
   * PB-035: the path an in-app move is still going to, until the router has finished it. Until then the
   * rendered location is one step behind, so "is this where we already are?" must compare against this.
   */
  pending: RefObject<string | undefined>;
};

/**
 * PB-027: every navigation saves the open notes first. In-app moves save before changing the URL;
 * Back/Forward (and any other URL change the app did not start) is held by the router until the
 * same save succeeds, and cancelled when it fails.
 */
export function useGuardedNavigation({ editors, readOnly, onLeaveFailed }: { editors: GuardedEditor[]; readOnly: boolean; onLeaveFailed: (message: string) => void }): GuardedNavigation {
  const navigate = useNavigate();
  const location = useLocation();
  const latest = useRef({ editors, readOnly, onLeaveFailed, pathname: location.pathname });
  latest.current = { editors, readOnly, onLeaveFailed, pathname: location.pathname };
  // True only during the app's own navigate() call. The router asks the blocker synchronously
  // inside that call, so this cannot leak into a later Back/Forward.
  const guardSkipped = useRef(false);
  const settling = useRef(false);
  const pending = useRef<string | undefined>(undefined);
  // The router finishes a move a moment before the next render shows it, so `pending` is released only once a
  // render shows that path, or shows somewhere else after the move settled (a newer move or Back/Forward won).
  const settled = useRef(false);
  const rendered = `${location.pathname}${location.hash}`;
  const lastRendered = useRef(rendered);
  if (pending.current !== undefined && (pending.current === rendered || pending.current === location.pathname || (settled.current && rendered !== lastRendered.current))) pending.current = undefined;
  lastRendered.current = rendered;

  const blocker = useBlocker(({ currentLocation, nextLocation }) => !guardSkipped.current
    && currentLocation.pathname !== nextLocation.pathname
    && needsSaveBeforeLeaving(latest.current.editors, latest.current.readOnly));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    settling.current = true;
    void settleBlockedNavigation(blocker, () => saveBeforeLeaving(latest.current.editors, latest.current.readOnly), () => latest.current.onLeaveFailed(leaveFailedMessage))
      .finally(() => { settling.current = false; });
  }, [blocker.state]);

  const follow = (path: string, options: { replace?: boolean } = {}) => {
    if (path === (pending.current ?? latest.current.pathname)) return;
    pending.current = path; settled.current = false;
    guardSkipped.current = true;
    let moving: unknown;
    try { moving = navigate(path, { replace: options.replace }); } finally { guardSkipped.current = false; }
    void Promise.resolve(moving).finally(() => { if (pending.current === path) settled.current = true; });
  };
  const leave = async () => {
    if (await saveBeforeLeaving(latest.current.editors, latest.current.readOnly)) return true;
    latest.current.onLeaveFailed(leaveFailedMessage);
    return false;
  };
  const go = async (path: string, options: { replace?: boolean } = {}) => {
    if (!(await leave())) return false;
    follow(path, options);
    return true;
  };
  return { go, follow, leave, settling, pending };
}
