import { describe, expect, it } from "vitest";
import { insertAtSelection, transformLines, wrapSelection } from "./markdownEdit.js";

// The Markdown-mode text edits, as pure functions: draft + selection in, new draft + selection out.
describe("wrapSelection", () => {
  it("wraps the selected text and keeps it selected", () => {
    expect(wrapSelection("say hello now", { start: 4, end: 9 }, "**", "**", "text")).toEqual({ draft: "say **hello** now", select: { start: 6, end: 11 } });
  });
  it("uses the placeholder when nothing is selected", () => {
    expect(wrapSelection("ab", { start: 1, end: 1 }, "[", "](https://)", "link text")).toEqual({ draft: "a[link text](https://)b", select: { start: 2, end: 11 } });
  });
});

describe("insertAtSelection", () => {
  it("replaces the selection and puts the caret where asked", () => {
    expect(insertAtSelection("abcdef", { start: 2, end: 4 }, "XY")).toEqual({ draft: "abXYef", select: { start: 2, end: 2 } });
    expect(insertAtSelection("abcdef", { start: 2, end: 4 }, "XY", 2)).toEqual({ draft: "abXYef", select: { start: 4, end: 4 } });
  });
});

describe("transformLines", () => {
  const bullet = (line: string) => `- ${line.replace(/^[-*+]\s+/, "")}`;
  it("transforms every line the selection touches, whole lines only", () => {
    expect(transformLines("one\ntwo\nthree", { start: 5, end: 9 }, bullet, "List item")).toEqual({ draft: "one\n- two\n- three", select: { start: 4, end: 17 } });
  });
  it("numbers lines by index", () => {
    expect(transformLines("a\nb", { start: 0, end: 3 }, (line, index) => `${index + 1}. ${line}`, "x").draft).toBe("1. a\n2. b");
  });
  it("uses the placeholder on an empty line", () => {
    expect(transformLines("", { start: 0, end: 0 }, bullet, "List item").draft).toBe("- List item");
  });
});
