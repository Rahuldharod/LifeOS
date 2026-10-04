/**
 * #62: tracks accept/reject requests in flight per Review Item, synchronously. React's `busy` state
 * disables the buttons only on the next render, so a second click in the same frame would still send a
 * second request; `run` drops it instead (resolves `false`). The server also serialises per item.
 */
export function reviewInFlight() {
  const active = new Set<string>();
  return {
    busy: (reviewId: string) => active.has(reviewId),
    async run(reviewId: string, request: () => Promise<unknown>): Promise<boolean> {
      if (active.has(reviewId)) return false;
      active.add(reviewId);
      try { await request(); return true; }
      finally { active.delete(reviewId); }
    }
  };
}
