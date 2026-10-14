import { describe, expect, it } from "vitest";
import { appVersion } from "./app-version.js";

// Main's first-parent history, newest first, as git log prints it.
const main = [
  { commit: "c3c3c3c3c3c3", committedAt: "2026-10-14T16:00:00+02:00" },
  { commit: "b2b2b2b2b2b2", committedAt: "2026-10-14T11:00:00+02:00" },
  { commit: "a1a1a1a1a1a1", committedAt: "2026-10-14T09:00:00+02:00" },
  { commit: "9f9f9f9f9f9f", committedAt: "2026-10-13T18:00:00+02:00" }
];

describe("App version", () => {
  it("numbers a merge by its place in the Paris day", () => {
    expect(appVersion(main, "c3c3c3c3c3c3")).toBe("26.10.14.3");
  });

  it("shows .1 on a day's first merge", () => {
    expect(appVersion(main.slice(2), "a1a1a1a1a1a1")).toBe("26.10.14.1");
  });

  it("counts a merge at 23:30 UTC on the next Paris day", () => {
    const late = [{ commit: "d4d4d4d4d4d4", committedAt: "2026-10-14T23:30:00Z" }, ...main];
    expect(appVersion(late, "d4d4d4d4d4d4")).toBe("26.10.15.1");
  });

  it("uses the Paris day on the night the clocks go back", () => {
    // 25 Oct 2026: 00:30 UTC is 02:30 Paris summer time; 23:30 UTC that evening is 00:30 on the 26th (winter time).
    const history = [
      { commit: "f6f6f6f6f6f6", committedAt: "2026-10-25T23:30:00Z" },
      { commit: "e5e5e5e5e5e5", committedAt: "2026-10-25T00:30:00Z" },
      { commit: "e4e4e4e4e4e4", committedAt: "2026-10-24T22:30:00Z" }
    ];
    expect(appVersion(history, "f6f6f6f6f6f6")).toBe("26.10.26.1");
    expect(appVersion(history.slice(1), "e5e5e5e5e5e5")).toBe("26.10.25.2");
  });

  it("pads month and day so versions sort as text", () => {
    expect(appVersion([{ commit: "a0a0a0a0a0a0", committedAt: "2027-01-05T10:00:00+01:00" }], "a0a0a0a0a0a0")).toBe("27.01.05.1");
  });

  it("marks a build that is not the main merge with -dev and its short commit", () => {
    expect(appVersion(main, "abc1234def5678")).toBe("26.10.14.3-dev+abc1234");
  });

  it("marks a dev runtime build of a main merge", () => {
    expect(appVersion(main, "c3c3c3c3c3c3", { dev: true })).toBe("26.10.14.3-dev+c3c3c3c");
  });

  it("is unknown without main's history", () => {
    expect(appVersion([], "abc1234")).toBe("unknown");
  });
});
