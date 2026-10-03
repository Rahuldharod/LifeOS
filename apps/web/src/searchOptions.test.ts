import { describe, expect, it } from "vitest";
import { searchOptions } from "./searchOptions.js";

const people = [{ id: "1", title: "Ada Lovelace" }, { id: "2", title: "John Smith" }, { id: "3", title: "Johanna Berg" }, { id: "4", title: "Mary Johnson" }, { id: "5", title: "José Álvarez" }];

describe("searchOptions", () => {
  it("shortlists by a few typed letters, word-start matches first", () => {
    expect(searchOptions(people, "joh").map((option) => option.title)).toEqual(["Johanna Berg", "John Smith", "Mary Johnson"]);
  });
  it("ignores case and accents in both directions", () => {
    expect(searchOptions(people, "JOSE").map((option) => option.id)).toEqual(["5"]);
    expect(searchOptions(people, "alvarez").map((option) => option.id)).toEqual(["5"]);
  });
  it("requires every word, in any order", () => {
    expect(searchOptions(people, "smith jo").map((option) => option.id)).toEqual(["2"]);
  });
  it("returns everything for a blank query and drops excluded ids", () => {
    expect(searchOptions(people, "  ")).toHaveLength(5);
    expect(searchOptions(people, "", ["1", "2"]).map((option) => option.id)).toEqual(["3", "5", "4"]);
  });
});
