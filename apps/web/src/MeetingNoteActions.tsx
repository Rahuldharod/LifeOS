// #98: the meeting note's buttons. Save only saves: the app has no AI. Claude proposes tasks, decisions and
// open points through the LifeOS skills (ADR 0008), so the help line points there instead.
import React from "react";

export const meetingEnrichmentHelp = "To propose tasks, decisions and open points, ask Claude to run LifeOS enrichment on this meeting.";

export function MeetingNoteActions({ canDelete, deleteDisabled, saveDisabled, onDelete, onSave }: { canDelete: boolean; deleteDisabled: boolean; saveDisabled: boolean; onDelete: () => void; onSave: () => void }) {
  return <div className="actions">
    {canDelete && <button type="button" className="danger" disabled={deleteDisabled} onClick={onDelete}>Delete note</button>}
    <button type="button" className="primary" disabled={saveDisabled} title={meetingEnrichmentHelp} onClick={onSave}>Save</button>
  </div>;
}
