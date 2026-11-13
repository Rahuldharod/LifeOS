import { describe, expect, it } from "vitest";
import type { LifeObject, PersonLabel } from "@lifeos/contracts";
import { applyToEach, bulkApplies, defaultPeopleFilters, describeBulkResult, matchesPeopleFilters } from "./peopleBulkRules.js";

const person = (id: string, extra: Record<string, unknown> = {}): LifeObject => ({
  relativePath: `people/${id}.md`, contentHash: `${id}-hash`, body: "",
  frontmatter: { id, type: "person", schema_version: 1, revision: 1, title: id, created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:00Z", updated_by_device: "test", ...extra }
});
const label = (id: string, isExternal: boolean): PersonLabel => ({ id, name: id, label: id, isExternal, externalSource: "email" } as PersonLabel);

const ana = person("ana", { review_state: "unreviewed", origin: "calendar" });
const ben = person("ben", { review_state: "reviewed" });
const list = person("list", { not_a_person: true, archived_at: "2026-11-02T08:00:00Z" });
const me = person("me", { is_self: true });
const labels = new Map([label("ana", true), label("ben", false), label("list", true), label("me", false)].map((item) => [item.id, item]));
const shown = (filters: Partial<typeof defaultPeopleFilters>) => [ana, ben, list, me].filter((p) => matchesPeopleFilters(p, labels, { ...defaultPeopleFilters, ...filters })).map((p) => p.frontmatter.id);

describe("People filters (#230)", () => {
  it("hides Not a person People by default and lists them under the Type filter", () => {
    expect(shown({})).toEqual(["ana", "ben", "me"]);
    expect(shown({ kind: "not-a-person" })).toEqual(["list"]);
    expect(shown({ kind: "all" })).toEqual(["ana", "ben", "list", "me"]);
  });
  it("combines the filters with AND", () => {
    expect(shown({ review: "unreviewed" })).toEqual(["ana"]);
    expect(shown({ side: "external" })).toEqual(["ana"]);
    expect(shown({ side: "external", kind: "all" })).toEqual(["ana", "list"]);
    expect(shown({ side: "external", review: "reviewed" })).toEqual([]);
    expect(shown({ side: "internal", review: "reviewed" })).toEqual(["ben", "me"]);
  });
});

describe("People bulk actions (#230)", () => {
  it("never changes you and skips people already in the target state", () => {
    expect([ana, ben, list, me].filter((p) => bulkApplies("confirm", p)).map((p) => p.frontmatter.id)).toEqual(["ana"]);
    expect([ana, ben, list, me].filter((p) => bulkApplies("person", p)).map((p) => p.frontmatter.id)).toEqual(["list"]);
    expect([ana, ben, list, me].filter((p) => bulkApplies("not-a-person", p)).map((p) => p.frontmatter.id)).toEqual(["ana", "ben"]);
    expect([ana, ben, list, me].filter((p) => bulkApplies("archive", p)).map((p) => p.frontmatter.id)).toEqual(["ana", "ben"]);
    expect([ana, ben, list, me].filter((p) => bulkApplies("delete", p)).map((p) => p.frontmatter.id)).toEqual(["ana", "ben", "list"]);
    expect(bulkApplies("external", person("x", { is_external_override: true }))).toBe(false);
    expect(bulkApplies("internal", person("x", { is_external_override: true }))).toBe(true);
  });
  it("writes each person in turn, carries on after a failure, and names it", async () => {
    const written: string[] = [];
    const result = await applyToEach("archive", [ana, ben, list, me], async (p) => {
      if (p.frontmatter.id === "ben") throw new Error("Changed on another device");
      written.push(p.frontmatter.id);
    });
    expect(written).toEqual(["ana"]);
    expect(result).toEqual({ action: "archive", done: 1, skipped: 2, failed: [{ title: "ben", error: "Changed on another device" }] });
    expect(describeBulkResult(result)).toBe("1 person archived · 2 skipped (already done, or not allowed for you) · 1 failed");
  });
});
