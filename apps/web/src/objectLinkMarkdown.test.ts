import { describe, expect, it } from "vitest";
import { escapeLinkTitle, objectLinkMarkdown, pastedLinkMarkdown } from "./objectLinkMarkdown.js";

const id = "0190a1b2-0000-7000-8000-000000000001";
const object = (title: string, extra: Record<string, unknown> = {}) => ({ frontmatter: { id, type: "task", title, ...extra } });

describe("escapeLinkTitle", () => {
  it("leaves a plain title alone", () => expect(escapeLinkTitle("Pricing ideas")).toBe("Pricing ideas"));
  it("backslash-escapes backslash, brackets and pipe", () => expect(escapeLinkTitle("a\\b [c] d|e")).toBe("a\\\\b \\[c\\] d\\|e"));
});

describe("objectLinkMarkdown", () => {
  it("writes [Title](lifeos://object/<id>)", () => expect(objectLinkMarkdown(object("Pricing ideas"))).toBe(`[Pricing ideas](lifeos://object/${id})`));
  it("escapes the title", () => expect(objectLinkMarkdown(object("Q3 [draft]"))).toBe(`[Q3 \\[draft\\]](lifeos://object/${id})`));
});

describe("pastedLinkMarkdown", () => {
  const deletedId = "0190a1b2-0000-7000-8000-000000000002";
  const objects = [object("Pricing ideas"), { frontmatter: { id: deletedId, type: "knowledge-note", title: "Old", deleted_at: "2026-10-01T00:00:00Z" } }];
  it("turns a bare known address into a titled link", () => expect(pastedLinkMarkdown(`lifeos://object/${id}`, objects)).toBe(`[Pricing ideas](lifeos://object/${id})`));
  it("ignores surrounding whitespace", () => expect(pastedLinkMarkdown(`  lifeos://object/${id}\n`, objects)).toBe(`[Pricing ideas](lifeos://object/${id})`));
  it("converts deleted objects too", () => expect(pastedLinkMarkdown(`lifeos://object/${deletedId}`, objects)).toBe(`[Old](lifeos://object/${deletedId})`));
  it("leaves an unknown id as-is", () => expect(pastedLinkMarkdown("lifeos://object/0190a1b2-0000-7000-8000-0000000000ff", objects)).toBeUndefined());
  it("leaves longer text as-is", () => {
    expect(pastedLinkMarkdown(`see lifeos://object/${id}`, objects)).toBeUndefined();
    expect(pastedLinkMarkdown(`lifeos://object/${id} and more`, objects)).toBeUndefined();
    expect(pastedLinkMarkdown(`lifeos://object/${id}/extra`, objects)).toBeUndefined();
    expect(pastedLinkMarkdown(`lifeos://object/${id}\nlifeos://object/${id}`, objects)).toBeUndefined();
  });
  it("leaves other text as-is", () => expect(pastedLinkMarkdown("hello", objects)).toBeUndefined());
});
