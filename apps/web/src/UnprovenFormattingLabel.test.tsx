import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnprovenFormattingLabel } from "./UnprovenFormattingLabel.js";
import { roundTripReport, uncoveredFormatting } from "./editorMarkdown.js";

describe("UnprovenFormattingLabel (#89)", () => {
  it("shows 'Unproven formatting' as text, naming what the editor may rewrite", () => {
    const html = renderToStaticMarkup(<UnprovenFormattingLabel report={roundTripReport("- one\n", "* one\n")} />);
    expect(html).toContain('role="note"');
    expect(html).toContain("Unproven formatting");
    expect(html).toContain("bullets written with - or +");
    expect(html).toContain("Markdown mode");
  });

  it("renders nothing when the note round-trips byte-for-byte", () => {
    expect(renderToStaticMarkup(<UnprovenFormattingLabel report={roundTripReport("* one\n", "* one\n")} />)).toBe("");
  });

  it("renders nothing before the editor has checked the note", () => {
    expect(renderToStaticMarkup(<UnprovenFormattingLabel report={undefined} />)).toBe("");
  });

  it("still labels a note whose change no known construct explains", () => {
    const html = renderToStaticMarkup(<UnprovenFormattingLabel report={roundTripReport("* one\n", "* two\n")} />);
    expect(html).toContain("Unproven formatting");
    expect(html).toContain(uncoveredFormatting);
  });
});
