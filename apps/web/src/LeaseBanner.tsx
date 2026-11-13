// ADR 0024: shown on every page while another Mac holds the write lease. That Mac keeps it for as long as LifeOS runs
// there, so this Mac stays read-only until the user clicks "Use LifeOS here" (the takeover). Nothing moves the lease
// by itself, except that a Mac which is asleep or shut down lets it expire after 15 minutes.
import React from "react";

export type LeaseBannerSession = { currentDeviceId: string; activeDeviceId: string; writeAllowed: boolean };

/** The takeover button label, shared with the System cards so all say the same. */
export const takeoverLabel = "Use LifeOS here";

/** The takeover caution, shared with the System cards so all say the same. */
export const takeoverCaution = "Saves on the other Mac stop once you switch. If you just edited there, let Google Drive finish syncing first.";

export function LeaseBanner({ session, busy, onTakeOver }: { session?: LeaseBannerSession; busy: boolean; onTakeOver: () => void }) {
  if (!session || session.writeAllowed) return null;
  return <article className="lease-warning" role="status"><span>READ-ONLY ON THIS MAC</span>
    <h3>LifeOS is in use on {session.activeDeviceId}</h3>
    <p>You can read everything here. To edit on this Mac, switch to it; {session.activeDeviceId} becomes read-only.</p>
    <p>{takeoverCaution}</p>
    <div className="capture-row"><button type="button" className="takeover" disabled={busy} onClick={onTakeOver}>{takeoverLabel}</button></div>
  </article>;
}
