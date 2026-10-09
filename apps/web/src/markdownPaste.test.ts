import { describe, expect, it } from "vitest";
import { markdownPasteAction } from "./markdownPaste.js";

const id = "0190a1b2-0000-7000-8000-000000000001";
const objects = [{ frontmatter: { id, title: "Pricing ideas" } }];
const clipboard = (text: string, files: Array<{ type: string }> = []) => ({ files: files as unknown as File[], getData: () => text });

describe("markdownPasteAction (PB-029)", () => {
  it("turns a bare known address into a titled link", () => {
    expect(markdownPasteAction(clipboard(`lifeos://object/${id}`), objects)).toEqual({ kind: "link", markdown: `[Pricing ideas](lifeos://object/${id})` });
  });
  it("still uploads a pasted image", () => {
    const png = { type: "image/png" };
    expect(markdownPasteAction(clipboard("", [png]), objects)).toEqual({ kind: "image", file: png });
  });
  it("prefers the image when both are on the clipboard", () => {
    expect(markdownPasteAction(clipboard(`lifeos://object/${id}`, [{ type: "image/png" }]), objects)?.kind).toBe("image");
  });
  it("leaves unknown addresses, longer text and non-image files alone", () => {
    expect(markdownPasteAction(clipboard("lifeos://object/0190a1b2-0000-7000-8000-0000000000ff"), objects)).toBeUndefined();
    expect(markdownPasteAction(clipboard(`see lifeos://object/${id}`), objects)).toBeUndefined();
    expect(markdownPasteAction(clipboard("text", [{ type: "application/pdf" }]), objects)).toBeUndefined();
  });
});
