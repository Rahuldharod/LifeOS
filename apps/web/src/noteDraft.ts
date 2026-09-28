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

/** True when a note has a cached browser draft that disagrees with the current disk copy —
 * drives the "Conflict" badge in the Notes list. A cached draft that simply hasn't autosaved
 * yet (base hash still matches disk) is not a conflict. */
export function isConflictedDraft(cached: CachedNoteDraft | undefined, note: DraftableNote): boolean {
  return cached !== undefined && cached.baseHash !== note.contentHash;
}

export type LineDiff = { kind: "same" | "added" | "removed"; text: string };

/**
 * Line-based diff (longest common subsequence) between the disk copy and the draft. Good enough
 * for the short Markdown notes LifeOS stores — word-level highlighting is out of scope (PB-002).
 * Used to show what changed before "Keep browser version" or "Keep disk version" discards the
 * other side.
 */
export function diffNoteLines(diskText: string, draftText: string): LineDiff[] {
  const a = diskText.split("\n");
  const b = draftText.split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    const row = table[i]; const nextRow = table[i + 1];
    if (!row || !nextRow) continue;
    row[j] = a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
  }
  const result: LineDiff[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] ?? ""; const right = b[j] ?? "";
    if (left === right) { result.push({ kind: "same", text: left }); i++; j++; }
    else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) { result.push({ kind: "removed", text: left }); i++; }
    else { result.push({ kind: "added", text: right }); j++; }
  }
  while (i < a.length) { result.push({ kind: "removed", text: a[i] ?? "" }); i++; }
  while (j < b.length) { result.push({ kind: "added", text: b[j] ?? "" }); j++; }
  return result;
}
