import { describe, expect, it } from "vitest";
import { diffNoteLines, isConflictedDraft } from "./noteDraft.js";

describe("diffNoteLines", () => {
  it("marks everything as same for identical text", () => {
    expect(diffNoteLines("a\nb\nc", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" }, { kind: "same", text: "b" }, { kind: "same", text: "c" }
    ]);
  });

  it("marks a pure addition", () => {
    expect(diffNoteLines("a\nb", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" }, { kind: "same", text: "b" }, { kind: "added", text: "c" }
    ]);
  });

  it("marks a pure removal", () => {
    expect(diffNoteLines("a\nb\nc", "a\nb")).toEqual([
      { kind: "same", text: "a" }, { kind: "same", text: "b" }, { kind: "removed", text: "c" }
    ]);
  });

  it("marks a mixed edit as a removal followed by an addition", () => {
    expect(diffNoteLines("a\nb\nc", "a\nx\nc")).toEqual([
      { kind: "same", text: "a" }, { kind: "removed", text: "b" }, { kind: "added", text: "x" }, { kind: "same", text: "c" }
    ]);
  });

  it("handles empty input on either side", () => {
    // "".split("\n") is [""], i.e. one blank line, not zero lines — so an empty side still
    // contributes a (removed/added) blank line of its own, not a bare "same" line.
    expect(diffNoteLines("", "a")).toEqual([{ kind: "removed", text: "" }, { kind: "added", text: "a" }]);
    expect(diffNoteLines("a", "")).toEqual([{ kind: "removed", text: "a" }, { kind: "added", text: "" }]);
    expect(diffNoteLines("", "")).toEqual([{ kind: "same", text: "" }]);
  });

  it("treats a trailing newline as its own (empty) line", () => {
    expect(diffNoteLines("a\n", "a")).toEqual([{ kind: "same", text: "a" }, { kind: "removed", text: "" }]);
  });
});

describe("isConflictedDraft", () => {
  const note = { frontmatter: { id: "n1" }, body: "current body", contentHash: "hash-2" };

  it("is false when there is no cached draft", () => {
    expect(isConflictedDraft(undefined, note)).toBe(false);
  });

  it("is false when the cached draft's base hash still matches disk (ordinary unsaved edit)", () => {
    expect(isConflictedDraft({ body: "edited", baseHash: "hash-2" }, note)).toBe(false);
  });

  it("is true when the cached draft's base hash no longer matches disk", () => {
    expect(isConflictedDraft({ body: "edited", baseHash: "hash-1" }, note)).toBe(true);
  });
});
