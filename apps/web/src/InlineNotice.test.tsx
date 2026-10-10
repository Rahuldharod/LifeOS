import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InlineNotice } from "./InlineNotice.js";

describe("InlineNotice (#97)", () => {
  it("leads with the problem in bold words, then the explanation", () => {
    const html = renderToStaticMarkup(<InlineNotice className="unproven-formatting" role="note" title="Unproven formatting">Use Markdown mode.</InlineNotice>);
    expect(html).toBe('<p class="unproven-formatting" role="note"><b>Unproven formatting</b> Use Markdown mode.</p>');
  });

  it("can be a block, for notices that hold a Retry button", () => {
    const html = renderToStaticMarkup(<InlineNotice as="div" className="calendar-offline" role="status" title="Offline"><small>Not reachable.</small><button type="button">Retry</button></InlineNotice>);
    expect(html).toBe('<div class="calendar-offline" role="status"><b>Offline</b> <small>Not reachable.</small><button type="button">Retry</button></div>');
  });
});
