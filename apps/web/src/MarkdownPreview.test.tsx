import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview.js";

describe("MarkdownPreview", () => {
  it("keeps lifeos:// links so they can be clicked (PB-007)", () => {
    expect(renderToStaticMarkup(<MarkdownPreview markdown="[Plan](lifeos://object/0a1b2c3d-0000-4000-8000-000000000001)" empty="-" />)).toContain('href="lifeos://object/0a1b2c3d-0000-4000-8000-000000000001"');
  });
  it("serves a managed image through the assets endpoint and never drops it", () => {
    expect(renderToStaticMarkup(<MarkdownPreview markdown="![Board](../assets/board.png)" empty="-" />)).toContain('src="/api/v1/assets/board.png"');
  });
  it("leaves external images alone", () => {
    expect(renderToStaticMarkup(<MarkdownPreview markdown="![x](https://example.com/x.png)" empty="-" />)).toContain('src="https://example.com/x.png"');
  });
  it("shows the empty text for a blank note, with no stray <br />", () => {
    const html = renderToStaticMarkup(<MarkdownPreview markdown="" empty="Nothing to preview yet." />);
    expect(html).toContain("Nothing to preview yet.");
    expect(html).not.toContain("<br");
  });
});
