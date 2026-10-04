import { describe, expect, it } from "vitest";
import type { LifeOSObject } from "@lifeos/domain";
import { followMergesInCandidates, followMergesInProposal, survivingPersonId } from "./person-merge.js";

// #65: pending Review Items follow merges at accept time.

const index = (...objects: Array<Record<string, unknown>>) => {
  const byId = new Map(objects.map((frontmatter) => [String(frontmatter.id), { frontmatter, body: "" } as unknown as LifeOSObject]));
  return { get: (id: string) => byId.get(id) };
};
const people = index(
  { id: "b", type: "person", title: "Marie C.", merged_into_person_id: "c", deleted_at: "2026-10-01T00:00:00Z" },
  { id: "c", type: "person", title: "Marie", merged_into_person_id: "a", deleted_at: "2026-10-02T00:00:00Z" },
  { id: "a", type: "person", title: "Marie Curie" },
  { id: "x", type: "person", title: "Loop 1", merged_into_person_id: "y" },
  { id: "y", type: "person", title: "Loop 2", merged_into_person_id: "x" },
  { id: "t", type: "task", title: "Not a person", merged_into_person_id: "a" }
);

describe("survivingPersonId (#65)", () => {
  it("follows a chain of merges to the surviving person", () => {
    expect(survivingPersonId(people, "b")).toBe("a");
    expect(survivingPersonId(people, "c")).toBe("a");
    expect(survivingPersonId(people, "a")).toBe("a");
  });
  it("returns unknown IDs and non-people unchanged, and stops on a hand-edited loop", () => {
    expect(survivingPersonId(people, "missing")).toBe("missing");
    expect(survivingPersonId(people, "t")).toBe("t");
    expect(["x", "y"]).toContain(survivingPersonId(people, "x"));
  });
});

describe("followMergesInProposal / followMergesInCandidates (#65)", () => {
  it("moves person fields to the survivor and drops the repeats this makes, leaving other fields alone", () => {
    const proposed = { title: "Call Marie", owner_person_id: "b", waiting_for_person_id: "c", people_ids: ["a", "b", "c"], area: "work" };
    expect(followMergesInProposal(people, proposed)).toEqual({ title: "Call Marie", owner_person_id: "a", waiting_for_person_id: "a", people_ids: ["a"], area: "work" });
    expect(proposed.owner_person_id).toBe("b");
  });
  it("lists a merged pair of candidates once, under the survivor's current title", () => {
    expect(followMergesInCandidates(people, [{ id: "b", title: "Marie C." }, { id: "a", title: "Marie Curie" }])).toEqual([{ id: "a", title: "Marie Curie" }]);
  });
});
