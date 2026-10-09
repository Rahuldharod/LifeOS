// ADR 0015: tells the server someone is using LifeOS on this Mac, so it keeps the write lease.
// Sent only after a real key press, click, scroll or pointer move, in a visible and focused tab, at most once a minute.
// Timers, background refreshes and an open-but-unattended tab never send it, so an idle Mac lets the lease go.
import { useEffect, useRef } from "react";

export const activityIntervalMs = 60_000;
const inputEvents = ["keydown", "pointerdown", "pointermove", "wheel", "scroll", "touchstart"] as const;

export function shouldSendActivity(state: { visible: boolean; focused: boolean; lastSentAt?: number; now: number }) {
  return state.visible && state.focused && (state.lastSentAt === undefined || state.now - state.lastSentAt >= activityIntervalMs);
}

/** Calls `send` on user input, throttled. `send` resolves with nothing; failures are ignored (the next input retries). */
export function useActivityHeartbeat(send: () => Promise<unknown>) {
  const latest = useRef(send);
  latest.current = send;
  useEffect(() => {
    let lastSentAt: number | undefined;
    const onInput = () => {
      const now = Date.now();
      if (!shouldSendActivity({ visible: document.visibilityState === "visible", focused: document.hasFocus(), lastSentAt, now })) return;
      lastSentAt = now;
      void latest.current().catch(() => undefined);
    };
    for (const name of inputEvents) window.addEventListener(name, onInput, { passive: true, capture: true });
    return () => { for (const name of inputEvents) window.removeEventListener(name, onInput, { capture: true }); };
  }, []);
}
