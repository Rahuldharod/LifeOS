import type { LifeObject } from "@lifeos/contracts";
import { foldText } from "./searchOptions.js";

export const recentSearchIdsKey = "lifeos.search.recentIds";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem">;

export type GlobalSearchItem = {
  id: string;
  kind: "Task" | "Note";
  title: string;
  body: string;
  updatedAt: string;
  recentIndex: number;
};

export type GlobalSearchGroups = { tasks: GlobalSearchItem[]; notes: GlobalSearchItem[] };

export function readRecentSearchIds(storage: StorageReader = localStorage): string[] {
  try {
    const value = JSON.parse(storage.getItem(recentSearchIdsKey) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(0, 40) : [];
  } catch { return []; }
}

export function recordRecentSearchId(id: string, storage: StorageWriter = localStorage) {
  try { storage.setItem(recentSearchIdsKey, JSON.stringify([id, ...readRecentSearchIds(storage).filter((item) => item !== id)].slice(0, 40))); }
  catch { /* Search still works when browser storage is unavailable. */ }
}

function eligible(objects: LifeObject[], kind: GlobalSearchItem["kind"]): GlobalSearchItem[] {
  return objects
    .filter((object) => !object.frontmatter.archived_at && !object.frontmatter.deleted_at)
    .map((object) => ({
      id: object.frontmatter.id,
      kind,
      title: object.frontmatter.title,
      body: object.body,
      updatedAt: object.frontmatter.updated_at,
      recentIndex: Number.POSITIVE_INFINITY
    }));
}

function rank(item: GlobalSearchItem, query: string) {
  const title = foldText(item.title);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  return 3;
}

function results(items: GlobalSearchItem[], query: string, recentIds: string[]) {
  if (!query) {
    const positions = new Map(recentIds.map((id, index) => [id, index]));
    return items
      .filter((item) => positions.has(item.id))
      .map((item) => ({ ...item, recentIndex: positions.get(item.id)! }))
      .sort((left, right) => left.recentIndex - right.recentIndex);
  }
  return items
    .filter((item) => foldText(item.title).includes(query) || foldText(item.body).includes(query))
    .sort((left, right) => rank(left, query) - rank(right, query)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.title.localeCompare(right.title));
}

export function globalSearchResults({ tasks, notes, query, recentIds }: { tasks: LifeObject[]; notes: LifeObject[]; query: string; recentIds: string[] }): GlobalSearchGroups {
  const folded = foldText(query.trim());
  return {
    tasks: results(eligible(tasks.filter((object) => object.frontmatter.type === "task"), "Task"), folded, recentIds),
    // Meeting Notes join Search with their Calendar metadata and recurrence rules in #152.
    notes: results(eligible(notes.filter((object) => object.frontmatter.type === "knowledge-note"), "Note"), folded, recentIds)
  };
}
