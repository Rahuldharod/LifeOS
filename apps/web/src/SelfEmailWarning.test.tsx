import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelfEmailWarning } from "./SelfEmailWarning.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;

describe("SelfEmailWarning (#76)", () => {
  it("says in words that no address is set and offers a real button to the email card only", () => {
    const html = renderToStaticMarkup(<SelfEmailWarning warning={{ selfEmailsMissing: true, internalDomainsMissing: false }} onOpenSettings={noop} />);
    expect(text(html)).toContain("Your email addresses are not set");
    expect(text(html)).toContain("no calendar attendee is recognised as you");
    expect(text(html)).not.toContain("External");
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<button type="button"[^>]*>Set my email addresses in Settings<\/button>/);
    expect(html).not.toContain("internal domains in Settings");
  });

  it("adds that nobody is marked External, with a second button, when internal domains are unset too", () => {
    const html = renderToStaticMarkup(<SelfEmailWarning warning={{ selfEmailsMissing: true, internalDomainsMissing: true }} onOpenSettings={noop} />);
    expect(text(html)).toContain("nobody is marked External");
    expect(html).toContain(">Set my email addresses in Settings</button>");
    expect(html).toContain(">Set internal domains in Settings</button>");
  });

  it("warns that nobody is marked External when only internal domains are unset, linking to that card", () => {
    const html = renderToStaticMarkup(<SelfEmailWarning warning={{ selfEmailsMissing: false, internalDomainsMissing: true }} onOpenSettings={noop} />);
    expect(text(html)).toContain("Internal domains are not set");
    expect(text(html)).toContain("nobody is marked External");
    expect(text(html)).not.toContain("recognised as you");
    expect(html).toMatch(/<button type="button"[^>]*>Set internal domains in Settings<\/button>/);
    expect(html).not.toContain("Set my email addresses");
  });

  it("renders nothing once both settings are saved", () => {
    expect(renderToStaticMarkup(<SelfEmailWarning warning={undefined} onOpenSettings={noop} />)).toBe("");
  });
});
