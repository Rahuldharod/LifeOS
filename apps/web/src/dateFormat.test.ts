import { afterEach, describe, expect, it, vi } from "vitest";
import { displayTimeZone, formatTime } from "./dateFormat.js";

// #75: one display-timezone lookup for the web app.

function stubStorage(zone: string | null) {
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "lifeos.displayTimeZone" ? zone : null });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("display time zone", () => {
  it("is the zone chosen on this device", () => {
    stubStorage("Asia/Tokyo");
    expect(displayTimeZone()).toBe("Asia/Tokyo");
  });

  it("falls back to the runtime's own zone when none is chosen", () => {
    stubStorage(null);
    expect(displayTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("is the zone the formatters use", () => {
    stubStorage("Asia/Tokyo");
    expect(formatTime("2026-01-01T00:00:00.000Z")).toBe(new Date("2026-01-01T00:00:00.000Z").toLocaleTimeString([], { timeStyle: "short", timeZone: "Asia/Tokyo" }));
  });
});
