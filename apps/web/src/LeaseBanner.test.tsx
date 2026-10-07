import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeaseBanner, takeoverCaution } from "./LeaseBanner.js";
import { activityIntervalMs, shouldSendActivity } from "./activityHeartbeat.js";

// ADR 0015: the read-only banner after an idle release, and when the browser reports activity.

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;
const released = { currentDeviceId: "desk-mac", activeDeviceId: "desk-mac", writeAllowed: false, releasedAfterIdle: true };

describe("LeaseBanner", () => {
  it("after an idle release, says editing is paused and offers Take back, without the takeover caution", () => {
    const html = renderToStaticMarkup(<LeaseBanner session={released} idleMinutes={15} busy={false} onTakeBack={noop} />);
    expect(text(html)).toContain("Editing is paused on this Mac");
    expect(text(html)).toContain("after 15 minutes without activity");
    expect(text(html)).toContain("will not take it back by itself");
    expect(text(html)).not.toContain(takeoverCaution);
    expect(html).toMatch(/<button type="button" class="takeover">Take back<\/button>/);
  });

  it("when the other Mac has taken the lease, shows the takeover caution", () => {
    const html = renderToStaticMarkup(<LeaseBanner session={{ ...released, activeDeviceId: "laptop" }} idleMinutes={15} busy={false} onTakeBack={noop} />);
    expect(text(html)).toContain("laptop is now editing");
    expect(text(html)).toContain(takeoverCaution);
    expect(text(html)).toContain("Take back");
  });

  it("renders nothing while this Mac can write, or when read-only for another reason", () => {
    expect(renderToStaticMarkup(<LeaseBanner session={{ ...released, writeAllowed: true, releasedAfterIdle: false }} busy={false} onTakeBack={noop} />)).toBe("");
    expect(renderToStaticMarkup(<LeaseBanner session={{ ...released, activeDeviceId: "laptop", releasedAfterIdle: false }} busy={false} onTakeBack={noop} />)).toBe("");
    expect(renderToStaticMarkup(<LeaseBanner session={undefined} busy={false} onTakeBack={noop} />)).toBe("");
  });

  it("disables Take back while busy", () => {
    expect(renderToStaticMarkup(<LeaseBanner session={released} busy onTakeBack={noop} />)).toMatch(/<button type="button" class="takeover" disabled="">Take back<\/button>/);
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
