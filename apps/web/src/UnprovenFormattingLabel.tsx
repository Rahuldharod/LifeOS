import React from "react";
import type { RoundTripReport } from "./editorMarkdown.js";

/** Shown above the visual editor when saving from it would rewrite Markdown the user did not edit (#89, PB-003). */
export function UnprovenFormattingLabel({ report }: { report: RoundTripReport | undefined }) {
  if (!report || report.lossless) return null;
  return (
    <p className="unproven-formatting" role="note">
      <strong>Unproven formatting</strong> Editing here may rewrite parts of this note you did not touch: {report.constructs.join(", ")}. Use Markdown mode to keep it exactly as written.
    </p>
  );
}
