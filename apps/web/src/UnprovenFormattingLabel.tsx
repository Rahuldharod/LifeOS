import React from "react";
import { InlineNotice } from "./InlineNotice.js";
import type { RoundTripReport } from "./editorMarkdown.js";

/** Shown above the visual editor when saving from it would rewrite Markdown the user did not edit (#89, PB-003). */
export function UnprovenFormattingLabel({ report }: { report: RoundTripReport | undefined }) {
  if (!report || report.lossless) return null;
  return (
    <InlineNotice className="unproven-formatting" role="note" title="Unproven formatting">
      Editing here may rewrite parts of this note you did not touch: {report.constructs.join(", ")}. Use Markdown mode to keep it exactly as written.
    </InlineNotice>
  );
}
