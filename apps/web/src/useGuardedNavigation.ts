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
    if (path === latest.current.pathname) return;
    guardSkipped.current = true;
    try { void navigate(path, { replace: options.replace }); } finally { guardSkipped.current = false; }
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
  return { go, follow, leave, settling };
}
