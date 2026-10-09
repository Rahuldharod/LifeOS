// "Copy link" button (PB-029): puts `[Title](lifeos://object/<id>)` on the clipboard as plain text.
// One component for every place it appears. Pass no object for something not saved yet.
import React, { useEffect, useRef, useState } from "react";
import { objectLinkMarkdown, type TitledObject } from "./objectLinkMarkdown.js";

/** Writes the object's link with `write`; never throws, so the caller can show "Couldn't copy". */
export async function copyObjectLink(object: TitledObject, write: ((text: string) => Promise<void>) | undefined): Promise<"copied" | "failed"> {
  try {
    if (!write) return "failed";
    await write(objectLinkMarkdown(object));
    return "copied";
  } catch {
    return "failed";
  }
}

export function CopyLink({ object, disabled }: { object: TitledObject | undefined; disabled?: boolean }) {
  const [result, setResult] = useState<"copied" | "failed">();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // A different object starts without the previous one's feedback.
  useEffect(() => { setResult(undefined); }, [object?.frontmatter.id]);

  async function copy() {
    if (!object) return;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    setResult(await copyObjectLink(object, clipboard ? (text) => clipboard.writeText(text) : undefined));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(undefined), 2500);
  }

  return <span className="copy-link">
    <button type="button" disabled={disabled || !object} title={object ? "Copy a link to this object" : "Save first to copy a link"} onClick={() => void copy()}>Copy link</button>
    <small role="status" aria-live="polite" className={result === "failed" ? "copy-link-failed" : undefined}>{result === "copied" ? "Copied" : result === "failed" ? "Couldn't copy" : ""}</small>
  </span>;
}
