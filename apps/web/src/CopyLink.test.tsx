import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyLink, copyObjectLink } from "./CopyLink.js";

const object = { frontmatter: { id: "0190a1b2-0000-7000-8000-000000000001", title: "Q3 [draft]" } };

describe("CopyLink (PB-029)", () => {
  it("renders an enabled Copy link button", () => {
    const html = renderToStaticMarkup(<CopyLink object={object} />);
    expect(html).toMatch(/<button type="button"[^>]*>Copy link<\/button>/);
    expect(html).not.toContain("disabled");
  });

  it("is disabled for an object with no id yet", () => {
    expect(renderToStaticMarkup(<CopyLink object={undefined} />)).toMatch(/<button type="button"[^>]*disabled=""[^>]*>Copy link<\/button>/);
  });

  it("can be disabled by the caller", () => {
    expect(renderToStaticMarkup(<CopyLink object={object} disabled />)).toContain('disabled=""');
  });
});

describe("copyObjectLink", () => {
  it("writes the escaped Markdown link as plain text and reports copied", async () => {
    const written: string[] = [];
    expect(await copyObjectLink(object, async (text) => { written.push(text); })).toBe("copied");
    expect(written).toEqual(["[Q3 \\[draft\\]](lifeos://object/0190a1b2-0000-7000-8000-000000000001)"]);
  });

  it("reports failed when the clipboard write is rejected", async () => {
    expect(await copyObjectLink(object, async () => { throw new Error("denied"); })).toBe("failed");
  });

  it("reports failed when there is no clipboard", async () => {
    expect(await copyObjectLink(object, undefined)).toBe("failed");
  });
});
