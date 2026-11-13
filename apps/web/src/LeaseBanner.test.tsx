import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeaseBanner, takeoverCaution } from "./LeaseBanner.js";
import { activityIntervalMs, shouldSendActivity } from "./activityHeartbeat.js";

// ADR 0024: the read-only banner while the other Mac holds the lease, and when the browser reports activity.

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const foreign = { currentDeviceId: "desk-mac", activeDeviceId: "laptop", writeAllowed: false };

describe("LeaseBanner", () => {
  it("while the other Mac holds the lease, names it and offers Use LifeOS here with the caution", () => {
    const html = renderToStaticMarkup(<LeaseBanner session={foreign} busy={false} onTakeOver={noop} />);
    expect(text(html)).toContain("LifeOS is in use on laptop");
    expect(text(html)).toContain(takeoverCaution);
    expect(html).toMatch(/<button type="button" class="takeover">Use LifeOS here<\/button>/);
  });

  it("renders nothing while this Mac can write", () => {
    expect(renderToStaticMarkup(<LeaseBanner session={{ ...foreign, writeAllowed: true }} busy={false} onTakeOver={noop} />)).toBe("");
    expect(renderToStaticMarkup(<LeaseBanner session={undefined} busy={false} onTakeOver={noop} />)).toBe("");
  });

  it("disables Use LifeOS here while busy", () => {
    expect(renderToStaticMarkup(<LeaseBanner session={foreign} busy onTakeOver={noop} />)).toMatch(/<button type="button" class="takeover" disabled="">Use LifeOS here<\/button>/);
  });
});

describe("shouldSendActivity", () => {
  const now = 1_000_000;
  it("sends on the first input in a visible, focused tab", () => {
    expect(shouldSendActivity({ visible: true, focused: true, now })).toBe(true);
  });
  it("never sends from a hidden or unfocused tab", () => {
    expect(shouldSendActivity({ visible: false, focused: true, now })).toBe(false);
    expect(shouldSendActivity({ visible: true, focused: false, now })).toBe(false);
  });
  it("sends at most once a minute", () => {
    expect(shouldSendActivity({ visible: true, focused: true, lastSentAt: now - activityIntervalMs + 1, now })).toBe(false);
    expect(shouldSendActivity({ visible: true, focused: true, lastSentAt: now - activityIntervalMs, now })).toBe(true);
  });
});
