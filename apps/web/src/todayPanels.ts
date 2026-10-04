// #48: helpers for Today's live panels. Summary panels show at most a handful of rows before
// "show more" (PRD accessibility NFR: 5–7 rows), so nobody faces a wall of items.

export const panelRowLimit = 6;

/** The rows to render, and how many are hidden behind "show more". */
export function visibleRows<T>(items: readonly T[], expanded: boolean, limit = panelRowLimit) {
  // Hiding a single row saves nothing: show it rather than a "Show 1 more" button.
  if (expanded || items.length <= limit + 1) return { rows: [...items], hidden: 0 };
  return { rows: items.slice(0, limit), hidden: items.length - limit };
}

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** "2 drafts and 1 patch awaiting adoption": patches are counted, but not called drafts. */
export function awaitingAdoptionLabel(inbox: { drafts?: number; patches?: number; awaiting: number }) {
  const drafts = inbox.drafts ?? inbox.awaiting, patches = inbox.patches ?? 0;
  if (!drafts && !patches) return "Nothing awaiting adoption";
  const parts = [drafts ? count(drafts, "draft", "drafts") : "", patches ? count(patches, "patch", "patches") : ""].filter(Boolean);
  return `${parts.join(" and ")} awaiting adoption`;
}

/** Whole days between a local due date and today's local date (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
