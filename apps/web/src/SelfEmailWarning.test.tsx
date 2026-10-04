import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelfEmailWarning } from "./SelfEmailWarning.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("SelfEmailWarning (#76)", () => {
  it("says in words that no address is set and offers a real button to the Settings card", () => {
    const html = renderToStaticMarkup(<SelfEmailWarning warning={{ selfEmailsMissing: true, internalDomainsMissing: false }} onOpenSettings={() => undefined} />);
    expect(text(html)).toContain("Your email addresses are not set");
    expect(text(html)).toContain("no calendar attendee is recognised as you");
    expect(text(html)).not.toContain("External");
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<button type="button"[^>]*>Set my email addresses in Settings<\/button>/);
  });

  it("adds that nobody is marked External when internal domains are unset too", () => {
    const html = renderToStaticMarkup(<SelfEmailWarning warning={{ selfEmailsMissing: true, internalDomainsMissing: true }} onOpenSettings={() => undefined} />);
    expect(text(html)).toContain("nobody is marked External");
  });

  it("renders nothing once the setting is saved", () => {
    expect(renderToStaticMarkup(<SelfEmailWarning warning={undefined} onOpenSettings={() => undefined} />)).toBe("");
  });
});
