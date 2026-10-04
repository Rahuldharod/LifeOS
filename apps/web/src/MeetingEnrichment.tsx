// #87: a meeting's enrichment state (PRD story 32), its missing and unavailable material, and
// "Give up" (story 40) while material is still awaited. The state is shown as text, never colour alone.
import React from "react";

const stateLabels = { none: "Not requested", requested: "Requested", enriched: "Enriched", partial: "Partial", gave_up: "Gave up" } as const;
type EnrichmentState = keyof typeof stateLabels;
const materialLabels: Record<string, string> = { "meet-transcript": "Meet transcript", "meet-recording": "Meet recording", "gong-call": "Gong call", "gong-summary-email": "Gong summary email" };

const materialNames = (value: unknown) => (Array.isArray(value) ? value : []).map((kind) => materialLabels[String(kind)]).filter((name): name is string => Boolean(name));

/** What the meeting page shows, from the meeting's front matter. Unknown states read as "not requested", as on the server. */
export function enrichmentView(frontmatter: Record<string, unknown>) {
  const raw = frontmatter.enrichment_state;
  const state: EnrichmentState = typeof raw === "string" && raw in stateLabels ? raw as EnrichmentState : "none";
  return {
    state,
    label: stateLabels[state],
    missing: materialNames(frontmatter.enrichment_missing_material),
    unavailable: materialNames(frontmatter.enrichment_unavailable_material),
    // The server refuses an enriched meeting and ignores a repeat; "none" has nothing to wait for yet.
    canGiveUp: state === "requested" || state === "partial"
  };
}

export function MeetingEnrichment({ title, frontmatter, disabled, onGiveUp }: { title: string; frontmatter: Record<string, unknown>; disabled: boolean; onGiveUp: () => void }) {
  const view = enrichmentView(frontmatter);
  return <div className="meeting-enrichment">
    <div className="meta"><small>Enrichment</small><b>{view.label}</b></div>
    {view.missing.length > 0 && <div className="meta"><small>Missing material</small><b>{view.missing.join(", ")}</b></div>}
    {view.unavailable.length > 0 && <div className="meta"><small>Not available</small><b>{view.unavailable.join(", ")}</b></div>}
    {view.canGiveUp && <button type="button" aria-label={`Give up waiting for material from ${title}`} disabled={disabled} onClick={onGiveUp}>Give up</button>}
  </div>;
}
