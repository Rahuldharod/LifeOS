import React from "react";
import { InlineNotice } from "./InlineNotice.js";

/**
 * Shown instead of letting the visual editor save when its own round trip of the note would drop an
 * image (#91). The editor is made read-only alongside it, so the loss can never reach the file.
 */
export function ImageLossNotice({ lost }: { lost: string[] | undefined }) {
  if (!lost?.length) return null;
  const count = lost.length === 1 ? "an image" : `${lost.length} images`;
  return (
    <InlineNotice className="image-loss-notice" role="alert" title="Visual mode can't save this note">
      Saving here would lose {count}: {lost.join("; ")}. Editing is turned off in Visual mode so nothing is lost. Use Markdown mode to edit this note.
    </InlineNotice>
  );
}
