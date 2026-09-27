// Tracks which Markdown version a Notes draft was based on. Saves must send this
// base hash, never the hash from a refreshed list, or an external edit that the
// refresh picked up would pass the server's conflict check and be overwritten.

export type DraftableNote = { frontmatter: { id: string }; body: string; contentHash: string };
export type CachedNoteDraft = { body: string; baseHash: string };
export type NoteDraftBase = { noteId: string; hash: string; body?: string };

export const noteDraftBase = (note: DraftableNote): NoteDraftBase => ({ noteId: note.frontmatter.id, hash: note.contentHash, body: note.body });

export function openNoteDraft(note: DraftableNote, cached?: CachedNoteDraft) {
  if (!cached) return { base: noteDraftBase(note), draft: note.body, conflict: false };
  const base = cached.baseHash === note.contentHash ? noteDraftBase(note) : { noteId: note.frontmatter.id, hash: cached.baseHash };
  return { base, draft: cached.body, conflict: cached.baseHash !== note.contentHash };
}

export type NoteDraftReconciliation =
  | { kind: "unchanged" }
  | { kind: "resync"; base: NoteDraftBase; draft: string }
  | { kind: "conflict" };

/** Decide what to do when a refreshed copy of the open note arrives. */
export function reconcileNoteDraft(base: NoteDraftBase, draft: string, refreshed: DraftableNote): NoteDraftReconciliation {
  if (refreshed.frontmatter.id !== base.noteId || refreshed.contentHash === base.hash) return { kind: "unchanged" };
  const untouched = base.body !== undefined && draft === base.body;
  if (untouched || draft === refreshed.body) return { kind: "resync", base: noteDraftBase(refreshed), draft: refreshed.body };
  return { kind: "conflict" };
}

export const noteSaveRequest = (base: NoteDraftBase, body: string) => ({ body, expectedHash: base.hash });
