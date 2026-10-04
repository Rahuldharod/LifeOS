// "Mark restricted" / "Mark normal" for Decisions, Open Points and meetings (#86, ADR 0010). Notes keep
// their checkbox in NoteHeader. The state is given in words and by the lock badge, never by colour alone,
// and the change is a guarded write: a stale hash fails with a plain conflict message and the page reloads.
import React from "react";
import { api, ApiError } from "./api.js";
import { LockBadge } from "./EnvelopeBadges.js";
import { isRestricted } from "./envelope.js";

export type SensitivityObject = { frontmatter: Record<string, unknown> & { id: string }; contentHash: string };
type Call = <T>(url: string, options?: RequestInit) => Promise<T>;

/** Flips the object's sensitivity through POST /objects/:id/sensitivity, guarded by its content hash. */
export async function changeSensitivity(object: SensitivityObject, noun: string, call: Call = api) {
  const sensitivity = isRestricted(object.frontmatter) ? "normal" : "restricted";
  try {
    await call(`/api/v1/objects/${object.frontmatter.id}/sensitivity`, { method: "POST", body: JSON.stringify({ sensitivity, expectedHash: object.contentHash }) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) throw new Error(`This ${noun} was changed elsewhere, so its sensitivity was not changed. The latest version is loaded; try again.`);
    throw error;
  }
}

/**
 * The toast after a change. #92: a meeting whose note is restricted stays excluded after 'Mark normal' (#63),
 * so the message says so instead of promising it can be shared again.
 */
export function sensitivityToast(restricted: boolean, noun: string, restrictedByNote = false) {
  if (!restricted) return `Marked restricted: this ${noun} is kept away from Agents`;
  if (restrictedByNote) return `Marked normal, but this ${noun} stays kept away from Agents and Work Orders because its note is restricted`;
  return `Marked normal: this ${noun} can be shared with Agents again`;
}

export function SensitivityToggle({ object, noun, note, restrictedByNote, disabled, run, onChanged }: {
  object: SensitivityObject;
  /** What the object is called in messages, e.g. "decision". */
  noun: string;
  /** Extra words shown beside the state, e.g. why a meeting is restricted by its note. */
  note?: string;
  /** #92: a meeting whose note is restricted, so it stays excluded even when marked normal. */
  restrictedByNote?: boolean;
  disabled: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<boolean>;
  /** Reloads what is on disk, after success or failure (a conflict means someone else saved first). */
  onChanged: () => Promise<void>;
}) {
  const restricted = isRestricted(object.frontmatter);
  const toggle = async () => {
    await run(() => changeSensitivity(object, noun), sensitivityToast(restricted, noun, restrictedByNote));
    await onChanged();
  };
  return <span className="sensitivity-control" role="group" aria-label={`Sensitivity of this ${noun}`}>
    <small>Sensitivity: <b>{restricted ? "Restricted" : "Normal"}</b></small>
    <LockBadge frontmatter={object.frontmatter} />
    {note && <small className="muted">{note}</small>}
    <button type="button" disabled={disabled} onClick={() => void toggle()}>{restricted ? "Mark normal" : "Mark restricted"}</button>
  </span>;
}
