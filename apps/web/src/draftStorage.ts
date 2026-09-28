// Browser-local persistence for an in-progress draft, keyed by object id. Shared by the Notes
// view and the Calendar meeting workspace so a draft survives a reload or crash for either editor.

export type CachedDraft = { body: string; baseHash: string; cachedAt: string };
export type DraftableId = { frontmatter: { id: string }; body: string };

const draftKey = (id: string) => `lifeos.draft.${id}`;

export function readCachedDraft(note: DraftableId): CachedDraft | undefined {
  try {
    const cached = JSON.parse(localStorage.getItem(draftKey(note.frontmatter.id)) ?? "null") as CachedDraft | null;
    return cached && typeof cached.body === "string" && cached.body !== note.body ? cached : undefined;
  } catch { return undefined; }
}

export function cacheDraft(id: string, body: string, baseHash: string) {
  try { localStorage.setItem(draftKey(id), JSON.stringify({ body, baseHash, cachedAt: new Date().toISOString() } satisfies CachedDraft)); }
  catch { /* Markdown autosave remains available if browser storage is full or disabled. */ }
}

export function clearCachedDraft(id: string) {
  try { localStorage.removeItem(draftKey(id)); } catch { /* ignored */ }
}
