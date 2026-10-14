// PB-034: the unsaved Standalone Note behind the Notes tab's "New note" button. The browser makes the id up front;
// nothing is written until the first real edit calls `createNote`, which the server treats as idempotent by id.
import { useRef, useState } from "react";
import type { LifeObject } from "@lifeos/contracts";
import { api } from "./api.js";
import { uuidV7 } from "./uuid.js";

export type NewNoteDraft = { id: string; title: string; key: string };

/** `Note 14 Oct 2026 14:05`: the same auto title the server would pick, in the display time zone. */
export function newNoteTitle(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `Note ${part("day")} ${part("month")} ${part("year")} ${part("hour")}:${part("minute")}`;
}

export function useNewStandaloneNote({ timeZone, onCreated }: { timeZone: string; onCreated: (note: LifeObject) => void }) {
  const [draft, setDraft] = useState<NewNoteDraft>();
  // Read by the controller's timer, which may fire after a later render, so these live in refs.
  const current = useRef<NewNoteDraft | undefined>(undefined);
  // Header choices made before the file exists; applied in the same write as the first edit.
  const held = useRef<Record<string, unknown>>({});
  // The note the first edit created, for an image drop that needs the file to exist before it is stored.
  const created = useRef<LifeObject | undefined>(undefined);

  const begin = () => {
    const id = uuidV7();
    const next = { id, title: newNoteTitle(new Date(), timeZone), key: `new-note:${id}` };
    current.current = next; held.current = {}; created.current = undefined; setDraft(next);
    return next;
  };
  const clear = () => { current.current = undefined; held.current = {}; setDraft(undefined); };
  const hold = (changes: Record<string, unknown>) => { held.current = { ...held.current, ...changes }; };

  /** The first real edit. Safe to repeat after a failure: the same id returns the same note. */
  const createNote = async (body: string) => {
    const target = current.current;
    if (!target) return undefined;
    const { title, ...metadata } = held.current;
    const note = await api("POST /api/v1/notes", { body: { id: target.id, body, title: typeof title === "string" ? title : target.title, ...(Object.keys(metadata).length ? { metadata } : {}), timeZone } });
    current.current = undefined; held.current = {};
    setDraft(undefined);
    created.current = note;
    onCreated(note);
    return note;
  };

  return { draft, created, begin, clear, hold, createNote };
}
