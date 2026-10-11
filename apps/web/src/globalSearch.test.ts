import { describe, expect, it } from "vitest";
import type { LifeObject } from "@lifeos/contracts";
import { globalSearchResults, readRecentSearchIds, recordRecentSearchId } from "./globalSearch.js";

const object = (id: string, type: string, title: string, body: string, updatedAt: string, extra: Record<string, unknown> = {}): LifeObject => ({
  frontmatter: { id, type, title, revision: 1, created_at: updatedAt, updated_at: updatedAt, ...extra },
  body,
  relativePath: `${type}s/${id}.md`,
  contentHash: id
});

describe("Global Search (#146)", () => {
  const tasks = [
    object("task-title", "task", "Prepare café", "Nothing here", "2026-10-01T09:00:00Z"),
    object("task-body", "task", "Other task", "Prepare cafe plan in the body", "2026-10-03T09:00:00Z"),
    object("task-newer", "task", "Prepare cafe plan later", "", "2026-10-02T09:00:00Z"),
    object("task-archived", "task", "Prepare cafe archive", "", "2026-10-04T09:00:00Z", { archived_at: "2026-10-04T10:00:00Z" })
  ];
  const notes = [
    object("note-restricted", "knowledge-note", "Café research", "Private plan", "2026-10-02T09:00:00Z", { sensitivity: "restricted" }),
    object("meeting", "meeting-note", "Café meeting", "", "2026-10-03T09:00:00Z"),
    object("note-deleted", "knowledge-note", "Café deleted", "", "2026-10-04T09:00:00Z", { deleted_at: "2026-10-04T10:00:00Z" })
  ];

  it("matches case and accents, ranks title before body, includes restricted, and excludes non-live or meeting notes", () => {
    const result = globalSearchResults({ tasks, notes, query: "PREPARE CAFE", recentIds: [] });
    expect(result.tasks.map((item) => item.id)).toEqual(["task-title", "task-newer", "task-body"]);
    expect(globalSearchResults({ tasks, notes, query: "cafe", recentIds: [] }).notes.map((item) => item.id)).toEqual(["note-restricted"]);
  });

  it("uses device-local recent identifier order before typing and drops ineligible identifiers", () => {
    const result = globalSearchResults({ tasks, notes, query: "", recentIds: ["note-restricted", "task-archived", "task-title"] });
    expect([...result.tasks, ...result.notes].sort((a, b) => a.recentIndex - b.recentIndex).map((item) => item.id)).toEqual(["note-restricted", "task-title"]);
  });

  it("stores only deduplicated record identifiers, never queries", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    recordRecentSearchId("a", storage); recordRecentSearchId("b", storage); recordRecentSearchId("a", storage);
    expect(readRecentSearchIds(storage)).toEqual(["a", "b"]);
    expect([...values.values()].join(" ")).not.toContain("secret query");
  });
});
