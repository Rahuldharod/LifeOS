// ADR 0015: shown on every page after this Mac released its write lease for inactivity. LifeOS never takes the
// lease back by itself; "Take back" is the existing takeover. If the other Mac has the lease now, the banner shows
// the same caution as the takeover card on System.
import React from "react";

export type LeaseBannerSession = { currentDeviceId: string; activeDeviceId: string; writeAllowed: boolean; releasedAfterIdle?: boolean };

/** The takeover caution, shared with the System card so both say the same. */
export const takeoverCaution = "Only take over after LifeOS is closed and Google Drive has finished synchronizing on the other computer.";

export function LeaseBanner({ session, idleMinutes, busy, onTakeBack }: { session?: LeaseBannerSession; idleMinutes?: number; busy: boolean; onTakeBack: () => void }) {
  if (!session || session.writeAllowed || !session.releasedAfterIdle) return null;
  const otherMac = session.activeDeviceId !== session.currentDeviceId ? session.activeDeviceId : undefined;
  const after = idleMinutes ? `after ${idleMinutes} minutes without activity` : "after a while without activity";
  return <article className="lease-warning" role="status"><span>READ-ONLY ON THIS MAC</span>
    {otherMac
      ? <><h3>{otherMac} is now editing</h3><p>This Mac gave up write access {after}, and {otherMac} has taken it.</p><p>{takeoverCaution}</p></>
      : <><h3>Editing is paused on this Mac</h3><p>This Mac gave up write access {after}, so your other Mac can edit. Nothing was lost. LifeOS will not take it back by itself.</p></>}
    <div className="capture-row"><button type="button" className="takeover" disabled={busy} onClick={onTakeBack}>Take back</button></div>
  </article>;
}
